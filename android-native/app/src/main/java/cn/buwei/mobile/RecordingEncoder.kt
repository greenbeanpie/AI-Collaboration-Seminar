package cn.buwei.mobile

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.*
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One encoder lifetime, multiple independent muxers. Rotation starts with an AVC keyframe. */
class RecordingEncoder(private val context: Context, private val store: RecordingStore, private val args: org.json.JSONObject) {
    @Volatile var action = "recording"
    @Volatile var devices: org.json.JSONObject? = null
    @Volatile private var cameraError: String? = null
    private val cameraThread = HandlerThread("recording-camera").apply { start() }
    private val handler = Handler(cameraThread.looper)
    private var camera: CameraDevice? = null
    private var capture: CameraCaptureSession? = null
    private var reader: ImageReader? = null
    private var surface: Surface? = null
    private var audio: AudioRecord? = null
    private var aac: MediaCodec? = null
    private var avc: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var partial: File? = null
    private var audioFormat: MediaFormat? = null
    private var videoFormat: MediaFormat? = null
    private var audioTrack = -1
    private var videoTrack = -1
    private var segmentStartUs = 0L
    private var lastUs = 0L
    private var written = 0L
    private var rotateRequested = false
    private var pauseAt: Long? = null
    private var cameraTimelineOffsetUs: Long? = null
    private var lastVideoReceiptUs = 0L
    private var cameraClockRealtime = false
    private val originUs = SystemClock.elapsedRealtimeNanos() / 1000
    private val video = args.getString("kind") == "video"
    private val timeline = MediaTimelineBuffer<Sample>(video)
    private data class Sample(val video: Boolean, val bytes: ByteArray, val pts: Long, val flags: Int)

    private fun nowUs() = SystemClock.elapsedRealtimeNanos() / 1000 - originUs
    private fun ensureSpace() { require(android.os.StatFs(store.directory.path).availableBytes > 64L * 1024 * 1024) { "存储空间不足，已保存片段保留" } }

    @SuppressLint("MissingPermission")
    fun run() {
        try {
            ensureSpace()
            if (args.getString("kind") == "photo") { photograph(); return }
            val audioFormatIn = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 48000, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 96000)
            }
            aac = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).also { it.configure(audioFormatIn, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); it.start() }
            val minimum = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            require(minimum > 0) { "设备不支持录音格式" }
            audio = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum * 2, 16384)).build().also { record ->
                    require(record.state == AudioRecord.STATE_INITIALIZED) { "麦克风初始化失败" }
                    val deviceId = args.optString("inputDeviceId")
                    if (deviceId.isNotBlank()) {
                        val devices = (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).getDevices(AudioManager.GET_DEVICES_INPUTS)
                        val device = devices.firstOrNull { it.id.toString() == deviceId } ?: error("所选麦克风不可用")
                        require(record.setPreferredDevice(device)) { "无法使用所选麦克风" }
                    }
                    record.startRecording()
                }
            if (video) {
                val size = cameraSize()
                val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, size.width, size.height).apply {
                    setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                    setInteger(MediaFormat.KEY_BIT_RATE, 1_000_000)
                    setInteger(MediaFormat.KEY_FRAME_RATE, 30)
                    setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                    if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
                }
                avc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).also {
                    it.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                    surface = it.createInputSurface(); it.start()
                }
                openCamera(surface!!, CameraDevice.TEMPLATE_RECORD)
            }
            val pcm = ByteArray(4096)
            var lastSave = 0L
            while (action != "stop") {
                cameraError?.let { error(it) }
                val elapsed = nowUs()
                if (elapsed - lastSave >= 1_000_000) {
                    ensureSpace()
                    if (android.os.Build.VERSION.SDK_INT >= 29 && action != "paused") require(audio?.activeRecordingConfiguration?.isClientSilenced != true) { "系统已静音或撤销麦克风采集" }
                    store.state(if (action == "paused") "paused" else "recording", elapsed / 1000); lastSave = elapsed
                }
                if (action == "paused") {
                    if (pauseAt == null) {
                        pauseAt = elapsed
                        audio!!.stop(); capture?.stopRepeating()
                        // Drain in-flight capture after stopping producers, then flush ordered
                        // samples before finalizing this independent file.
                        repeat(10) { drain(aac!!, false); avc?.let { drain(it, true) }; Thread.sleep(10) }
                        flushPending(true)
                        finishSegment()
                    }
                    Thread.sleep(20); continue
                } else if (pauseAt != null) {
                    devices?.let { selected ->
                        val inputId = selected.optString("inputDeviceId")
                        if (selected.has("inputDeviceId")) {
                            val available = (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).getDevices(AudioManager.GET_DEVICES_INPUTS)
                            val device = if (inputId.isBlank()) null else available.firstOrNull { it.id.toString() == inputId } ?: error("所选麦克风不可用")
                            require(audio!!.setPreferredDevice(device)) { "无法切换麦克风" }
                            args.put("inputDeviceId", inputId)
                        }
                        val cameraId = selected.optString("cameraDeviceId")
                        if (video && selected.has("cameraDeviceId") && cameraId != args.optString("cameraDeviceId")) {
                            capture?.close(); camera?.close(); capture = null; camera = null
                            args.put("cameraDeviceId", cameraId)
                            cameraTimelineOffsetUs = null
                            openCamera(surface!!, CameraDevice.TEMPLATE_RECORD)
                        }
                        devices = null
                    }
                    store.interruption(pauseAt!! / 1000, elapsed / 1000, "用户暂停")
                    pauseAt = null; audio!!.startRecording()
                    lastVideoReceiptUs = elapsed
                    capture?.setRepeatingRequest(camera!!.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply { addTarget(surface!!) }.build(), null, handler)
                    requestKeyframe()
                }
                val index = aac!!.dequeueInputBuffer(1000)
                if (index >= 0) {
                    val input = aac!!.getInputBuffer(index)!!
                    val n = audio!!.read(pcm, 0, minOf(pcm.size, input.capacity()), AudioRecord.READ_NON_BLOCKING)
                    require(n >= 0) { "麦克风读取失败或被系统撤销" }
                    if (n > 0) { input.put(pcm, 0, n); aac!!.queueInputBuffer(index, 0, n, nowUs(), 0) }
                    else aac!!.queueInputBuffer(index, 0, 0, nowUs(), 0)
                }
                drain(aac!!, false); avc?.let { drain(it, true) }
                if (video && elapsed - lastVideoReceiptUs > 15_000_000) error("摄像头未继续输出画面，录制已中断")
                if (muxer != null && (lastUs - segmentStartUs >= 295_000_000 || written >= 30L * 1024 * 1024) && !rotateRequested) { rotateRequested = true; requestKeyframe() }
                if (muxer != null && (lastUs - segmentStartUs > 300_000_000 || written > 32L * 1024 * 1024 - 65536)) error("编码器未及时提供分段关键帧，录制已停止并保全文件")
            }
            audio?.stop(); capture?.stopRepeating()
            val i = aac!!.dequeueInputBuffer(10000)
            if (i >= 0) aac!!.queueInputBuffer(i, 0, 0, nowUs(), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            avc?.signalEndOfInputStream()
            repeat(30) { drain(aac!!, false); avc?.let { drain(it, true) }; Thread.sleep(10) }
            flushPending(true)
            finishSegment()
            pauseAt?.let { store.interruption(it / 1000, nowUs() / 1000, "用户暂停") }
            store.state("stopped", nowUs() / 1000)
        } catch (e: Exception) {
            // A valid completed muxer is preserved even when the next device/storage operation fails.
            runCatching { flushPending(true) }
            runCatching { finishSegment() }
            runCatching { store.state("interrupted", nowUs() / 1000, e.message ?: "设备采集失败") }
        } finally { close() }
    }

    private fun requestKeyframe() { avc?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }

    private fun drain(codec: MediaCodec, isVideo: Boolean) {
        val info = MediaCodec.BufferInfo()
        while (true) {
            val index = codec.dequeueOutputBuffer(info, 0)
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                if (isVideo) videoFormat = codec.outputFormat else audioFormat = codec.outputFormat
                continue
            }
            if (index < 0) return
            try {
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val buffer = codec.getOutputBuffer(index)!!; buffer.position(info.offset); buffer.limit(info.offset + info.size)
                    val bytes = ByteArray(info.size); buffer.get(bytes)
                    // REALTIME camera clocks share elapsedRealtime; UNKNOWN clocks require one
                    // fixed alignment at first encoder output. The partial wake lock prevents
                    // uptime-vs-boottime divergence while recording. Device A/V timing needs
                    // real-device acceptance; the unknown clock alignment includes encode latency.
                    val pts = if (isVideo) {
                        lastVideoReceiptUs = nowUs()
                        if (cameraClockRealtime) info.presentationTimeUs - originUs else {
                            if (cameraTimelineOffsetUs == null) cameraTimelineOffsetUs = lastVideoReceiptUs - info.presentationTimeUs
                            info.presentationTimeUs + cameraTimelineOffsetUs!!
                        }
                    } else info.presentationTimeUs
                    if (pts >= 0) sample(Sample(isVideo, bytes, pts, info.flags))
                }
            } finally { codec.releaseOutputBuffer(index, false) }
        }
    }

    private fun sample(sample: Sample) {
        timeline.push(sample, sample.pts, sample.video, sample.bytes.size)
        flushPending(false)
    }

    private fun flushPending(force: Boolean) {
        if (audioFormat == null || (video && videoFormat == null)) {
            if (force && !timeline.isEmpty()) error("编码器未提供完整媒体格式")
            return
        }
        // Neither encoder may later emit a packet before its latest delivered timestamp
        // (B-frames disabled, each track validated monotonic). The lower track watermark
        // therefore orders A/V exactly, instead of guessing an encoder latency duration.
        timeline.take(force).forEach { writeSample(it) }
    }

    private fun writeSample(sample: Sample) {
        val keyframe = sample.video && sample.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        if (rotateRequested && (!video || keyframe)) { finishSegment(sample.pts); rotateRequested = false }
        if (muxer == null) {
            if (video && !keyframe) return
            ensureSpace()
            segmentStartUs = sample.pts; lastUs = sample.pts; written = 0
            val completedSegments = store.view().getJSONArray("segments")
            val priorEnd = if (completedSegments.length() == 0) 0L else completedSegments.getJSONObject(completedSegments.length() - 1).getLong("endMs")
            if (segmentStartUs / 1000 > priorEnd) store.interruption(priorEnd, segmentStartUs / 1000, if (completedSegments.length() == 0) "设备启动等待" else "暂停或编码器恢复间隙")
            val number = completedSegments.length() + 1
            partial = File(store.directory, "segment-$number.${if (video) "mp4" else "m4a"}.partial")
            require(!partial!!.exists()) { "发现未完成尾段，请先导出或清理草稿" }
            store.pending(partial!!.name.removeSuffix(".partial"), segmentStartUs / 1000)
            muxer = MediaMuxer(partial!!.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4).also {
                audioTrack = it.addTrack(audioFormat!!)
                if (video) { videoTrack = it.addTrack(videoFormat!!); it.setOrientationHint(cameraOrientation()) }
                it.start()
            }
        }
        if (sample.pts < segmentStartUs) return
        val info = MediaCodec.BufferInfo().apply { set(0, sample.bytes.size, sample.pts - segmentStartUs, sample.flags) }
        muxer!!.writeSampleData(if (sample.video) videoTrack else audioTrack, ByteBuffer.wrap(sample.bytes), info)
        written += sample.bytes.size; lastUs = maxOf(lastUs, sample.pts)
    }

    private fun finishSegment(boundaryUs: Long? = null) {
        val current = muxer ?: return
        muxer = null
        try { current.stop() } finally { current.release() }
        val source = partial ?: return
        FileOutputStream(source, true).use { it.fd.sync() }
        val completed = File(source.parentFile, source.name.removeSuffix(".partial"))
        require(source.renameTo(completed)) { "无法保存完整片段" }
        val endUs = boundaryUs ?: lastUs
        require(endUs >= lastUs) { "分段边界与媒体时钟冲突" }
        store.complete(completed, segmentStartUs / 1000, endUs / 1000)
        partial = null
    }

    private fun cameraId(): String {
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val requested = args.optString("cameraDeviceId")
        return if (requested.isNotBlank()) { require(requested in manager.cameraIdList) { "所选摄像头不可用" }; requested }
        else manager.cameraIdList.firstOrNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            ?: manager.cameraIdList.firstOrNull() ?: error("设备没有摄像头")
    }
    private fun cameraOrientation(): Int = (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager)
        .getCameraCharacteristics(cameraId()).get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
    private fun cameraSize(): Size {
        val map = (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager).getCameraCharacteristics(cameraId()).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: error("摄像头格式不可用")
        return map.getOutputSizes(MediaCodec::class.java)?.filter { it.width <= 1280 && it.height <= 720 }?.maxByOrNull { it.width * it.height } ?: error("摄像头不支持720p以内视频")
    }

    @SuppressLint("MissingPermission")
    private fun openCamera(target: Surface, template: Int) {
        val ready = CountDownLatch(1)
        val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        cameraClockRealtime = manager.getCameraCharacteristics(cameraId()).get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        manager.openCamera(cameraId(), object : CameraDevice.StateCallback() {
            override fun onOpened(device: CameraDevice) {
                camera = device
                @Suppress("DEPRECATION")
                device.createCaptureSession(listOf(target), object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        capture = session
                        try {
                            val request = device.createCaptureRequest(template).apply { addTarget(target); set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO) }.build()
                            if (template == CameraDevice.TEMPLATE_STILL_CAPTURE) session.capture(request, null, handler) else session.setRepeatingRequest(request, null, handler)
                        } catch (e: Exception) { cameraError = e.message }
                        ready.countDown()
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) { cameraError = "摄像头配置失败"; ready.countDown() }
                }, handler)
            }
            override fun onDisconnected(device: CameraDevice) { cameraError = "摄像头断开"; device.close(); ready.countDown() }
            override fun onError(device: CameraDevice, error: Int) { cameraError = "摄像头错误 $error"; device.close(); ready.countDown() }
        }, handler)
        require(ready.await(10, TimeUnit.SECONDS)) { "摄像头启动超时" }
        cameraError?.let { error(it) }
    }

    private fun photograph() {
        val map = (context.getSystemService(Context.CAMERA_SERVICE) as CameraManager).getCameraCharacteristics(cameraId()).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: error("摄像头格式不可用")
        val size = map.getOutputSizes(ImageFormat.JPEG).filter { maxOf(it.width, it.height) <= 2000 }.maxByOrNull { it.width * it.height } ?: error("摄像头不支持2000像素以内照片")
        val done = CountDownLatch(1)
        reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 1).also { imageReader ->
            imageReader.setOnImageAvailableListener({ source ->
                try {
                    source.acquireNextImage()?.use { image ->
                        val bytes = ByteArray(image.planes[0].buffer.remaining()); image.planes[0].buffer.get(bytes)
                        val file = File(store.directory, "segment-1.jpg")
                        val temporary = File(store.directory, "segment-1.jpg.partial")
                        store.pending(file.name, 0)
                        FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
                        require(temporary.renameTo(file)) { "无法保存照片" }
                        store.complete(file, 0, nowUs() / 1000)
                        store.state("stopped", nowUs() / 1000)
                    }
                } catch (e: Exception) { cameraError = e.message } finally { done.countDown() }
            }, handler)
        }
        openCamera(reader!!.surface, CameraDevice.TEMPLATE_STILL_CAPTURE)
        require(done.await(15, TimeUnit.SECONDS)) { "拍照超时" }
        cameraError?.let { error(it) }
    }

    private fun close() {
        runCatching { capture?.close() }; runCatching { camera?.close() }; runCatching { reader?.close() }
        runCatching { audio?.stop() }; runCatching { audio?.release() }
        runCatching { aac?.stop() }; runCatching { aac?.release() }
        runCatching { avc?.stop() }; runCatching { avc?.release() }; runCatching { surface?.release() }
        runCatching { muxer?.release() }; cameraThread.quitSafely()
    }
}

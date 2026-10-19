package cn.buwei.nativeapp.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.*
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*

internal class PcmCapture(context: Context) : AutoCloseable {
    private val recorder: AudioRecord
    @Volatile private var running = false
    init {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) throw SecurityException("麦克风权限被拒绝，可继续文字回答")
        val minimum = AudioRecord.getMinBufferSize(VoiceProtocol.RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "此设备不支持 16 kHz 原生录音，可继续文字回答" }
        recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(VoiceProtocol.RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setBufferSizeInBytes(maxOf(minimum * 2, VoiceProtocol.FRAME_SAMPLES * 4)).build()
        check(recorder.state == AudioRecord.STATE_INITIALIZED) { "麦克风初始化失败" }
    }
    suspend fun capture(onFrame: (ShortArray, Int) -> Unit) = withContext(Dispatchers.IO) {
        running = true
        recorder.startRecording()
        check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "麦克风无法开始采集" }
        val samples = ShortArray(VoiceProtocol.FRAME_SAMPLES)
        try {
            while (isActive && running) {
                val count = recorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                if (!running) break
                check(count > 0) { "麦克风断开或音频采集失败" }
                onFrame(samples, count)
            }
        } finally { running = false; runCatching { recorder.stop() } }
    }
    fun stop() { running = false; runCatching { recorder.stop() } }
    override fun close() { stop(); runCatching { recorder.release() } }
}

/** Bounded native playback for local PCM; transcription events themselves contain no audio. */
internal class PcmPlayback : AutoCloseable {
    private var track: AudioTrack? = null
    suspend fun play(pcm: ByteArray) = withContext(Dispatchers.IO) {
        require(pcm.isNotEmpty() && pcm.size % 2 == 0 && pcm.size <= VoiceProtocol.RATE * 2 * 60)
        close()
        val minimum = AudioTrack.getMinBufferSize(VoiceProtocol.RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0)
        val output = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(VoiceProtocol.RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
            .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(minimum, 6400)).build()
        track = output
        try {
            output.play()
            var offset = 0
            while (isActive && track === output && offset < pcm.size) {
                val written = output.write(pcm, offset, minOf(3200, pcm.size - offset), AudioTrack.WRITE_BLOCKING)
                check(written > 0) { "原生音频播放失败" }; offset += written
            }
            while (isActive && track === output && output.playbackHeadPosition < pcm.size / 2) delay(20)
        } finally { if (track === output) close() }
    }
    override fun close() { track?.let { track = null; runCatching { it.stop() }; it.release() } }
}

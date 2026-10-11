package cn.buwei.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.plugin.JSObject
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class PickArgs { var maxFiles: Int = 10 }
@InvokeArg
class ExportArgs { lateinit var path: String; lateinit var name: String; var accountEpoch: Long = -1 }
@InvokeArg
class SessionArgs { var origin: String = "https://greenbp-team-office.hddhp.workers.dev" }
data class PickedFile(val path: String, val name: String, val sizeBytes: Long)
data class Session(val cookie: String, val foreground: Boolean)

/** Internal Rust-only adapter; no web capability grants this plugin commands. */
@TauriPlugin(permissions = [
    Permission(strings = [android.Manifest.permission.RECORD_AUDIO], alias = "recordingAudio"),
    Permission(strings = [android.Manifest.permission.CAMERA], alias = "recordingCamera"),
    Permission(strings = [android.Manifest.permission.POST_NOTIFICATIONS], alias = "recordingNotification")
])
class NativeFilesPlugin(private val activity: Activity) : Plugin(activity) {
    private var exportCookie: String? = null
    private var recordingExportSource: File? = null
    private var recordingExportEpoch: Long = -1
    @Volatile private var recordingStartPending = false
    @Command
    fun recordingExport(invoke: Invoke) {
        try {
            require(recordingExportSource == null) { "已有导出操作" }
            val args = org.json.JSONObject(invoke.getRawArgs())
            val store = RecordingStore(activity, args.getString("root"), args.getString("accountId"), args.getString("id"))
            require(store.view().getString("projectId") == args.getString("projectId"))
            val name = if (args.has("sequence")) {
                val segments = store.view().getJSONArray("segments")
                (0 until segments.length()).map { segments.getJSONObject(it) }.firstOrNull { it.getInt("sequence") == args.getInt("sequence") }?.getString("name") ?: error("录制片段不存在")
            } else args.getString("name")
            require(name.matches(Regex("segment-[0-9]+\\.(m4a|mp4|jpg)(\\.partial)?"))) { "录制文件名无效" }
            val source = File(store.directory, name).canonicalFile
            require(source.parentFile == store.directory && source.isFile) { "录制文件不存在" }
            recordingExportSource = source
            recordingExportEpoch = accountEpoch()
            exportCookie = CookieManager.getInstance().getCookie("https://greenbp-team-office.hddhp.workers.dev")
            startActivityForResult(invoke, Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = "application/octet-stream"; putExtra(Intent.EXTRA_TITLE, name)
            }, "recordingExported")
        } catch (e: Exception) { recordingExportSource = null; invoke.reject(e.message) }
    }
    @ActivityCallback
    fun recordingExported(invoke: Invoke, result: ActivityResult) {
        val source = recordingExportSource
        if (result.resultCode != Activity.RESULT_OK) { recordingExportSource = null; invoke.resolve(); return }
        val uri = result.data?.data
        worker.execute {
            try {
                require(source != null && uri != null)
                require(recordingExportEpoch == accountEpoch() && exportCookie == CookieManager.getInstance().getCookie("https://greenbp-team-office.hddhp.workers.dev")) { "登录账户已变化" }
                activity.contentResolver.openFileDescriptor(uri, "w")?.use { descriptor ->
                    FileOutputStream(descriptor.fileDescriptor).use { output ->
                        source.inputStream().use { input ->
                            val buffer = ByteArray(65536)
                            while (true) {
                                check(recordingExportEpoch == accountEpoch()) { "登录账户已变化" }
                                val n = input.read(buffer); if (n < 0) break; output.write(buffer, 0, n)
                            }
                        }
                        output.flush()
                    }
                } ?: error("无法写入导出位置")
                invoke.resolve()
            } catch (e: Exception) { invoke.reject(e.message) } finally { recordingExportSource = null }
        }
    }
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var foreground = true
    private external fun foregroundChanged(active: Boolean)
    private external fun accountEpoch(): Long
    @Command
    fun recordingCapabilities(invoke: Invoke) {
        try {
            val devices = org.json.JSONArray()
            val cameras = activity.getSystemService(android.content.Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
            for (id in cameras.cameraIdList) {
                val facing = cameras.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)
                devices.put(org.json.JSONObject().put("id", id).put("label", if (facing == android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT) "前置摄像头" else "后置摄像头").put("kind", "videoinput"))
            }
            val audio = activity.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            for (device in audio.getDevices(android.media.AudioManager.GET_DEVICES_INPUTS)) devices.put(org.json.JSONObject().put("id", device.id.toString()).put("label", device.productName.toString()).put("kind", "audioinput"))
            val codecs = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS).codecInfos.filter { it.isEncoder }
            val aac = codecs.any { it.supportedTypes.any { t -> t == android.media.MediaFormat.MIMETYPE_AUDIO_AAC } }
            val avc = codecs.any { it.supportedTypes.any { t -> t == android.media.MediaFormat.MIMETYPE_VIDEO_AVC } }
            invoke.resolve(JSObject().put("audio", aac).put("video", aac && avc && cameras.cameraIdList.isNotEmpty()).put("photo", cameras.cameraIdList.isNotEmpty()).put("background", true).put("devices", devices))
        } catch (e: Exception) { invoke.reject(e.message) }
    }
    @Command
    fun recordingStart(invoke: Invoke) {
        if (!foreground) { invoke.reject("请在前台启动录制"); return }
        val kind = invoke.getArgs().getString("kind")
        if (kind !in listOf("audio", "video", "photo")) { invoke.reject("录制类型无效"); return }
        var aliases = when (kind) { "audio" -> arrayOf("recordingAudio"); "photo" -> arrayOf("recordingCamera"); else -> arrayOf("recordingAudio", "recordingCamera") }
        if (android.os.Build.VERSION.SDK_INT >= 33 && kind != "photo") aliases += "recordingNotification"
        activity.runOnUiThread { requestPermissionForAliases(aliases, invoke, "recordingPermission") }
    }
    @PermissionCallback
    fun recordingPermission(invoke: Invoke) {
        var reservedStart = false
        try {
            val args = org.json.JSONObject(invoke.getRawArgs())
            val kind = args.getString("kind")
            require(foreground) { "权限申请后页面已转入后台，请重新启动" }
            require(RecordingService.instance == null && !recordingStartPending) { "已有活动录制" }
            if (kind != "photo") require(activity.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "麦克风权限未授予" }
            if (kind != "audio") require(activity.checkSelfPermission(android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "摄像头权限未授予" }
            if (android.os.Build.VERSION.SDK_INT >= 33 && kind != "photo") require(activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) { "请允许录制通知，以便在后台停止并保存" }
            // Validate the trusted Rust root before the foreground service creates anything.
            val store = RecordingStore(activity, args.getString("root"), args.getString("accountId"), args.getString("id"))
            require(store.view().length() == 0) { "录制草稿已存在" }
            recordingStartPending = true
            reservedStart = true
            activity.startForegroundService(Intent(activity, RecordingService::class.java).putExtra("args", args.toString()))
            worker.execute {
                try {
                    val deadline = android.os.SystemClock.elapsedRealtime() + 15000
                    var result: org.json.JSONObject? = null
                    while (android.os.SystemClock.elapsedRealtime() < deadline) {
                        val active = RecordingService.instance?.store
                        if (active != null) { result = active.view(); break }
                        Thread.sleep(30)
                    }
                    invoke.resolve(JSObject((result ?: error("录制服务启动失败")).toString()))
                } catch (e: Exception) { invoke.reject(e.message) } finally { recordingStartPending = false }
            }
        } catch (e: Exception) { if (reservedStart) recordingStartPending = false; invoke.reject(e.message) }
    }
    @Command
    fun recordingAction(invoke: Invoke) {
        worker.execute {
            try {
                val args = org.json.JSONObject(invoke.getRawArgs())
                val id = args.getString("id")
                val action = args.optString("action", "snapshot")
                val active = RecordingService.instance
                val expected = RecordingStore(activity, args.getString("root"), args.getString("accountId"), id)
                require(expected.view().getString("projectId") == args.getString("projectId")) { "录制项目不匹配" }
                val ownsActive = active?.store?.directory == expected.directory
                var result = if (ownsActive) active!!.action(id, action, args) else expected.recover()
                if (action != "snapshot" && ownsActive) {
                    val desired = when (action) { "pause" -> "paused"; "resume" -> "recording"; else -> "stopped" }
                    val deadline = android.os.SystemClock.elapsedRealtime() + 10000
                    while (android.os.SystemClock.elapsedRealtime() < deadline) {
                        result = RecordingService.instance?.store?.view() ?: RecordingStore(activity, args.getString("root"), args.getString("accountId"), id).recover()
                        if (result.optString("state") == desired || result.optString("state") == "interrupted") break
                        Thread.sleep(30)
                    }
                }
                invoke.resolve(JSObject(result.toString()))
            } catch (e: Exception) { invoke.reject(e.message) }
        }
    }
    @Command
    fun recordingList(invoke: Invoke) {
        worker.execute {
            try {
                val args = org.json.JSONObject(invoke.getRawArgs())
                val account = args.getString("accountId")
                require(account.matches(Regex("[A-Za-z0-9_-]{1,128}")))
                val root = java.io.File(args.getString("root")).canonicalFile
                require(root == java.io.File(activity.dataDir, "recordings").canonicalFile)
                val items = org.json.JSONArray()
                java.io.File(root, account).listFiles()?.filter { it.isDirectory }?.forEach { directory ->
                    val active = RecordingService.instance?.store
                    val store = RecordingStore(activity, root.path, account, directory.name)
                    val snapshot = if (active?.directory == directory) active.view() else store.recover()
                    if (snapshot.optString("projectId") == args.getString("projectId")) items.put(snapshot)
                }
                invoke.resolveObject(jsonValue(items)!!)
            } catch (e: Exception) { invoke.reject(e.message) }
        }
    }
    private fun jsonValue(value: Any?): Any? = when (value) {
        org.json.JSONObject.NULL, null -> null
        is org.json.JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
        is org.json.JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
        else -> value
    }
    @Command
    fun recordingRemove(invoke: Invoke) {
        worker.execute {
            try {
                val args = org.json.JSONObject(invoke.getRawArgs())
                val store = RecordingStore(activity, args.getString("root"), args.getString("accountId"), args.getString("id"))
                require(store.view().getString("projectId") == args.getString("projectId"))
                require(RecordingService.instance?.store?.directory != store.directory) { "请先停止录制" }
                require(store.directory.deleteRecursively()) { "草稿清理失败" }
                invoke.resolve()
            } catch (e: Exception) { invoke.reject(e.message) }
        }
    }
    override fun load(webView: WebView) {
        foregroundChanged(true)
        // Interrupted imports are disposable: only Rust manifest-owned blobs survive restart.
        worker.execute { incoming().listFiles()?.forEach { it.delete() } }
    }
    override fun onPause(activity: AppCompatActivity) { foreground = false; foregroundChanged(false) }
    override fun onResume(activity: AppCompatActivity) { foreground = true; foregroundChanged(true) }
    override fun onDestroy(activity: AppCompatActivity) { foregroundChanged(false); worker.shutdown() }
    private fun incoming(): File = File(activity.cacheDir, "attachment-import").apply { mkdirs() }

    @Command
    fun session(invoke: Invoke) {
        val args = invoke.parseArgs(SessionArgs::class.java)
        if (args.origin != "https://greenbp-team-office.hddhp.workers.dev" && !(BuildConfig.DEBUG && args.origin == "http://127.0.0.1:5173")) {
            invoke.reject("Invalid session origin"); return
        }
        activity.runOnUiThread {
            // CookieManager includes HttpOnly cookies. Fixed origin, never returned to JavaScript.
            CookieManager.getInstance().flush()
            val sessionCookie = (CookieManager.getInstance().getCookie(args.origin) ?: "").split(';')
                .map { it.trim() }.filter { it.startsWith("ai_office_session=") }.joinToString("; ")
            invoke.resolveObject(Session(sessionCookie, foreground))
        }
    }
    @Command
    fun pickFiles(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        if (args.maxFiles !in 1..10) { invoke.reject("每轮最多提交10个文件"); return }
        startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, args.maxFiles > 1)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, "picked")
    }
    @ActivityCallback
    fun picked(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) { invoke.resolveObject(emptyList<PickedFile>()); return }
        val data = result.data
        val uris = mutableListOf<Uri>()
        data?.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
        if (uris.isEmpty()) data?.data?.let { uris.add(it) }
        val max = invoke.parseArgs(PickArgs::class.java).maxFiles
        if (uris.size > max) { invoke.reject("选择的文件数量超过上限"); return }
        worker.execute {
            val files = mutableListOf<PickedFile>()
            var partial: File? = null
            try {
                for (uri in uris) {
                    require(uri.scheme == "content") { "仅支持系统文档选择器文件" }
                    var name = "附件"
                    var expected: Long? = null
                    activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val ni = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (ni >= 0 && !cursor.isNull(ni)) name = cursor.getString(ni)
                            val si = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (si >= 0 && !cursor.isNull(si)) expected = cursor.getLong(si)
                        }
                    }
                    name = name.substringAfterLast('/').substringAfterLast('\\')
                    require(name.isNotBlank() && name.length <= 255) { "文件名无效" }
                    val target = File(incoming(), UUID.randomUUID().toString())
                    partial = target
                    activity.contentResolver.openInputStream(uri)?.use { input ->
                        FileOutputStream(target).use { output ->
                            input.copyTo(output, 64 * 1024)
                            output.fd.sync()
                        }
                    } ?: error("无法读取选择的文件")
                    require(target.length() > 0 && (expected == null || expected == target.length())) { "文件大小变化，请重新选择" }
                    files.add(PickedFile(target.absolutePath, name, target.length()))
                    partial = null
                }
                invoke.resolveObject(files)
            } catch (_: Exception) {
                partial?.delete()
                files.forEach { File(it.path).delete() }
                invoke.reject("附件复制失败，原文件保留；请检查空间和文件权限")
            }
        }
    }
    @Command
    fun exportFile(invoke: Invoke) {
        val args = invoke.parseArgs(ExportArgs::class.java)
        val source = File(args.path).canonicalFile
        // Rust supplies only a manifest-selected private blob, never a page-provided path.
        require(source.path.startsWith(File(activity.dataDir, "attachments").canonicalPath + File.separator)) { "文件不在附件缓存中" }
        exportCookie = CookieManager.getInstance().getCookie("https://greenbp-team-office.hddhp.workers.dev")
        startActivityForResult(invoke, Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, args.name)
        }, "exported")
    }
    @ActivityCallback
    fun exported(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) { invoke.resolve(); return }
        val uri = result.data?.data ?: run { invoke.reject("未选择导出位置"); return }
        if (invoke.parseArgs(ExportArgs::class.java).accountEpoch != accountEpoch() || exportCookie != CookieManager.getInstance().getCookie("https://greenbp-team-office.hddhp.workers.dev")) {
            invoke.reject("登录会话已变化，导出取消"); return
        }
        worker.execute {
            try {
                val source = File(invoke.parseArgs(ExportArgs::class.java).path)
                activity.contentResolver.openFileDescriptor(uri, "w")?.use { descriptor ->
                    FileOutputStream(descriptor.fileDescriptor).use { output ->
                        val expectedEpoch = invoke.parseArgs(ExportArgs::class.java).accountEpoch
                        source.inputStream().use { input ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                check(expectedEpoch == accountEpoch()) { "登录账户已变化" }
                                val count = input.read(buffer)
                                if (count < 0) break
                                output.write(buffer, 0, count)
                            }
                        }
                        output.flush() // Provider-owned pipe commits on close; private imports require fsync.
                    }
                } ?: error("无法写入导出位置")
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("导出失败，缓存文件仍保留") }
        }
    }
}

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
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class PickArgs { var maxFiles: Int = 10 }
@InvokeArg
class ExportArgs { lateinit var path: String; lateinit var name: String }
@InvokeArg
class SessionArgs { var origin: String = "https://greenbp-team-office.hddhp.workers.dev" }
data class PickedFile(val path: String, val name: String, val sizeBytes: Long)
data class Session(val cookie: String, val foreground: Boolean)

/** Internal Rust-only adapter; no web capability grants this plugin commands. */
@TauriPlugin
class NativeFilesPlugin(private val activity: Activity) : Plugin(activity) {
    private var exportCookie: String? = null
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var foreground = true
    private external fun foregroundChanged(active: Boolean)
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
        if (exportCookie != CookieManager.getInstance().getCookie("https://greenbp-team-office.hddhp.workers.dev")) {
            invoke.reject("登录会话已变化，导出取消"); return
        }
        worker.execute {
            try {
                val source = File(invoke.parseArgs(ExportArgs::class.java).path)
                activity.contentResolver.openFileDescriptor(uri, "w")?.use { descriptor ->
                    FileOutputStream(descriptor.fileDescriptor).use { output ->
                        source.inputStream().use { it.copyTo(output, 64 * 1024) }
                        output.fd.sync()
                    }
                } ?: error("无法写入导出位置")
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("导出失败，缓存文件仍保留") }
        }
    }
}

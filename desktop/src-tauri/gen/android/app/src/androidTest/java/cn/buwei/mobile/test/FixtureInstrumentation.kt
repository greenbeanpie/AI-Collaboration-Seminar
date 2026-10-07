package cn.buwei.mobile.test

import android.app.Activity
import android.app.Instrumentation
import android.content.pm.ApplicationInfo
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/** Isolated APK-only fixture helper. Never compiled into the application. */
class FixtureInstrumentation : Instrumentation() {
    private lateinit var arguments: Bundle
    private val account = "11111111-1111-4111-8111-111111111111"
    private val project = "22222222-2222-4222-8222-222222222222"
    private val task = "33333333-3333-4333-8333-333333333333"
    private val fixtureBytes = 9L * 1048576L + 128L

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        this.arguments = arguments ?: Bundle()
        start()
    }

    override fun onStart() {
        val result = Bundle()
        try {
            check(targetContext.packageName == "cn.buwei.mobile") { "Unexpected target package" }
            check(targetContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) { "Fixture instrumentation requires debuggable target" }
            val root = File(targetContext.applicationInfo.dataDir, "attachments/$account")
            val op = arguments.getString("op") ?: error("Missing fixture operation")
            val manifest = File(root, "manifest.json")
            when (op) {
                "digest", "manifest" -> {
                    val id = canonicalUuid(arguments.getString("row") ?: error("Missing row"))
                    val rows = loadRows(manifest)
                    val row = (0 until rows.length()).map { rows.getJSONObject(it) }
                        .firstOrNull { it.optString("id") == id } ?: error("Fixture row missing")
                    check(row.getString("accountId") == account && row.getString("projectId") == project) { "Unexpected fixture scope" }
                    result.putString("rowId", id)
                    if (op == "manifest") result.putString("row", row.toString())
                    else digest(File(root, "$id.blob"), result)
                }
                "seed-upload" -> {
                    check(root.exists() || root.mkdirs()) { "Cannot create fixture account directory" }
                    val rows = loadRows(manifest)
                    val id = UUID.randomUUID().toString()
                    val block = ByteArray(64 * 1024)
                    val pattern = "Buwei Windows native smoke fixture.\r\n".toByteArray(Charsets.UTF_8)
                    for (index in block.indices) block[index] = pattern[index % pattern.size]
                    val file = File(root, "$id.blob")
                    FileOutputStream(file).use { output ->
                        var remaining = fixtureBytes
                        while (remaining > 0) {
                            val size = minOf(block.size.toLong(), remaining).toInt()
                            output.write(block, 0, size)
                            remaining -= size
                        }
                        output.fd.sync()
                    }
                    val row = JSONObject().apply {
                        put("id", id); put("accountId", account); put("projectId", project); put("taskId", task)
                        put("name", "native-upload.txt"); put("sizeBytes", fixtureBytes)
                        put("direction", "upload"); put("status", "waiting"); put("transferredBytes", 0)
                        put("sessionId", JSONObject.NULL)
                    }
                    rows.put(row)
                    val temporary = File(root, "manifest.fixture.tmp")
                    FileOutputStream(temporary).use { output ->
                        output.write(rows.toString().toByteArray(Charsets.UTF_8)); output.fd.sync()
                    }
                    check(temporary.renameTo(manifest)) { "Cannot persist fixture manifest" }
                    result.putString("rowId", id)
                    digest(file, result)
                }
                else -> error("Unsupported fixture operation")
            }
            result.putString("status", "passed")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("status", "failed")
            result.putString("error", error.message ?: error.javaClass.simpleName)
            finish(Activity.RESULT_CANCELED, result)
        }
    }

    private fun canonicalUuid(value: String): String {
        val normalized = UUID.fromString(value).toString()
        check(normalized == value.lowercase()) { "Noncanonical fixture identifier" }
        return normalized
    }
    private fun loadRows(file: File): JSONArray {
        check(!file.exists() || file.length() <= 1024 * 1024) { "Fixture manifest too large" }
        return if (file.exists()) JSONArray(file.readText(Charsets.UTF_8)) else JSONArray()
    }
    private fun digest(file: File, result: Bundle) {
        check(file.isFile && file.length() <= fixtureBytes) { "Fixture file missing or exceeds fixed limit" }
        val digest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        FileInputStream(file).use { input ->
            val block = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(block)
                if (count < 0) break
                digest.update(block, 0, count); bytes += count
            }
        }
        result.putString("sha256", digest.digest().joinToString("") { "%02x".format(it) })
        result.putString("bytes", bytes.toString())
    }
}

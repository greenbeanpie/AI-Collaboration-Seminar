package cn.buwei.mobile

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Private, durable manifest. Completed media is never deleted during recovery. */
class RecordingStore(context: Context, root: String, account: String, id: String) {
    val directory: File
    private val manifest: AtomicFile
    var snapshot: JSONObject
        private set

    init {
        require(account.matches(Regex("[A-Za-z0-9_-]{1,128}")) && id.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "录制标识无效" }
        val privateRoot = File(context.dataDir, "recordings").canonicalFile
        val requested = File(root).canonicalFile
        require(requested == privateRoot) { "录制目录不在应用私有空间" }
        directory = File(File(requested, account), id).canonicalFile
        require(directory.path.startsWith(privateRoot.path + File.separator))
        directory.mkdirs()
        manifest = AtomicFile(File(directory, "manifest.json"))
        snapshot = if (manifest.baseFile.exists()) JSONObject(manifest.openRead().bufferedReader().use { it.readText() }) else JSONObject()
        // Old native builds always used an automatic title and the actor as contributor.
        // Missing upload bookkeeping cannot prove that no create request reached the server.
        // Preserve that historical identity before exposing editable new metadata controls.
        if(snapshot.length()>0&&!snapshot.has("metadataVersion")&&!snapshot.has("uploadMetadata")){
            val title="会议录制 ${snapshot.optString("createdAt")}";val people=JSONArray().put(snapshot.getString("accountId"))
            snapshot.put("title",title).put("contributorIds",people).put("legacyMetadataPreserved",true)
                .put("uploadMetadata",JSONObject().put("clientSessionId",snapshot.getString("id")).put("title",title)
                    .put("kind",snapshot.getString("kind")).put("purpose","reference").put("contributorIds",JSONArray(people.toString())))
            save()
        }
    }

    @Synchronized fun create(args: JSONObject) {
        require(snapshot.length() == 0) { "录制草稿已存在" }
        snapshot = JSONObject().put("id", args.getString("id")).put("accountId", args.getString("accountId"))
            .put("projectId", args.getString("projectId")).put("kind", args.getString("kind"))
            .put("state", "recording").put("createdAt", java.time.Instant.now().toString())
            .put("elapsedMs", 0).put("segments", JSONArray()).put("interruptions", JSONArray()).put("metadataVersion",1)
        save()
    }

    @Synchronized fun save() {
        val output = manifest.startWrite()
        try { output.write(snapshot.toString().toByteArray(Charsets.UTF_8)); manifest.finishWrite(output) }
        catch (e: Exception) { manifest.failWrite(output); throw e }
    }

    /** Refresh an inactive view after a service-owned writer has finalized the manifest. */
    @Synchronized fun refresh(): JSONObject {
        if(manifest.baseFile.exists()) snapshot=JSONObject(manifest.openRead().bufferedReader().use{it.readText()})
        return view()
    }

    @Synchronized fun metadata(title:String,contributors:List<String>) {
        require(!snapshot.has("uploadMetadata")){"上传参数已固定，请使用原参数继续上传"}
        val name=title.trim();require(name.length in 1..200){"标题须为1至200字"}
        require(contributors.size in 1..100&&contributors.distinct().size==contributors.size){"请选择1至100位不重复的贡献人"}
        contributors.forEach{require(java.util.UUID.fromString(it).toString()==it.lowercase()){"贡献人标识无效"}}
        snapshot.put("title",name).put("contributorIds",JSONArray(contributors.sorted()));save()
    }

    /** Freeze before the first request, so a lost create response can retry the exact identity. */
    @Synchronized fun freezeUploadMetadata():JSONObject {
        if(!snapshot.has("uploadMetadata")){
            val contributors=snapshot.optJSONArray("contributorIds")?:JSONArray().put(snapshot.getString("accountId"))
            val title=snapshot.optString("title").ifBlank{"会议录制 ${snapshot.optString("createdAt")}"}
            metadata(title,(0 until contributors.length()).map{contributors.getString(it)})
            snapshot.put("uploadMetadata",JSONObject().put("clientSessionId",snapshot.getString("id"))
                .put("title",title).put("kind",snapshot.getString("kind")).put("purpose","reference")
                .put("contributorIds",JSONArray(contributors.toString())))
            save()
        }
        return JSONObject(snapshot.getJSONObject("uploadMetadata").toString())
    }
    @Synchronized fun uploadedSegment(sequence:Int,fileId:String){
        require(java.util.UUID.fromString(fileId).toString()==fileId.lowercase())
        val segments=snapshot.getJSONArray("segments")
        val segment=(0 until segments.length()).map{segments.getJSONObject(it)}.single{it.getInt("sequence")==sequence}
        require(!segment.has("fileId")||segment.getString("fileId")==fileId){"片段云端文件身份已变化"}
        segment.put("fileId",fileId);save()
    }
    @Synchronized fun cloudSession(sessionId:String,materialId:String){
        require(snapshot.has("uploadMetadata")){"上传身份尚未固定"}
        require(java.util.UUID.fromString(sessionId).toString()==sessionId.lowercase())
        require(java.util.UUID.fromString(materialId).toString()==materialId.lowercase())
        require(!snapshot.has("sessionId")||snapshot.getString("sessionId")==sessionId){"云端录制身份已变化"}
        require(!snapshot.has("materialId")||snapshot.getString("materialId")==materialId){"云端材料身份已变化"}
        snapshot.put("sessionId",sessionId).put("materialId",materialId);save()
    }

    @Synchronized fun state(state: String, elapsed: Long, error: String? = null) {
        snapshot.put("state", state).put("elapsedMs", elapsed)
        if (error != null) snapshot.put("error", error)
        save()
    }

    @Synchronized fun complete(file: File, start: Long, end: Long) {
        require(file.length() > 0) { "录制结果为空" }
        require(file.length() <= 32L * 1024 * 1024) { "录制片段超过32 MiB；原文件保留，请导出后处理" }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) } }
        val segments = snapshot.getJSONArray("segments")
        segments.put(JSONObject().put("sequence", segments.length() + 1).put("name", file.name)
            .put("sizeBytes", file.length()).put("startMs", start).put("endMs", end)
            .put("sha256", digest.digest().joinToString("") { "%02x".format(it) }))
        snapshot.put("elapsedMs", end)
        snapshot.remove("pendingSegment")
        save()
    }

    @Synchronized fun pending(name: String, start: Long) {
        snapshot.put("pendingSegment", JSONObject().put("name", name).put("startMs", start))
        save()
    }

    @Synchronized fun interruption(start: Long, end: Long, reason: String) {
        snapshot.getJSONArray("interruptions").put(JSONObject().put("startMs", start).put("endMs", end).put("reason", reason))
        save()
    }

    @Synchronized fun recover(): JSONObject {
        val pending = snapshot.optJSONObject("pendingSegment")
        if (pending != null) {
            val completed = File(directory, pending.getString("name"))
            if (completed.isFile && completed.length() > 0) {
                // A rename may have committed just before the process died during manifest fsync.
                val extractor = android.media.MediaExtractor()
                try {
                    val duration = if (completed.extension == "jpg") {
                        val options = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                        android.graphics.BitmapFactory.decodeFile(completed.path, options)
                        require(options.outWidth > 0 && options.outHeight > 0)
                        0L
                    } else {
                        extractor.setDataSource(completed.path)
                        require(extractor.trackCount > 0)
                        (0 until extractor.trackCount).maxOf { track ->
                            val format = extractor.getTrackFormat(track)
                            if (format.containsKey(android.media.MediaFormat.KEY_DURATION)) format.getLong(android.media.MediaFormat.KEY_DURATION) / 1000 else 0L
                        }
                    }
                    complete(completed, pending.getLong("startMs"), pending.getLong("startMs") + duration)
                } catch (_: Exception) { snapshot.put("error", "尾段可能损坏，请导出后检查") }
                finally { extractor.release() }
            }
        }
        if (snapshot.optString("state") in listOf("recording", "paused")) {
            val end = snapshot.optLong("elapsedMs")
            snapshot.put("state", "interrupted").put("error", "应用中断；完整片段已保留，尾段可能损坏")
            interruption(end, end, "进程中断，尾段未完成")
        }
        // Include orphan tails for explicit export, never present them as playable segments.
        val registered = snapshot.optJSONArray("segments")?.let { segments -> (0 until segments.length()).map { segments.getJSONObject(it).getString("name") }.toSet() } ?: emptySet()
        snapshot.put("incompleteFiles", JSONArray(directory.listFiles()?.filter {
            it.name.matches(Regex("segment-[0-9]+\\.(m4a|mp4|jpg)(\\.partial)?")) && it.name !in registered
        }?.map { it.name } ?: emptyList<String>()))
        return JSONObject(snapshot.toString())
    }

    @Synchronized fun view(): JSONObject = JSONObject(snapshot.toString())
}

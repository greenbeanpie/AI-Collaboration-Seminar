package cn.buwei.nativeapp.media

import android.util.AtomicFile
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

class AttachmentTransfer(private val repository:ClientRepository) {
    private fun digest(file:File):String { val hash=MessageDigest.getInstance("SHA-256");file.inputStream().use {input->val b=ByteArray(65536);while(true){val n=input.read(b);if(n<0)break;hash.update(b,0,n)}};return hash.digest().joinToString(""){"%02x".format(it)} }
    suspend fun upload(project:String,file:File,onProgress:(String)->Unit):String=withContext(Dispatchers.IO) {
        val owner=repository.accountId?:error("请登录");val generation=repository.epoch
        fun assertOwner(){check(repository.accountId==owner&&repository.epoch==generation){"账户已变化，上传已停止"}}
        val identity=digest(file)
        val manifest=AtomicFile(File(repository.context.filesDir,"accounts/$owner/transfers/$project-$identity.json"))
        manifest.baseFile.parentFile?.mkdirs()
        var state=if(manifest.baseFile.exists()) repository.json.parseToJsonElement(manifest.openRead().bufferedReader().use {it.readText()}).jsonObject else JsonObject(emptyMap())
        fun save(value:JsonObject){val out=manifest.startWrite();try{out.write(value.toString().toByteArray());manifest.finishWrite(out)}catch(e:Exception){manifest.failWrite(out);throw e};state=value}
        repository.validateSession();assertOwner()
        if(state["fileId"]==null) {
            val key=state["key"]?.jsonPrimitive?.content?:UUID.randomUUID().toString().also { save(buildJsonObject {put("key",it)}) }
            val record=repository.request("POST","/projects/$project/files",buildJsonObject {put("fileName",file.name);put("purpose","reference")},key)
            save(buildJsonObject {put("key",key);put("fileId",record["fileId"]!!)})
        }
        val id=state["fileId"]!!.jsonPrimitive.content;val path="/projects/$project/files/$id/uploads"
        val init=repository.networkJson("POST",path,buildJsonObject {put("sizeBytes",file.length())})
        val session=init["sessionId"]!!.jsonPrimitive.content
        val partBytes=init["partBytes"]!!.jsonPrimitive.int
        require(partBytes in 1..(8*1024*1024)) {"服务返回了无效分片大小"}
        val status=repository.networkJson("GET","$path/$session")
        if(status["status"]?.jsonPrimitive?.content!="complete") {
            val done=(status["parts"] as? JsonArray).orEmpty().associate { val p=it.jsonObject;p["partNumber"]!!.jsonPrimitive.int to p["sizeBytes"]!!.jsonPrimitive.long }
            RandomAccessFile(file,"r").use {input->var offset=0L;var part=1
                while(offset<file.length()) { ensureActive();assertOwner(); val bytes=minOf(partBytes.toLong(),file.length()-offset).toInt()
                    if(done[part]!=bytes.toLong()) {
                        input.seek(offset);val buffer=ByteArray(bytes);input.readFully(buffer)
                        onProgress("上传分片 $part / ${(file.length()+partBytes-1)/partBytes}")
                        repository.uploadPart("$path/$session/parts/$part",buffer)
                    }
                    offset+=bytes;part++
                }
            }
            repository.networkJson("POST","$path/$session/complete")
        }
        assertOwner();onProgress("文件上传完成");id
    }
    suspend fun importDocument(project:String,file:File,onProgress:(String)->Unit):JsonObject {
        val fileId=upload(project,file,onProgress)
        val source=repository.request("POST","/projects/$project/sources",buildJsonObject {put("kind","file");put("title",file.name);put("fileId",fileId);put("purpose","reference")})
        val version=source["sourceVersionId"]!!.jsonPrimitive.content
        val extension=file.extension.lowercase()
        val path="/projects/$project/document-imports"
        val init=repository.networkJson("POST",path,buildJsonObject {put("sourceVersionId",version);put("method","browser-$extension")})
        val session=init["sessionId"]!!.jsonPrimitive.content
        var batch=0
        val result=DocumentReader.read(repository.context,file) {block->
            repository.networkJson("POST","$path/$session/batches",buildJsonObject {put("batchNumber",batch);put("blocks",buildJsonArray {add(buildJsonObject {put("seq",block.seq);put("pageNumber",block.page?.let {JsonPrimitive(it)}?:JsonNull);put("text",block.text)})})})
            batch++;onProgress("本机正文已提交 $batch 批")
        }
        return repository.networkJson("POST","$path/$session/complete",buildJsonObject {put("totalPages",result.pages?.let {JsonPrimitive(it)}?:JsonNull);put("warnings",JsonArray(result.warnings.take(100).map {JsonPrimitive(it.take(1000))}));put("partial",result.warnings.any {it.contains("没有可提取")});put("interrupted",false)})
    }
}

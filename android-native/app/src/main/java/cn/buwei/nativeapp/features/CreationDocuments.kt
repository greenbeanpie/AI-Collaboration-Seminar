package cn.buwei.nativeapp.features

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.media.DocumentReader
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

/** Draft endpoints deliberately never use project attachment/source routes. */
internal object CreationDocuments {
 suspend fun stage(context:Context,uri:Uri,owner:String):File=withContext(Dispatchers.IO){
  val name=context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use{if(it.moveToFirst())it.getString(0)else null}?:"资料"
  val dir=File(context.filesDir,"creation-files/$owner").apply{mkdirs()};val file=File(dir,UUID.randomUUID().toString()+"-"+name.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").take(180));val partial=File(file.path+".partial")
  try{context.contentResolver.openInputStream(uri)!!.use{input->partial.outputStream().use{output->val buffer=ByteArray(65536);var total=0L;while(true){ensureActive();val n=input.read(buffer);if(n<0)break;total+=n;require(total<=512L*1024*1024){"文件超过 512 MiB"};require(dir.usableSpace>64L*1024*1024){"存储空间不足，需保留 64 MiB"};output.write(buffer,0,n)}}};check(partial.renameTo(file)){"无法保存原文件"};file}finally{partial.delete()}
 }
 suspend fun upload(repository:ClientRepository,draft:JsonObject,file:File,progress:(String)->Unit):JsonObject=withContext(Dispatchers.IO){
  val owner=repository.accountId?:error("请先登录");val epoch=repository.epoch
  fun guard(){check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化，已保留原文件"}}
  guard();val digest=MessageDigest.getInstance("SHA-256");file.inputStream().use{input->val b=ByteArray(65536);while(true){ensureActive();val n=input.read(b);if(n<0)break;digest.update(b,0,n)}}
  val hash=digest.digest().joinToString(""){"%02x".format(it)}
  val dir=File(repository.context.filesDir,"creation-files/$owner").apply{mkdirs()};val manifest=File(dir,"${draft.text("id")}-${hash}-${file.name.drop(37).hashCode()}.upload")
  val fileId=if(manifest.exists())manifest.readText()else UUID.randomUUID().toString().also{manifest.writeText(it)}
  val base="/api/v1/creation-drafts/${Uri.encode(draft.text("id"))}/files/$fileId";val revision=draft["revision"]!!
  suspend fun post(tail:String,body:JsonObject?=null)=repository.networkJson("POST",base+tail,body,expectedOwner=owner,expectedEpoch=epoch)
  val status=post("/multipart",buildJsonObject{put("expectedRevision",revision);put("name",file.name.drop(37));put("sizeBytes",file.length())})
  val partBytes=status["partBytes"]!!.jsonPrimitive.int;require(partBytes in 1..8*1024*1024)
  if(status.text("status")=="uploading")RandomAccessFile(file,"r").use{input->var part=1;while(input.filePointer<input.length()){guard();ensureActive();val bytes=ByteArray(minOf(partBytes.toLong(),input.length()-input.filePointer).toInt());input.readFully(bytes);val exists=(status["parts"]as? JsonArray).orEmpty().any{it.jsonObject.text("partNumber")==part.toString()&&it.jsonObject.text("sizeBytes")==bytes.size.toString()};if(!exists){progress("上传分片 $part");repository.execute("PUT","$base/multipart/$part",bytes.toRequestBody("application/octet-stream".toMediaType()),expectedOwner=owner,expectedEpoch=epoch).use{check(it.isSuccessful){"草稿分片上传失败 (${it.code})，可显式重试"}}};part++}}
  var latest=post("/multipart/complete")
  if((latest["files"]as? JsonArray).orEmpty().any{it.jsonObject.text("id")==fileId && it.jsonObject["textReady"]?.jsonPrimitive?.booleanOrNull==true}){guard();progress("服务端已保留该原件及已解析正文，请核对覆盖提示");return@withContext latest}
  if(file.extension.lowercase() in listOf("pdf","docx","xlsx","pptx","txt","md")){
   val expected=latest["revision"]!!;var submitted=0
   try {
    val parsed=DocumentReader.read(repository.context,file) { block ->
     guard(); progress("导入正文块 ${submitted+1}")
     post("/imports",buildJsonObject {
      put("expectedRevision",expected)
      put("blocks",buildJsonArray {
       add(buildJsonObject {
        put("seq",block.seq)
        put("pageNumber",block.page?.let(::JsonPrimitive)?:JsonNull)
        put("text",block.text)
        put("headingPath",JsonArray(block.headingPath.take(6).map(::JsonPrimitive)))
       })
      })
     })
     submitted++
    }
    latest=post("/imports/complete",buildJsonObject {
     put("expectedRevision",expected);put("blocks",submitted)
     put("status",if(parsed.warnings.isEmpty())"complete"else"partial")
     put("warnings",JsonArray(parsed.warnings.take(100).map{JsonPrimitive(it.take(1000))}))
    })   }catch(e:Exception){withContext(NonCancellable){withTimeoutOrNull(5000){runCatching{post("/imports/complete",buildJsonObject{put("expectedRevision",expected);put("blocks",submitted);put("status","partial");put("interrupted",true);put("warnings",buildJsonArray{add("原件已保留，正文导入中断，请刷新后核对")})})}}};throw e}
  };guard();progress("草稿资料已保存");latest
 }
}

internal fun creationPatch(value:JsonObject,key:String,next:JsonElement?)=JsonObject(value.toMutableMap().apply{if(next==null)remove(key)else put(key,next)})
internal fun creationCommitBody(draft:JsonObject):JsonObject{
 require(draft.text("status")=="active"&&draft.text("previewState")=="ready"&&draft["revision"]==draft["previewRevision"]){"预览必须对应当前草稿版本"}
 return buildJsonObject{put("expectedRevision",draft["revision"]!!);put("confirmed",true);draft.text("previewAttemptId").takeIf{it.isNotBlank()}?.let{put("expectedPreviewAttemptId",it)}}
}




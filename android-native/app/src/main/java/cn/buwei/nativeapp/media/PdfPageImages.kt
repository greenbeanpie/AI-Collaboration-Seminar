package cn.buwei.nativeapp.media

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.AtomicFile
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.io.FilterOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.floor

internal data class PdfImageLimits(val edge:Int,val bytes:Int,val maxPages:Int?) {
    init {require(edge>0&&bytes>0&&(maxPages==null||maxPages>0)){"扫描页限制必须为正数"}}
    val boundedEdge get()=minOf(edge,2000)
    val boundedBytes get()=minOf(bytes,2*1024*1024)
}

/** One page and one bitmap at a time, with bounded compression attempts and output bytes. */
internal suspend fun renderPdfPageImage(page:PdfRenderer.Page,limits:PdfImageLimits,destination:File,guard:()->Unit = {})=withContext(Dispatchers.IO) {
    require(page.width>0&&page.height>0){"PDF 页面尺寸无效"}
    destination.parentFile?.mkdirs()
    val temporary=File(destination.path+".rendering")
    var edge=limits.boundedEdge
    try {
        repeat(8) {
            ensureActive();guard()
            val scale=edge.toDouble()/maxOf(page.width,page.height)
            val width=maxOf(1,floor(page.width*scale).toInt());val height=maxOf(1,floor(page.height*scale).toInt())
            val bitmap=Bitmap.createBitmap(width,height,Bitmap.Config.ARGB_8888)
            try {
                bitmap.eraseColor(Color.WHITE)
                page.render(bitmap,null,Matrix().apply {setScale(width.toFloat()/page.width,height.toFloat()/page.height)},PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                for(quality in listOf(86,72,58,45)) {
                    ensureActive();guard()
                    var oversized=false
                    val accepted=try {
                        temporary.outputStream().use { file->
                            val bounded=object:FilterOutputStream(file) {
                                var count=0
                                override fun write(value:Int) {if(++count>limits.boundedBytes){oversized=true;throw IOException("图片超出体积限制")};out.write(value)}
                                override fun write(bytes:ByteArray,offset:Int,length:Int) {if(count.toLong()+length>limits.boundedBytes){oversized=true;throw IOException("图片超出体积限制")};count+=length;out.write(bytes,offset,length)}
                            }
                            bitmap.compress(Bitmap.CompressFormat.JPEG,quality,bounded)
                        }
                    } catch(failure:IOException) {if(!oversized)throw failure;false}
                    if(accepted&&!oversized&&temporary.length() in 1..limits.boundedBytes.toLong()) {
                        ensureActive();guard()
                        check(temporary.renameTo(destination)){"页面图片保存失败"}
                        return@withContext
                    }
                    temporary.delete()
                }
            } finally {bitmap.recycle()}
            if(width==1&&height==1)throw IOException("第 ${page.index+1} 页无法在当前图片体积限制内生成")
            edge=maxOf(1,floor(edge*0.82).toInt())
        }
        throw IOException("第 ${page.index+1} 页无法在当前图片体积限制内生成")
    } finally {temporary.delete()}
}

/** Explicit upload-only preparation. The dedicated endpoint fails safely on older backends. */
suspend fun uploadMissingPdfImages(
    repository:ClientRepository,project:String,sourceId:String,sourceVersionId:String,file:File,onProgress:(String)->Unit,
)=withContext(Dispatchers.IO) {
    for(id in listOf(project,sourceId,sourceVersionId))require(UUID.fromString(id).toString()==id.lowercase()){ "来源标识无效" }
    require(file.isFile&&file.extension.equals("pdf",true)){"扫描页需要原始 PDF 文件"}
    val owner=repository.accountId?:error("请先登录");val generation=repository.epoch
    fun assertOwner(){ensureActive();check(repository.accountId==owner&&repository.epoch==generation){"账户已变化，扫描页上传已停止"}}
    suspend fun get(path:String):JsonObject {assertOwner();return repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=generation).also {assertOwner()}}
    val prefix="/projects/$project/sources/$sourceId"
    val initial=get(prefix)
    val lifecycle=initial["lifecycleVersion"]?.jsonPrimitive?.intOrNull?:error("来源生命周期缺失")
    require(lifecycle>0&&initial["currentVersionId"]?.jsonPrimitive?.contentOrNull==sourceVersionId&&initial["deletedAt"]?.jsonPrimitive?.contentOrNull==null){"来源版本或生命周期已变化，请刷新后继续"}
    suspend fun active() {
        val current=get(prefix)
        check(current["lifecycleVersion"]?.jsonPrimitive?.intOrNull==lifecycle&&current["currentVersionId"]?.jsonPrimitive?.contentOrNull==sourceVersionId&&current["deletedAt"]?.jsonPrimitive?.contentOrNull==null){"来源版本或生命周期已变化，扫描页上传已停止"}
    }
    val version=get("$prefix/versions/$sourceVersionId")
    check(version["sourceId"]?.jsonPrimitive?.contentOrNull==sourceId&&version["sourceVersionId"]?.jsonPrimitive?.contentOrNull==sourceVersionId){"来源版本不匹配"}
    val cap=get("/capabilities")["limits"]?.jsonObject?:error("服务未返回扫描页渲染限制")
    val limits=PdfImageLimits(cap["pageImageMaxEdge"]?.jsonPrimitive?.intOrNull?:error("扫描页长边限制无效"),cap["pageImageMaxBytes"]?.jsonPrimitive?.intOrNull?:error("扫描页体积限制无效"),cap["maxPdfPages"]?.let {if(it==JsonNull)null else it.jsonPrimitive.intOrNull?:error("PDF 页数限制无效")})
    suspend fun missing():List<Int> {
        val response=get("$prefix/render-requests?sourceVersionId=$sourceVersionId")
        val items=response["items"] as? JsonArray?:error("待渲染页码响应无效")
        val pages=items.map {it.jsonObject["pageNumber"]?.jsonPrimitive?.intOrNull?:error("待渲染页码无效")}
        require(pages.size==pages.toSet().size&&pages.all {it>0}){"待渲染页码无效或重复"}
        return pages.sorted()
    }
    val requested=missing()
    if(requested.isEmpty()){onProgress("扫描页图片已准备完成；未调用识别模型");return@withContext}
    val hash=MessageDigest.getInstance("SHA-256")
    file.inputStream().use {input->val buffer=ByteArray(65536);while(true){assertOwner();val count=input.read(buffer);if(count<0)break;hash.update(buffer,0,count)}}
    val fingerprint=hash.digest().joinToString(""){"%02x".format(it)}
    val directory=File(repository.context.filesDir,"accounts/$owner/pdf-pages/$project/$sourceId/$sourceVersionId-$lifecycle-$fingerprint")
    check(directory.mkdirs()||directory.isDirectory){"无法创建扫描页本机目录"}
    ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY).use {descriptor->PdfRenderer(descriptor).use {document->
        require(document.pageCount>0&&requested.all {it<=document.pageCount}){"待识别页码与原始 PDF 页数不一致"}
        require(limits.maxPages==null||document.pageCount<=limits.maxPages){"PDF 页数超过服务端限制"}
        for(pageNumber in requested) {
            assertOwner();active()
            if(pageNumber !in missing())continue
            onProgress("正在准备扫描页 $pageNumber / ${document.pageCount}")
            val image=File(directory,"page-$pageNumber.jpg")
            val bounds=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true}
            if(image.isFile)android.graphics.BitmapFactory.decodeFile(image.path,bounds)
            val reusable=image.length() in 1..limits.boundedBytes.toLong()&&bounds.outWidth>0&&bounds.outHeight>0&&maxOf(bounds.outWidth,bounds.outHeight)<=limits.boundedEdge
            if(!reusable)document.openPage(pageNumber-1).use {page->renderPdfPageImage(page,limits,image,::assertOwner)}
            assertOwner()
            // The transfer helper persists a content-hash upload manifest, so a retry reuses completed uploads.
            val imageId=AttachmentTransfer(repository).upload(project,image,onProgress)
            assertOwner();active()
            if(pageNumber !in missing())continue
            val intent=AtomicFile(File(directory,"page-$pageNumber-registration.json"))
            var saved=if(intent.baseFile.isFile)intent.openRead().bufferedReader().use {repository.json.parseToJsonElement(it.readText()).jsonObject} else JsonObject(emptyMap())
            if(saved["fileId"]?.jsonPrimitive?.contentOrNull!=imageId) {
                saved=buildJsonObject {put("fileId",imageId);put("key",UUID.randomUUID().toString())}
                val output=intent.startWrite();try{output.write(saved.toString().toByteArray());intent.finishWrite(output)}catch(failure:Exception){intent.failWrite(output);throw failure}
            }
            val result=repository.networkJson("POST","$prefix/page-images/prepare",buildJsonObject {
                put("sourceVersionId",sourceVersionId);put("expectedLifecycleVersion",lifecycle);put("analyze",false)
                put("images",buildJsonArray {add(buildJsonObject {put("pageNumber",pageNumber);put("fileId",imageId)})})
            },saved["key"]!!.jsonPrimitive.content,expectedOwner=owner,expectedEpoch=generation)
            assertOwner()
            check(result["jobId"]==null||result["jobId"]==JsonNull){"服务端意外创建了任务，请停止并检查服务配置"}
            check(result["accepted"]?.jsonPrimitive?.intOrNull==1){"扫描页登记结果无效，请刷新来源状态"}
            onProgress("扫描页 $pageNumber 已保存；尚未调用识别模型")
        }
    }}
    onProgress("扫描页图片已准备完成；请另行确认识别，未调用识别模型")
}

package cn.buwei.nativeapp.features

import android.net.Uri
import android.os.StatFs
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.media.AttachmentTransfer
import cn.buwei.nativeapp.media.DocumentReader
import cn.buwei.nativeapp.media.uploadMissingPdfImages
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

@Composable internal fun DataWorkspaceIntake(repository:ClientRepository,project:String,onCapture:()->Unit,onActivityChange:(Boolean)->Unit={},onCreated:(String,String)->Unit){
 val base=twBase(project);val scope=rememberCoroutineScope();val owner=repository.accountId;val epoch=repository.epoch;val drafts=remember(repository){NativeDraftStore(repository)};val draftKey="data-intake:$project"
 var method by rememberSaveable{mutableStateOf("material")};var title by rememberSaveable{mutableStateOf("")};var text by rememberSaveable{mutableStateOf("")};var url by rememberSaveable{mutableStateOf("")};var purpose by rememberSaveable{mutableStateOf("reference")};var file by remember{mutableStateOf<File?>(null)};var contributors by remember{mutableStateOf<List<String>>(listOfNotNull(owner))};var members by remember{mutableStateOf<List<JsonObject>>(emptyList())};var busy by remember{mutableStateOf(false)};var progress by remember{mutableStateOf("")};var error by remember{mutableStateOf<String?>(null)};var loaded by remember{mutableStateOf(false)};var confirm by remember{mutableStateOf(false)};var parseLocal by rememberSaveable{mutableStateOf(true)};var source by remember{mutableStateOf<JsonObject?>(null)};var processing by remember{mutableStateOf<Job?>(null)}
 LaunchedEffect(busy){onActivityChange(busy)};DisposableEffect(Unit){onDispose{onActivityChange(false)}}
 fun owned(){check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，资料导入已停止"}}
 fun record()=buildJsonObject{put("method",method);put("title",title);put("text",text);put("url",url);put("purpose",purpose);put("file",file?.path?.let{JsonPrimitive(it)}?:JsonNull);put("contributors",JsonArray(contributors.map{JsonPrimitive(it)}));put("source",source?:JsonNull);put("parseLocal",parseLocal)}
 LaunchedEffect(project,owner){try{drafts.read(draftKey)?.let{saved->method=saved.twText("method").ifBlank{"material"};title=saved.twText("title");text=saved.twText("text");url=saved.twText("url");purpose=saved.twText("purpose").ifBlank{"reference"};contributors=saved.twIds("contributors").ifEmpty{listOfNotNull(owner)};source=saved["source"] as? JsonObject;parseLocal=saved["parseLocal"]?.jsonPrimitive?.booleanOrNull?:true;val stored=saved.twText("file");if(stored.isNotBlank()){val selected=File(stored);val expected=File(repository.context.filesDir,"accounts/$owner/data-intake/$project").canonicalFile;require(selected.isFile&&selected.canonicalFile.parentFile==expected){"保留的本机原文件缺失，请重新选择"};file=selected}};members=taskWorkspaceMembers(repository,base);loaded=true}catch(e:CancellationException){throw e}catch(e:Exception){error="读取导入草稿失败：${e.message}；不会覆盖已有草稿。"}}
 LaunchedEffect(loaded,method,title,text,url,purpose,file,contributors,source,parseLocal){if(loaded)drafts.scheduleSave(draftKey,record(),onFailure={error="导入草稿无法保存：${it.message}"})}
 val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->if(uri!=null){busy=true;scope.launch{try{file=dataWorkspaceCopySaf(repository,project,uri);source=null;error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}}
 Text("新增资料",style=MaterialTheme.typography.titleLarge);Text("选择一种方式，原文件与固定版本会沿用现有项目数据。")
 if(!busy){TaskWorkspaceChoice("新增方式",listOf("material" to "成果文档","paste" to "粘贴文本","web" to "公开网页","file" to "文件"),method){method=it;source=null};OutlinedButton(onCapture){Text("录音 / 录像 / 拍照")}}
 TaskWorkspaceField("资料标题",title,{if(!busy)title=it},200);TaskWorkspaceChoice("资料用途",dataPurposes,purpose){if(!busy)purpose=it}
 when(method){"paste"->TaskWorkspaceField("来源原文",text,{if(!busy)text=it},100000,6);"web"->TaskWorkspaceField("公开网页地址",url,{if(!busy)url=it},2048);"file"->{OutlinedButton({picker.launch(arrayOf("*/*"))},enabled=!busy){Text(if(file==null)"选择来源文件"else"重新选择原文件")};file?.let{Text("${it.name.drop(37).ifBlank{it.name}} · ${it.length()/1024} KiB");if(it.extension.lowercase() in listOf("pdf","docx","xlsx","pptx"))Row{Checkbox(parseLocal,{checked->if(!busy)parseLocal=checked},enabled=!busy);Text("在本机提取正文（失败时保留原文件与已提交批次）")}};Text("文件贡献者（至少选择一名项目成员）");members.forEach{member->val id=member.twText("userId");Row{Checkbox(id in contributors,{checked->if(!busy)contributors=if(checked)contributors+id else contributors-id},enabled=!busy);Text(member.twText("displayName"))}}}}
 if(busy)LinearProgressIndicator();if(progress.isNotBlank())Text(progress);error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 val webValid=runCatching{val address=java.net.URI(url);address.scheme in listOf("http","https")&&!address.host.isNullOrBlank()}.getOrDefault(false)
 val valid=loaded&&!busy&&when(method){"material"->title.isNotBlank();"paste"->text.isNotBlank();"web"->webValid;"file"->file!=null&&contributors.isNotEmpty();else->false}
 Button({confirm=true},enabled=valid){Text(if(source!=null)"继续导入原文件正文"else"确认新增资料")}
 if(busy&&processing!=null)TextButton({processing?.cancel()}){Text("停止本机导入（保留原文件和已接收正文）")}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("新增资料？")},text={Text(if(method=="file")"上传所选文件并登记来源。现有后端会按项目配置自动处理文件，可能触发 AI 并产生费用。本机读取不调用模型；未完成的正文会明确标记。"else if(method=="web")"保存公开网页地址，稍后由你确认解析。网页可读取性由服务端规则决定。"else"将内容保存到当前项目，保留版本身份与历史引用。")},confirmButton={TextButton({confirm=false;busy=true;processing=scope.launch{try{owned();drafts.save(draftKey,record());val result=when(method){"material"->repository.requestDurably("data-create:$project","POST","$base/materials",buildJsonObject{put("title",title.trim());put("kind",if(purpose=="background")"background"else"document");put("purpose",purpose)});"file"->{val selected=file?:error("请重新选择原文件");val existing=source;val stored=if(existing!=null)existing else{val fileId=AttachmentTransfer(repository).upload(project,selected,{progress=it},purpose,contributors);owned();repository.requestDurably("data-source:$project:${selected.name}","POST","$base/sources",buildJsonObject{put("kind","file");put("title",title.trim().ifBlank{selected.name.drop(37).ifBlank{selected.name}}.take(200));put("fileId",fileId);put("purpose",purpose)}).also{source=it;drafts.save(draftKey,record())}};owned();if(parseLocal&&selected.extension.lowercase() in listOf("pdf","docx","xlsx","pptx")){dataWorkspaceImportDocument(repository,project,stored,selected){progress=it}};stored};else->repository.requestDurably("data-source:$project","POST","$base/sources",buildJsonObject{put("kind",method);if(title.isNotBlank())put("title",title.trim());put("purpose",purpose);if(method=="paste")put("text",text)else put("url",url.trim())})};owned();drafts.remove(draftKey);val type=if(method=="material")"material"else"source";onCreated(type,result.twText(if(type=="material")"materialId"else"sourceId"))}catch(e:CancellationException){progress="本机导入已停止，原文件和已接收正文保留。";throw e}catch(e:Exception){error="${e.message}；导入草稿与本机原文件已保留，请核对后继续。"}finally{busy=false;processing=null}}}){Text("确认新增")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}
internal suspend fun dataWorkspaceCopySaf(repository:ClientRepository,project:String,uri:Uri):File=withContext(Dispatchers.IO){
 val owner=repository.accountId?:error("请登录");val epoch=repository.epoch
 fun owned(){ensureActive();check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，本机文件复制停止"}}
 val name=repository.context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use{if(it.moveToFirst())it.getString(0)else null}?:"来源文件";val safe=name.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").take(150)
 val destination=File(repository.context.filesDir,"accounts/$owner/data-intake/$project/${UUID.randomUUID()}-$safe");destination.parentFile!!.mkdirs();val partial=File(destination.path+".partial")
 try{repository.context.contentResolver.openInputStream(uri)?.use{input->partial.outputStream().use{out->val bytes=ByteArray(65536);var total=0L;while(true){owned();val count=input.read(bytes);if(count<0)break;total+=count;require(total<=512L*1024*1024){"原文件超过本机预览版 512 MiB 导入限制"};check(StatFs(destination.parent!!).availableBytes>64L*1024*1024){"本机剩余空间不足"};out.write(bytes,0,count)}}}?:error("无法读取所选文件");owned();check(partial.renameTo(destination)){"本机原文件保存失败"};destination}finally{partial.delete()}
}
internal suspend fun dataWorkspaceImportDocument(repository:ClientRepository,project:String,source:JsonObject,file:File,onProgress:(String)->Unit):JsonObject{
 val owner=repository.accountId?:error("请登录");val epoch=repository.epoch;val base=twBase(project);val version=source.twText("sourceVersionId").ifBlank{source.twText("currentVersionId")};val extension=file.extension.lowercase();require(extension in listOf("pdf","docx","xlsx","pptx"))

 fun owned(){check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，正文导入停止"}}
 owned();dataWorkspaceGuardSource(repository,base,source,version)
 val init=repository.networkJson("POST","$base/document-imports",buildJsonObject{put("sourceVersionId",version);put("method","browser-$extension")});val path="$base/document-imports/${init.twText("sessionId")}";val status=repository.networkJson("GET",path)
 if(status.dataFlag("textReady")||status.twText("status")=="complete")return status
 val accepted=status["nextBatch"]?.jsonPrimitive?.int?:0;var batch=0
 val completion=try{val result=DocumentReader.read(repository.context,file){block->owned();if(batch>=accepted){repository.networkJson("POST","$path/batches",buildJsonObject{put("batchNumber",batch);put("blocks",buildJsonArray{add(buildJsonObject{put("seq",block.seq);put("pageNumber",block.page?.let{JsonPrimitive(it)}?:JsonNull);put("text",block.text);put("headingPath",JsonArray(block.headingPath.map{JsonPrimitive(it)}))})})})};batch++;onProgress("本机正文已核对 $batch 批（前 $accepted 批已由服务端确认）")};owned();repository.networkJson("POST","$path/complete",buildJsonObject{put("totalPages",result.pages?.let{JsonPrimitive(it)}?:JsonNull);put("warnings",JsonArray(result.warnings.take(100).map{JsonPrimitive(it.take(1000))}));put("partial",result.warnings.isNotEmpty());put("interrupted",false)})}catch(failure:Exception){if(owner==repository.accountId&&epoch==repository.epoch)withContext(NonCancellable){runCatching{withTimeout(5000){repository.networkJson("POST","$path/complete",buildJsonObject{put("totalPages",JsonNull);put("warnings",buildJsonArray{add("本机导入中断，原文件和已接收正文批次保留")});put("partial",true);put("interrupted",true)},expectedOwner=owner,expectedEpoch=epoch)}}};throw failure}
 if(extension=="pdf"&&(completion["needsImages"]?.jsonPrimitive?.intOrNull?:0)>0){owned();uploadMissingPdfImages(repository,project,source.twText("sourceId"),version,file,onProgress)}
 return completion
}

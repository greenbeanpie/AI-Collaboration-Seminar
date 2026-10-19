package cn.buwei.nativeapp.features

import android.os.ParcelFileDescriptor
import android.graphics.pdf.PdfRenderer
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.media.AttachmentTransfer
import cn.buwei.nativeapp.media.PdfImageLimits
import cn.buwei.nativeapp.media.renderPdfPageImage
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

internal suspend fun dataWorkspaceGuardSource(repository:ClientRepository,base:String,source:JsonObject,version:String){
 val current=repository.networkJson("GET","$base/sources/${source.twText("sourceId")}")
 require(current.twText("lifecycleVersion")==source.twText("lifecycleVersion")&&current.twText("currentVersionId")==version&&current.twText("deletedAt").isBlank()){ "来源版本或生命周期已变化，请刷新核对后继续" }
}
@Composable internal fun DataWorkspaceFileProcessing(repository:ClientRepository,project:String,fileId:String,fileName:String){
 val base=twBase(project);val path="$base/files/$fileId/processing";var expanded by remember{mutableStateOf(false)};OutlinedButton({expanded=!expanded}){Text("正文提取与文件处理")};if(!expanded)return
 var state by remember(fileId){mutableStateOf<JsonObject?>(null)};var refresh by remember{mutableIntStateOf(0)};var error by remember{mutableStateOf<String?>(null)};var job by remember{mutableStateOf<String?>(null)}
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 LaunchedEffect(path,refresh,lifecycle){lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED){while(isActive){
  try{val next=repository.networkJson("GET",path);check((next["lifecycleVersion"] as? JsonPrimitive)?.intOrNull?.let{it>0}==true){"文件处理状态缺少有效生命周期，请刷新核对"};state=next;error=null;if(!nativeFileProcessingActive(next))break}
  catch(e:CancellationException){throw e}catch(e:Exception){if(e.taskReadAccessDenied()){state=null;job=null};error=(e.message?:"读取失败")+if(state!=null)"；当前显示上次读取状态，请手动刷新核对。"else"";break}
  delay(2500L)
 }}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};state?.let{current->Text("正文：${dataStatus(current.twText("textStatus"))} · 总结：${dataStatus(current.twText("summaryStatus"))} · 要求：${dataStatus(current.twText("requirementsStatus"))}");if(current.twText("error").isNotBlank())Text(current.twText("error"),color=MaterialTheme.colorScheme.error);val running=nativeFileProcessingActive(current);val paused=nativeFileProcessingPaused(current);if(current.dataFlag("waitingForConcurrency"))Text("后台已排队等待并发名额，无需重复提交。")
 TaskWorkspaceAction(repository,"启动或继续文件处理",path,buildJsonObject{put("expectedLifecycleVersion",current["lifecycleVersion"]!!);put("retry",nativeFileProcessingRetry(current))},enabled=current.dataFlag("canProcess")&&!running&&!paused,confirmation="将依据当前文件状态继续正文、总结或要求处理。项目启用 AI 时可能调用模型并产生费用；原文件会保留。",onSuccess={state=it;job=it.twText("jobId").takeIf{v->v.isNotBlank()};refresh++})
 if(paused)Text("任务已暂停或等待补充，请在执行卡片或正文处理记录中继续。")
 current["concurrency"]?.jsonObject?.let{Text("当前项目 AI 并发：${it.twText("active")} / ${it.twText("limit")}")}
 val sourceId=current.twText("sourceId");val version=current.twText("sourceVersionId");if(sourceId.isNotBlank()&&version.isNotBlank()&&(current["needsImages"]?.jsonPrimitive?.intOrNull?:0)>0)DataWorkspaceScan(repository,project,sourceId,version,fileId,fileName,null){refresh++}
 };TextButton({refresh++}){Text("刷新文件处理状态")};(job?:state?.twText("jobId")?.takeIf{it.isNotBlank()})?.let{NativeJobExecution(repository,it,allowResume=state?.dataFlag("canProcess")==true){refresh++}}
}
@Composable internal fun DataWorkspaceSourceProcessing(repository:ClientRepository,project:String,source:JsonObject,version:JsonObject,onChanged:()->Unit){
 val base=twBase(project);val id=source.twText("sourceId");val versionId=version.twText("sourceVersionId");val path="$base/sources/$id/versions/$versionId/processing";var state by remember(versionId){mutableStateOf<JsonObject?>(null)};var refresh by remember{mutableIntStateOf(0)};var error by remember{mutableStateOf<String?>(null)};var job by remember{mutableStateOf<String?>(null)}
 val lifecycle=LocalLifecycleOwner.current.lifecycle
 LaunchedEffect(path,refresh,lifecycle){lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED){while(isActive){
  try{val next=repository.networkJson("GET",path);check((next["summaryRevision"] as? JsonPrimitive)?.intOrNull?.let{it>=0}==true){"来源处理状态缺少总结版本，请刷新核对"};state=next;error=null;if(!nativeSourceProcessingActive(next))break}
  catch(e:CancellationException){throw e}catch(e:Exception){if(e.taskReadAccessDenied()){state=null;job=null};error=(e.message?:"读取失败")+if(state!=null)"；当前显示上次读取状态，请手动刷新核对。"else"";break}
  delay(2500L)
 }}}
 Text("正文、要求与总结",style=MaterialTheme.typography.titleMedium);error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 state?.let{current->Text("正文：${dataStatus(current.twText("textStatus"))} · 要求：${dataStatus(current.twText("requirementsStatus"))} · 总结：${dataStatus(current.twText("summaryStatus"))}");listOf("requirementsError","summaryError").forEach{if(current.twText(it).isNotBlank())Text(current.twText(it),color=MaterialTheme.colorScheme.error)}
 val summary=current["summary"] as? JsonObject;summary?.let{Text(it.twText("title"),style=MaterialTheme.typography.titleMedium);NativeMarkdown(it.twText("summary"));it.twIds("keyPoints").forEach{point->Text("• $point")};it.twIds("caveats").forEach{note->Text("注意：$note")};Text("AI 总结供辅助核对，不能替代原文。");it.twRows("citations").forEach{cite->Text("${cite.twText("pageNumber").takeIf{p->p.isNotBlank()}?.let{p->"第 $p 页："}.orEmpty()}${cite.twText("quote")}")};if(current.twText("coveredChars").isNotBlank())Text("总结覆盖：${current.twText("coveredChars")} / ${current.twText("totalChars")} 个字符")}
 val running=current.twText("textStatus")=="processing";val lifecycleGuard:suspend(JsonObject)->JsonObject={body->dataWorkspaceGuardSource(repository,base,source,versionId);body}
 TaskWorkspaceAction(repository,"解析来源并提取要求","$base/sources/$id/parse",buildJsonObject{put("sourceVersionId",versionId)},enabled=!running,confirmation="将解析此固定版本，并可能调用 AI 进行 OCR、总结或要求提取，产生模型费用。",prepare=lifecycleGuard,onSuccess={job=it.twText("jobId").takeIf{v->v.isNotBlank()};refresh++;onChanged()})
 TaskWorkspaceAction(repository,"只提取正文","$base/document-imports/extract",buildJsonObject{put("sourceVersionId",versionId)},enabled=!running,confirmation="只请求正文提取，不生成要求。扫描件或音视频可能仍需配置的识别模型；本机读取不会产生模型费用。",prepare=lifecycleGuard,onSuccess={job=it.twText("jobId").takeIf{v->v.isNotBlank()};refresh++})
 TaskWorkspaceAction(repository,"依据完整正文生成要求","$base/document-imports/analyze",buildJsonObject{put("sourceVersionId",versionId)},enabled=current.twText("textStatus")=="ready",confirmation="将调用项目的 AI，可能产生费用。返回的要求仍需人工核对确认。",prepare=lifecycleGuard,onSuccess={job=it.twText("jobId").takeIf{v->v.isNotBlank()};refresh++})
 if(nativeSummaryCanStart(current))TaskWorkspaceAction(repository,"生成或重试文件总结","$path/summary",buildJsonObject{put("expectedSummaryRevision",current["summaryRevision"]!!)},enabled=current.twText("textStatus")=="ready"&&current.twText("summaryStatus") !in listOf("queued","running"),confirmation="将调用已配置的 AI 并产生用量；单独生成总结，不会重新上传、解析或重复 OCR。",prepare=lifecycleGuard,onSuccess={job=it.twText("jobId").takeIf{v->v.isNotBlank()};refresh++})
 val media=current["media"] as? JsonObject;media?.let{snapshot->
  Text("音视频处理：${dataStatus(snapshot.twText("stage"))} · 已完成 ${snapshot.twText("completedWindows")} 个时间窗口")
  if(snapshot.twText("error").isNotBlank())Text(snapshot.twText("error"),color=MaterialTheme.colorScheme.error)
  (snapshot["audio"] as? JsonObject)?.let{audio->
   NativeAudioPipelineStatus(audio)
   if(audio.twText("phase")=="waiting_config"){
    val mediaJob=snapshot.twText("jobId")
    TaskWorkspaceAction(repository,"继续 Gemini 音频回退","$path/media-resume",buildJsonObject{put("jobId",mediaJob)},enabled=audio.dataFlag("canResumeFallback")&&mediaJob.isNotBlank(),confirmation="将继续原音频任务的 Gemini 回退，可能产生模型费用，不重复转录。",prepare=lifecycleGuard,onSuccess={refresh++})
    if(!audio.dataFlag("canResumeFallback"))Text("当前配置或任务状态尚不允许回退，请核对配置后刷新。")
   }
  }
  (snapshot["summary"] as? JsonObject)?.let{NativeMediaSummaryContent(it)}
 }

 (listOf("processingJobId","summaryJobId").map{current.twText(it)}+listOfNotNull(media?.twText("jobId"))).filter{it.isNotBlank()}.distinct().forEach{currentJob->NativeJobExecution(repository,currentJob){refresh++;onChanged()}}
 }
 job?.let{NativeJobExecution(repository,it){refresh++;onChanged()}};TextButton({refresh++}){Text("刷新正文与总结状态")}
 val fileId=source.twText("fileId");if(state!=null&&fileId.isNotBlank()&&version.twText("pageCount").isNotBlank())DataWorkspaceScan(repository,project,id,versionId,fileId,source.twText("title"),version){refresh++;onChanged()}
}
@Composable internal fun DataWorkspaceScan(repository:ClientRepository,project:String,sourceId:String,versionId:String,fileId:String,fileName:String,version:JsonObject?,onChanged:()->Unit){
 val base=twBase(project);var open by remember{mutableStateOf(false)};OutlinedButton({open=!open}){Text("补充扫描页识别或确认空白")};if(!open)return
 var pages by remember{mutableStateOf<List<JsonObject>>(version?.twRows("pages").orEmpty())};var selected by remember{mutableStateOf<List<Int>>(emptyList())};var busy by remember{mutableStateOf(false)};var confirm by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var progress by remember{mutableStateOf("")};var source by remember{mutableStateOf<JsonObject?>(null)};val scope=rememberCoroutineScope()
 LaunchedEffect(sourceId,versionId){try{source=repository.networkJson("GET","$base/sources/$sourceId");if(version==null)pages=repository.get("$base/sources/$sourceId/versions/$versionId").twRows("pages")}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 Text("请核对实际页面后选择。扫描页 OCR 可能产生费用；确认空白不调用模型。")
 pages.forEach{page->val number=page["pageNumber"]!!.jsonPrimitive.int;Row{Checkbox(number in selected,{checked->if(!busy)selected=if(checked)selected+number else selected-number},enabled=!busy);Text("第 $number 页 · ${mapOf("extracted" to "有文本层","empty" to "已确认空白","none" to "待提取")[page.twText("textStatus")].orEmpty()} · ${mapOf("ok" to "OCR 已识别","failed" to "OCR 失败","pending" to "OCR 处理中")[page.twText("ocrStatus")].orEmpty()}",Modifier.padding(top=12.dp))}}
 val requested=selected.sorted();TaskWorkspaceAction(repository,"确认选定页为空白","$base/document-imports/blank-pages",buildJsonObject{put("sourceVersionId",versionId);put("pages",JsonArray(requested.take(100).map{JsonPrimitive(it)}))},enabled=!busy&&requested.size in 1..100&&source!=null,confirmation="已逐页核对所选页面没有应提取的正文？此操作不会调用 OCR 模型。",prepare={body->dataWorkspaceGuardSource(repository,base,source!!,versionId);body},onSuccess={selected=emptyList();onChanged()})
 OutlinedButton({confirm=true},enabled=!busy&&requested.size in 1..100&&source!=null){Text("对选定页补充 OCR")};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());if(progress.isNotBlank())Text(progress);error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("补充 OCR？")},text={Text("将下载保留的原 PDF，在本机渲染选定 ${requested.size} 页并上传，随后调用识别模型。可能产生费用，请保持页面打开。")},confirmButton={TextButton({confirm=false;busy=true;scope.launch{try{dataWorkspaceOcr(repository,project,source!!,versionId,fileId,fileName,requested){progress=it};selected=emptyList();onChanged()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("确认识别")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}
internal suspend fun dataWorkspaceOcr(repository:ClientRepository,project:String,source:JsonObject,version:String,fileId:String,fileName:String,pages:List<Int>,progress:(String)->Unit)=withContext(Dispatchers.IO){
 require(pages.isNotEmpty()&&pages.size<=100&&pages.all{it>0}){"请选择 1 至 100 个真实页码"};val owner=repository.accountId?:error("请登录");val epoch=repository.epoch;val base=twBase(project)
 fun owned(){ensureActive();check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，OCR 准备已停止"}}
 dataWorkspaceGuardSource(repository,base,source,version);require(source.twText("fileId")==fileId){"来源原文件已变化，请刷新核对"};val original=repository.networkJson("GET","$base/sources/${source.twText("sourceId")}/versions/$version",expectedOwner=owner,expectedEpoch=epoch);require(original.twText("fileId")==fileId&&original.twText("sourceVersionId")==version){"固定版本的原文件不匹配，请刷新核对"};val capability=repository.get("/api/v1/capabilities")["limits"]!!.jsonObject;val limits=PdfImageLimits(capability["pageImageMaxEdge"]!!.jsonPrimitive.int,capability["pageImageMaxBytes"]!!.jsonPrimitive.int,capability["maxPdfPages"]?.jsonPrimitive?.intOrNull)
 val directory=File(repository.context.filesDir,"accounts/$owner/scan-pages/$project/${source.twText("sourceId")}/$version-${source.twText("lifecycleVersion")}").apply{mkdirs()};val pdf=File(directory,"original.pdf");repository.download("$base/files/$fileId/content",pdf);owned()
 ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY).use{descriptor->PdfRenderer(descriptor).use{document->require(pages.all{it<=document.pageCount}){"页码超出原文件范围"};for(number in pages.distinct().sorted()){owned();dataWorkspaceGuardSource(repository,base,source,version);progress("正在渲染第 $number 页：$fileName");val image=File(directory,"page-$number.jpg");document.openPage(number-1).use{renderPdfPageImage(it,limits,image,::owned)};val imageId=AttachmentTransfer(repository).upload(project,image,progress,"reference",null,fileId);owned();dataWorkspaceGuardSource(repository,base,source,version);repository.requestDurably("source-ocr:$version:$number","POST","$base/sources/${source.twText("sourceId")}/page-images",buildJsonObject{put("sourceVersionId",version);put("analyze",false);put("images",buildJsonArray{add(buildJsonObject{put("pageNumber",number);put("fileId",imageId)})})});owned();progress("第 $number 页已提交 OCR；识别结果需要人工复核")}}}
}

package cn.buwei.nativeapp.media

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.features.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Read the server recording bound to the current material; media remains behind normal file authorization. */
@Composable internal fun NativeRecordingDetail(repository:ClientRepository,projectId:String,materialId:String,onNavigate:((String)->Unit)?=null){
 val account by repository.account.collectAsState()
 key(projectId,materialId,account?.text("id"),repository.epoch){NativeRecordingDetailContent(repository,projectId,materialId,onNavigate?:LocalNativeContentNavigation.current)}
}
@Composable private fun NativeRecordingDetailContent(repository:ClientRepository,projectId:String,materialId:String,onNavigate:((String)->Unit)?){
 val owner=repository.accountId;val epoch=repository.epoch;val base="/api/v1/projects/${Uri.encode(projectId)}/recording-sessions"
 val scope=rememberCoroutineScope();val lock=remember{Mutex()};val lifecycle=LocalLifecycleOwner.current.lifecycle
 var sessions by remember{mutableStateOf<List<JsonObject>>(emptyList())};var listCursor by remember{mutableStateOf<String?>(null)}
 var selected by remember{mutableStateOf<String?>(null)};var detail by remember{mutableStateOf<JsonObject?>(null)}
 var cursor by remember{mutableStateOf<String?>(null)};var seen by remember{mutableStateOf<Set<String>>(emptySet())}
 var busy by remember{mutableStateOf(false)};var retrying by remember{mutableStateOf(false)};var denied by remember{mutableStateOf(false)}
 var stale by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirm by remember{mutableStateOf(false)}
 fun owned(){check(owner!=null&&owner==repository.accountId&&epoch==repository.epoch){"账户已变化，录制读取已停止"}}
 fun failure(e:Exception){
  if(e is ApiException&&e.status in listOf(401,403,404)){sessions=emptyList();selected=null;detail=null;cursor=null;listCursor=null;seen=emptySet();denied=true;stale=false}
  else stale=detail!=null
  error=e.message?:"录制详情读取失败"
 }
 suspend fun get(path:String):JsonObject{owned();return repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch).also{owned()}}
 suspend fun readSessions(more:Boolean=false){
  val previous=if(more)listCursor else null
  val page=get("$base?materialId=${Uri.encode(materialId)}&limit=20"+(previous?.let{"&cursor=${Uri.encode(it)}"}?:""))
  check(page["items"] is JsonArray){"录制列表响应缺少items"}
  val next=page.text("nextCursor").takeIf{it.isNotBlank()};check(next==null||next!=previous){"录制列表分页未前进"}
  sessions=((if(more)sessions else emptyList())+page.rows()).distinctBy{it.text("sessionId")};listCursor=next
  if(selected !in sessions.map{it.text("sessionId")})selected=sessions.firstOrNull()?.text("sessionId")
  denied=false
 }
 suspend fun readDetail(more:Boolean=false,keepLoaded:Boolean=false){
  val id=selected?:return;val previous=if(more)cursor else null
  val result=get("$base/${Uri.encode(id)}?limit=50"+(previous?.let{"&cursor=${Uri.encode(it)}"}?:""))
  check(result.text("sessionId")==id&&result.text("materialId")==materialId&&result["segments"] is JsonArray){"录制详情身份或片段响应不一致"}
  val next=result.text("nextCursor").takeIf{it.isNotBlank()}
  if(!keepLoaded)check(next==null||(next!=previous&&(!more||next !in seen))){"录制片段分页未前进"}
  val segments=if(more||keepLoaded)(detail?.rows("segments").orEmpty()+result.rows("segments")).associateBy{it.text("sequence")}.values.sortedBy{it["sequence"]?.jsonPrimitive?.intOrNull?:0}else result.rows("segments")
  detail=JsonObject(result+("segments" to JsonArray(segments)))
  if(!keepLoaded){cursor=next;seen=if(more)seen+listOfNotNull(previous)else emptySet()}
  denied=false;stale=false;error=null
 }
 fun readAction(block:suspend()->Unit){if(busy||retrying)return;busy=true;scope.launch{try{lock.withLock{block()}}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{busy=false}}}
 LaunchedEffect(Unit){busy=true;try{lock.withLock{readSessions()}}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{busy=false}}
 LaunchedEffect(selected){if(selected!=null){detail=null;cursor=null;seen=emptySet();busy=true;try{lock.withLock{readDetail()}}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{busy=false}}}
 val processing=detail?.text("processingStatus") in listOf("pending","running")
 LaunchedEffect(selected,processing,lifecycle){if(selected!=null&&processing)lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED){while(isActive){delay(5000);try{lock.withLock{readDetail(keepLoaded=true)}}catch(e:CancellationException){throw e}catch(e:Exception){failure(e);break}}}}
 if(sessions.isEmpty()&&error==null&&!busy)return
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("会议片段与摘要",style=MaterialTheme.typography.titleLarge)
  if(busy||retrying)LinearProgressIndicator(Modifier.fillMaxWidth())
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  if(denied)Text("录制访问权限已变化，服务端内容已清除。")
  if(stale)Text("当前显示上次读取的录制快照；网络读取失败，请刷新核对状态。")
  TextButton({readAction{val before=selected;readSessions();if(selected!=null&&selected==before)readDetail()}},enabled=!busy&&!retrying){Text("刷新会议录制")}
  sessions.forEach{session->if(sessions.size>1)OutlinedButton({selected=session.text("sessionId")},enabled=!busy&&!retrying){Text(session.text("title"))}}
  if(listCursor!=null)OutlinedButton({readAction{readSessions(true)}},enabled=!busy&&!retrying&&!denied){Text("加载更多录制会话")}
  detail?.let{current->
   Text(current.text("title"),style=MaterialTheme.typography.titleMedium)
   Text("${recordingStatus(current.text("status"))} · ${recordingStatus(current.text("processingStatus"))} · 摘要版本 ${current.text("summaryRevision")}")
   if(current.text("summaryMarkdown").isNotBlank())NativeMarkdown(current.text("summaryMarkdown"),onNavigate)
   current.rows("interruptions").forEach{Text("${recordingTime(it,"startMs")}–${recordingTime(it,"endMs")} 秒：${it.text("reason")}")}
   current.rows("segments").forEach{segment->key(segment.text("sequence")){
    OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
     Text("第 ${segment.text("sequence")} 段 · ${recordingTime(segment,"startMs")}–${recordingTime(segment,"endMs")} 秒 · ${recordingStatus(segment.text("status"))}")
     if(segment.text("error").isNotBlank())Text(segment.text("error"),color=MaterialTheme.colorScheme.error)
     val href="/app/projects/$projectId/data?resourceType=source&resourceId=${Uri.encode(segment.text("sourceId"))}&sourceVersionId=${Uri.encode(segment.text("sourceVersionId"))}"
     if(onNavigate!=null)TextButton({onNavigate(href)}){Text("查看第 ${segment.text("sequence")} 段固定来源与处理结果")}
     if(segment.text("status") !in listOf("unavailable","archived")){
      RecordingSegmentAttachment(repository,projectId,segment,onDenied=::failure)
     }else Text("原片段不可用或已归档；固定引用保留。")
    }}
   }}
   if(cursor!=null)OutlinedButton({readAction{readDetail(more=true)}},enabled=!busy&&!retrying&&!denied){Text("加载更多会议片段")}
   OutlinedButton({confirm=true},enabled=!busy&&!retrying&&!denied&&!stale&&current.text("status")=="complete"&&current.text("processingStatus") !in listOf("pending","running")){Text("重试会议处理")}
  }
 }
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("重试会议处理？")},text={Text("此操作可能重新转写、识别或生成摘要并产生模型用量。仅录制创建者可执行；不会自动重复提交。")},confirmButton={TextButton({
  confirm=false;if(!retrying&&!busy){retrying=true;scope.launch{try{lock.withLock{
   readDetail(keepLoaded=true);owned();check(!denied&&!stale&&detail?.text("status")=="complete"&&detail?.text("processingStatus") !in listOf("pending","running")){"录制状态已变化，请刷新核对"}
   val id=selected?:error("录制已不可用");repository.requestDurably("recording-retry:$id","POST","$base/${Uri.encode(id)}/retry");owned();readDetail(keepLoaded=true)
  }}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{retrying=false}}}
 }){Text("确认重试")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}
/** Resolve the original filename instead of inventing an extension from audio/video/photo kind. */
@Composable private fun RecordingSegmentAttachment(repository:ClientRepository,projectId:String,segment:JsonObject,onDenied:(Exception)->Unit){
 val owner=repository.accountId;val epoch=repository.epoch;val scope=rememberCoroutineScope()
 var name by remember(segment.text("fileId")){mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
 if(name==null)OutlinedButton({if(!busy){busy=true;scope.launch{try{
  val id=segment.text("fileId");val page=repository.networkJson("GET","/api/v1/projects/${Uri.encode(projectId)}/files?fileId=${Uri.encode(id)}&limit=1",expectedOwner=owner,expectedEpoch=epoch)
  check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"}
  val file=page.rows().singleOrNull{it.text("fileId")==id}?:error("片段原文件当前不可用")
  check(file.text("status")=="available"&&file.text("deletedAt").isBlank()&&file.text("archivedAt").isBlank()){"片段原文件不可用或已归档"}
  name=file.text("name").takeIf{it.isNotBlank()}?:error("服务端未提供原文件名称")
 }catch(e:CancellationException){throw e}catch(e:Exception){if(e is ApiException&&e.status in listOf(401,403,404))onDenied(e)else error=e.message}finally{busy=false}}}},enabled=!busy){Text(if(busy)"正在读取片段文件信息"else"读取第 ${segment.text("sequence")} 段原文件")}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 name?.let{Text("原文件：$it");AttachmentActions(repository,projectId,segment.text("fileId"),it)}
}
private fun recordingStatus(value:String)=mapOf("pending" to "待处理","running" to "处理中","ready" to "已完成","partial" to "部分完成","unconfigured" to "未配置识别模型，原文件已保存","failed" to "处理失败","uploading" to "上传未完成","complete" to "原文件已保存","archived" to "已归档","unavailable" to "原文件不可用","cancelled" to "已停止")[value]?:value
private fun recordingTime(row:JsonObject,key:String)=((row[key]?.jsonPrimitive?.longOrNull?:0)/1000.0).toString()

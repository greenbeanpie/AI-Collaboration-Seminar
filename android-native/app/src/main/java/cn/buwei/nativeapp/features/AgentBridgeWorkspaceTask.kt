package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.media.AttachmentActions
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun TaskBridgeWorkspace(repository:ClientRepository,projectId:String,taskId:String){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope();val preferences=remember(repository){NativeDraftStore(repository)}
 val taskPath="/api/v1/projects/$projectId/tasks/$taskId";val eligibilityPath="/api/v1/projects/$projectId/collaboration/tasks/$taskId/agent-eligibility";val handoffsPath="$bridgeBase/projects/$projectId/tasks/$taskId/handoffs"
 var task by remember(owner,taskId){mutableStateOf<JsonObject?>(null)};var eligibility by remember(owner,taskId){mutableStateOf<JsonObject?>(null)};var devices by remember(owner,projectId){mutableStateOf<List<JsonObject>>(emptyList())};var handoffs by remember(owner,taskId){mutableStateOf<List<JsonObject>>(emptyList())};var selectedDevice by remember(owner,projectId){mutableStateOf("")};var selectedHandoff by remember(owner,taskId){mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirmation by remember{mutableStateOf<String?>(null)};var reviewed by remember(owner,taskId,selectedHandoff,task?.text("revision")){mutableStateOf(false)};var submitted by remember(owner,taskId){mutableStateOf(false)}
 val current=handoffs.firstOrNull{it.text("handoffId")==selectedHandoff}?:handoffs.firstOrNull()
 suspend fun get(path:String)=repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)
 suspend fun reload(){check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};val latestTask=get(taskPath);val latestEligibility=get(eligibilityPath);val latestDevices=(get("$bridgeBase/devices")["items"]as? JsonArray).orEmpty().map{it.jsonObject};val latestHandoffs=(get(handoffsPath)["items"]as? JsonArray).orEmpty().map{it.jsonObject};task=latestTask;eligibility=latestEligibility;devices=latestDevices;handoffs=latestHandoffs}
 fun action(block:suspend ()->Unit){busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"操作失败")+"；结果不明确时先刷新核对，客户端不会自动重复执行。"}finally{busy=false}}}
 LaunchedEffect(owner,projectId,taskId){try{selectedDevice=preferences.read("bridge-preference:$projectId")?.text("deviceId").orEmpty();reload()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 LaunchedEffect(current?.text("handoffId"),current?.text("updatedAt")){reviewed=false}
 val pending=eligibility?.text("status")in listOf("queued","running")||handoffs.any(::bridgeActive)
 LaunchedEffect(owner,taskId,pending){if(pending)while(isActive){delay(3000);try{reload();if(eligibility?.text("status")!in listOf("queued","running")&&!handoffs.any(::bridgeActive))break}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break}}}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("本地 Agent 代实施",style=MaterialTheme.typography.titleLarge);Text("DSH 使用已配置模型执行任务，成果回传为待核对草稿，由任务执行人确认后提交验收。")
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  OutlinedButton({action{reload()}},enabled=!busy){Text("刷新设备、适用性及交接")}
  task?.let{latest->
   Text("任务：${latest.text("title")} · 版本 ${latest.text("revision")}")
   Text("适用性："+when(eligibility?.text("status")){"missing"->"尚未检查";"queued","running"->"正在判断";"ready"->if(bridgeEligible(eligibility,latest))"可交给 Agent 执行"else"暂不适合代实施";"disabled"->"AI 服务不可用";"failed"->"检查失败";else->"尚未读取"})
   eligibility?.text("reason")?.takeIf{it.isNotBlank()}?.let{Text(it)}
   if(eligibility?.get("taskRevision")!=latest["revision"])Text("任务版本已变化，需检查最新版本。")
   OutlinedButton({confirmation="eligibility"},enabled=!busy&&eligibility?.text("status")!in listOf("queued","running")){Text(if(eligibility?.text("status")=="failed")"重试适用性判断（AI）"else"检查任务适用性（AI）")}
   val bound=devices.filter{bridgeBound(it,projectId)}
   if(bound.isEmpty())Text("尚无已授权并绑定项目目录的 DSH。请在设置的“本地 Agent”完成连接，并在 DSH 选择工作目录。")
   bound.forEach{device->FilterChip(selectedDevice==device.text("deviceId"),{selectedDevice=device.text("deviceId");preferences.scheduleSave("bridge-preference:$projectId",buildJsonObject{put("deviceId",selectedDevice)},owner?:error("请登录"),epoch){error=it.message}},label={Text(device.text("deviceName"))})}
   val active=handoffs.any(::bridgeActive)
   Button({confirmation="dispatch"},enabled=!busy&&error==null&&bridgeEligible(eligibility,latest)&&bound.any{it.text("deviceId")==selectedDevice}&&!active){Text(if(handoffs.isEmpty())"交给 DSH 代实施"else"重新交给 DSH 代实施")}
   if(active)Text("已有未结束交接，请先核对当前状态，勿重复执行。")
   if(handoffs.size>1){Text("交接历史");handoffs.forEachIndexed{index,item->TextButton({selectedHandoff=item.text("handoffId");reviewed=false;submitted=false}){Text("第 ${handoffs.size-index} 次 · ${bridgeStateLabel(item.text("state"))} · ${item.text("createdAt")}")}}}
   current?.let{item->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
    Text(bridgeStateLabel(item.text("state")),style=MaterialTheme.typography.titleMedium)
    if(item.text("state")!in listOf("blocked","checking"))item.text("reason").takeIf{it.isNotBlank()}?.let{Text(it)}
    if(item.text("state")=="waiting_input")Text("审批和补充输入需在当前 DSH 会话中完成。处理后回到此处刷新；安卓端不会代替设备提交审批或输入。")
    if(item.text("state")=="dispatch_uncertain")Text("执行状态未知，请在 DSH 核对已有会话；连接恢复后按原交接核对，不要重新执行。")
    if(item.text("state")=="waiting_device")Text("保持 DSH 打开；关闭期间任务等待，重新打开后恢复接收。")
    if(bridgeActive(item)&&item.text("state")!="cancel_requested")OutlinedButton({confirmation="cancel:${item.text("handoffId")}"},enabled=!busy){Text("取消交接")}
    val stale=item["stale"]?.jsonPrimitive?.booleanOrNull==true||item["taskRevision"]!=latest["revision"]
    if(stale)Text("任务已更新，旧版本成果可查看但不能直接提交。",color=MaterialTheme.colorScheme.error)
    val result=item["result"]as? JsonObject
    result?.let{outcome->Text("成果说明",style=MaterialTheme.typography.titleSmall);androidx.compose.foundation.text.selection.SelectionContainer{Text(outcome.text("summary"))};(outcome["artifacts"]as? JsonArray).orEmpty().forEach{artifact->val file=artifact.jsonObject;Text("${file.text("name")} · ${file.text("sizeBytes")} 字节");AttachmentActions(repository,projectId,file.text("fileId"),file.text("name"))}}
    if(item.text("state")=="ready_for_review"){
     val adopted=item.text("adoptedSubmissionId").isNotBlank()||submitted;val assignee=latest.text("assigneeId")==owner
     if(!assignee)Text("仅当前任务执行人可提交，请先在任务页认领。")
     Row{Checkbox(reviewed,{reviewed=it},enabled=!busy&&!stale&&!adopted&&assignee&&result!=null);Text("我已核对成果说明及全部文件")}
     Button({confirmation="adopt:${item.text("handoffId")}"},enabled=!busy&&error==null&&reviewed&&!stale&&!adopted&&assignee&&result!=null){Text(if(adopted)"已提交验收"else"采纳并提交验收")}
    }
   }}}
  }
 }
 confirmation?.let{chosen->AlertDialog(onDismissRequest={confirmation=null},title={Text(when{chosen=="eligibility"->"调用 AI 判断适用性？";chosen=="dispatch"->"交给所选 DSH 执行？";chosen.startsWith("adopt:")->"采纳已核对成果并提交验收？";else->"取消当前交接？"})},text={Text(when{chosen=="eligibility"->"使用现有后端 AI 配置，可能产生模型费用；只执行本次明确请求。";chosen=="dispatch"->"所选设备将读取当前任务授权输入并使用其模型执行，可能产生费用。不会自动采纳成果。";chosen.startsWith("adopt:")->"将已核对说明及成果文件按当前任务版本提交验收。";else->"运行中的设备需要确认取消；在其确认之前仍显示等待取消。"})},confirmButton={TextButton({confirmation=null;action{
  when{
   chosen=="eligibility"->{val latest=get(taskPath);task=latest;eligibility=repository.requestDurably("bridge-eligibility","POST",eligibilityPath,buildJsonObject{put("expectedRevision",latest["revision"]!!);if(eligibility?.text("status")=="failed")put("retry",true)})}
   chosen=="dispatch"->{val latest=get(taskPath);val ready=get(eligibilityPath);check(bridgeEligible(ready,latest)){"当前任务适用性未就绪或版本已变化"};val next=repository.requestDurably("bridge","POST",handoffsPath,buildJsonObject{put("expectedRevision",latest["revision"]!!);put("targetDeviceId",selectedDevice)});selectedHandoff=next.text("handoffId");reviewed=false;submitted=false;reload()}
   chosen.startsWith("cancel:")->{repository.requestDurably("bridge","POST","$bridgeBase/handoffs/${chosen.substringAfter(':')}/cancel",JsonObject(emptyMap()));reload()}
   chosen.startsWith("adopt:")->{val id=chosen.substringAfter(':');val latest=get(taskPath);val item=get("$bridgeBase/handoffs/$id");val body=bridgeAdoptionBody(item,latest,owner?:error("请登录"),reviewed);repository.requestDurably("bridge","POST","$bridgeBase/handoffs/$id/adopt-and-submit",body);reviewed=false;submitted=true;reload()}
  }
 }}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})}
}



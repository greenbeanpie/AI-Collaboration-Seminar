package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

/** Persistent server draft → editable preview → explicitly confirmed project commit. */
@Composable
fun ProjectCreationScreen(repository:ClientRepository,onProject:(String)->Unit){
 val scope=rememberCoroutineScope();val schema=remember{NativeContracts.operations.first{it.method=="POST"&&it.path=="/api/v1/creation-drafts"}.schema}
 var payloadText by rememberSaveable(repository.accountId){mutableStateOf(buildJsonObject{put("name","");put("description","");put("aiCollaborationEnabled",false);listOf("planningMode","assignmentMode","evaluationMode","progressionMode").forEach{put(it,"manual")};put("teamSize",1)}.toString())};val payload=remember(payloadText){Json.parseToJsonElement(payloadText).jsonObject}
 var draft by remember{mutableStateOf<JsonObject?>(null)};var drafts by remember{mutableStateOf<List<JsonObject>>(emptyList())};var templates by remember{mutableStateOf<List<JsonObject>>(emptyList())};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirmation by remember{mutableStateOf<String?>(null)};var editPreview by remember{mutableStateOf<JsonObject?>(null)};var result by remember{mutableStateOf<JsonObject?>(null)};var refresh by remember{mutableIntStateOf(0)}
 val intentKeys=remember(payloadText,draft?.text("revision")){mutableMapOf<String,String>()}
 fun draftPath()="/api/v1/creation-drafts/${Uri.encode(draft?.text("id").orEmpty())}"
 suspend fun reload(){draft=repository.get(draftPath());editPreview=draft?.get("preview")as? JsonObject}
 LaunchedEffect(repository.accountId,refresh){try{drafts=(repository.get("/api/v1/creation-drafts")["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};templates=(repository.get("/api/v1/project-templates")["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 val waiting=draft?.text("previewState")in listOf("queued","running","processing")||draft?.obj("execution")?.text("state")=="running"
 LaunchedEffect(draft?.text("id"),waiting){if(waiting)while(isActive){delay(3000L);try{reload();if(draft?.obj("execution")?.text("state")!="running"&&draft?.text("previewState")!in listOf("queued","running","processing"))break}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break}}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("创建项目",style=MaterialTheme.typography.headlineSmall)
  Text("1. 项目信息 → 2. 预览任务 → 3. 确认创建",style=MaterialTheme.typography.bodySmall)
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  if(result!=null){Text("项目已创建",style=MaterialTheme.typography.titleLarge);StructuredValue(result!!);Button({onProject(result!!.text("projectId"))}){Text("进入项目")};return@Column}
  if(draft==null){
   if(drafts.isNotEmpty()){Text("继续创建草稿",style=MaterialTheme.typography.titleMedium);drafts.filter{it.text("status")=="active"}.take(20).forEach{existing->OutlinedButton({busy=true;scope.launch{try{draft=repository.get("/api/v1/creation-drafts/${Uri.encode(existing.text("id"))}");payloadText=draft!!.obj("payload").toString();editPreview=draft!!["preview"]as? JsonObject}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text(existing.obj("payload").text("name").ifBlank{existing.text("name").ifBlank{"草稿 ${existing.text("updatedAt")}"}})}}}
   if(templates.isNotEmpty()){Text("从模板开始",style=MaterialTheme.typography.titleMedium);templates.forEach{template->OutlinedButton({busy=true;scope.launch{try{draft=repository.request("POST","/api/v1/creation-drafts/from-template",buildJsonObject{put("templateId",template.text("templateId"))},UUID.randomUUID().toString());payloadText=draft!!.obj("payload").toString();editPreview=draft!!["preview"]as? JsonObject}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text(template.text("name"))}}}
  }else{Text("草稿版本 ${draft!!.text("revision")} · ${draft!!.text("status")}",style=MaterialTheme.typography.labelMedium);Row{TextButton({busy=true;scope.launch{try{reload();payloadText=draft!!.obj("payload").toString()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("重新读取草稿")};TextButton({confirmation="cancel"},enabled=!busy&&!waiting){Text("取消草稿")}}}
  SchemaField("项目信息",schema,payload,true){payloadText=(it as? JsonObject?:payload).toString()}
  Button({error=validate(schema,payload);if(error==null)confirmation="save"},enabled=!busy&&!waiting){Text(if(draft==null)"保存创建草稿"else"保存项目信息")}
  draft?.let{current->
   val dirty=current.obj("payload")!=payload
   if(dirty)Text("请先保存修改，再生成预览。",style=MaterialTheme.typography.bodySmall)
   Text("任务预览",style=MaterialTheme.typography.titleLarge)
   current.obj("activity").let{activity->activityProgress(activity)?.let{Text(it)}}
   current.text("previewError").takeIf{it.isNotBlank()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
   val previewSchema=NativeContracts.operations.first{it.method=="POST"&&it.path=="/api/v1/creation-drafts/{draftId}/preview"}.schema.obj("properties")
   val taskSchema=previewSchema.obj("tasks")
   var manualTasks by remember(current.text("id")){mutableStateOf<JsonElement>(current.obj("preview")["tasks"]?:JsonArray(emptyList()))}
   SchemaField("tasks",taskSchema,manualTasks,true){manualTasks=it?:JsonArray(emptyList())}
   Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
    OutlinedButton({editPreview=buildJsonObject{put("tasks",manualTasks);payload["goal"]?.let{put("goal",it)}};confirmation="manual"},enabled=!busy&&!dirty&&!waiting){Text("生成手动预览")}
    OutlinedButton({confirmation="ai"},enabled=!busy&&!dirty&&!waiting){Text("AI 规划预览")}
   }
   editPreview?.let{preview->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){Text("待确认预览",style=MaterialTheme.typography.titleMedium);StructuredValue(preview)}}}
   val currentPreview=current["preview"]as? JsonObject
   if(currentPreview!=null&&!dirty&&!waiting){Button({confirmation="commit"},enabled=!busy){Text("确认预览并创建项目")}}
  }
 }
 if(confirmation!=null)AlertDialog(onDismissRequest={confirmation=null},title={Text(when(confirmation){"ai"->"使用 AI 生成规划？";"commit"->"按当前预览创建项目？";"cancel"->"取消创建草稿？";else->"保存操作？"})},text={Text(when(confirmation){"ai"->"将调用现有项目 AI 配置，可能产生费用。结果不明确时先刷新核对，不自动重复生成。";"commit"->"将创建项目、任务和已确认的初始资料。请核对预览及协作模式。";"cancel"->"草稿将标记为已取消。";else->"保存到当前账户的服务端草稿。"})},confirmButton={TextButton({val chosen=confirmation!!;val intentKey=intentKeys.getOrPut(chosen+editPreview.toString()){UUID.randomUUID().toString()};confirmation=null;busy=true;error=null;scope.launch{try{
  when(chosen){
   "save"->{draft=if(draft==null)repository.request("POST","/api/v1/creation-drafts",payload,intentKey)else repository.request("PATCH",draftPath(),buildJsonObject{put("expectedRevision",draft!!["revision"]!!);put("payload",payload)},intentKey);payloadText=draft!!.obj("payload").toString()}
   "manual","ai"->{val response=repository.request("POST",draftPath()+"/preview",buildJsonObject{put("expectedRevision",draft!!["revision"]!!);put("mode",if(chosen=="ai")"ai"else"manual");put("background",true);if(chosen=="manual"){put("tasks",editPreview?.get("tasks")?:JsonArray(emptyList()));payload["goal"]?.let{put("goal",it)}}},intentKey);draft=response;editPreview=response["preview"]as? JsonObject}
   "commit"->{result=repository.request("POST",draftPath()+"/commit",buildJsonObject{put("expectedRevision",draft!!["revision"]!!);put("confirmed",true);draft!!.text("previewAttemptId").takeIf{it.isNotBlank()}?.let{put("expectedPreviewAttemptId",it)}},intentKey)}
   "cancel"->{repository.request("POST",draftPath()+"/state",buildJsonObject{put("expectedRevision",draft!!["revision"]!!);put("status","cancelled")},intentKey);draft=null;editPreview=null;refresh++}
  }
 }catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"操作失败")+"；本地输入已保留，请刷新核对服务端状态。"}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})
}

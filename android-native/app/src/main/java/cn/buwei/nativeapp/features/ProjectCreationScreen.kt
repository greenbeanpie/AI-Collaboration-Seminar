package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File


/** Owner-private, revision guarded drafts; no project or paid action before explicit confirmation. */
@Composable fun ProjectCreationScreen(repository:ClientRepository,onProject:(String)->Unit){
 val scope=rememberCoroutineScope();val owner=repository.accountId;val epoch=remember(owner){repository.epoch}
 var payloadText by rememberSaveable(owner){mutableStateOf(buildJsonObject{put("name","");put("description","");put("aiCollaborationEnabled",false);listOf("planningMode","assignmentMode","evaluationMode","progressionMode").forEach{put(it,"manual")};put("teamSize",1)}.toString())}
 val payload=remember(payloadText){Json.parseToJsonElement(payloadText).jsonObject}
 var draft by remember{mutableStateOf<JsonObject?>(null)};var drafts by remember{mutableStateOf<List<JsonObject>>(emptyList())};var templates by remember{mutableStateOf<List<JsonObject>>(emptyList())}
 var tasksText by rememberSaveable(owner){mutableStateOf("[]")};val tasks=remember(tasksText){Json.parseToJsonElement(tasksText).jsonArray}
 var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var progress by remember{mutableStateOf("")};var confirmation by remember{mutableStateOf<String?>(null)};var result by remember{mutableStateOf<JsonObject?>(null)};var pendingFile by remember{mutableStateOf<File?>(null)};var fileTarget by remember{mutableStateOf("")}
 var answerText by rememberSaveable{mutableStateOf("")};var answerOption by rememberSaveable{mutableStateOf("")};var undecided by rememberSaveable{mutableStateOf(false)}
 val recovery=remember(repository){NativeDraftStore(repository)};var recovered by remember(owner){mutableStateOf(false)}
 fun path()="/api/v1/creation-drafts/${Uri.encode(draft!!.text("id"))}"
 fun accept(value:JsonObject,replaceInputs:Boolean=true){draft=value;if(replaceInputs){payloadText=value.obj("payload").toString();tasksText=((value.obj("preview")["tasks"]as? JsonArray)?:JsonArray(emptyList())).toString()}}
 fun action(block:suspend ()->Unit){busy=true;error=null;scope.launch{try{check(repository.accountId==owner && repository.epoch==epoch){"账户上下文已变化，请重新打开创建向导"};block()}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"操作失败")+"；输入与原件已保留，请刷新核对，不会自动重复调用。"}finally{busy=false}}}
 suspend fun refreshList(){drafts=(repository.get("/api/v1/creation-drafts")["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};templates=(repository.get("/api/v1/project-templates")["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}}
 LaunchedEffect(owner){try{recovery.read("creation-workspace")?.let{saved->(saved["payload"]as? JsonObject)?.let{payloadText=it.toString()};(saved["tasks"]as? JsonArray)?.let{tasksText=it.toString()};draft=saved["draft"]as? JsonObject;result=saved["result"]as? JsonObject};recovered=true;refreshList()}catch(e:CancellationException){throw e}catch(e:Exception){recovered=true;error=e.message}}
 LaunchedEffect(owner,recovered,payloadText,tasksText,draft,result){if(recovered&&owner!=null)recovery.scheduleSave("creation-workspace",buildJsonObject{put("payload",payload);put("tasks",tasks);put("draft",draft?:JsonNull);put("result",result?:JsonNull)},owner,epoch){error="无法保存本机恢复草稿：${it.message}"}}
 val waiting=draft?.text("previewState")in listOf("queued","running","processing")||draft?.obj("execution")?.text("state")in listOf("running","finalizing")
 val fileWaiting=(draft?.get("files")as? JsonArray).orEmpty().any{it.jsonObject.text("mediaStatus")in listOf("pending","queued","running","processing","transcribing","generating","uploading")}
 LaunchedEffect(draft?.text("id"),waiting,fileWaiting){if(waiting||fileWaiting)while(isActive){delay(3000);try{val latest=repository.get(path());val wasClean=draft?.obj("payload")==payload && (draft?.obj("preview")?.get("tasks") as? JsonArray ?: JsonArray(emptyList()))==tasks;accept(latest,wasClean&&!busy);if(latest.text("previewState") !in listOf("queued","running","processing")&&latest.obj("execution").text("state") !in listOf("running","finalizing")&&!fileWaiting)break}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break}}}
 val chooser=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->if(uri!=null)action{check(draft?.text("status")=="active"){"请先保存活动草稿"};check(repository.accountId==owner){"账户已变化"};fileTarget=draft!!.text("id");pendingFile=CreationDocuments.stage(repository.context,uri,owner?:error("请登录"));File(pendingFile!!.path+".draft").writeText(fileTarget);confirmation="upload"}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("创建项目",style=MaterialTheme.typography.headlineSmall);Text("1. 项目信息 → 2. 预览任务 → 3. 确认创建",style=MaterialTheme.typography.bodySmall)
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy){LinearProgressIndicator(Modifier.fillMaxWidth());Text(progress)}
  result?.let{created->Text("项目已创建",style=MaterialTheme.typography.titleLarge);(created["invitations"]as? JsonArray).orEmpty().forEach{Text("${it.jsonObject.text("label")}：${it.jsonObject.text("code")}（${it.jsonObject.text("expiresAt")}）")};Button({onProject(created.text("projectId"))}){Text("进入项目")};return@Column}
  if(draft==null){
   drafts.forEach{existing->OutlinedButton({action{accept(repository.get("/api/v1/creation-drafts/${Uri.encode(existing.text("id"))}"))}},enabled=!busy){Text(existing.obj("payload").text("name").ifBlank{"未命名草稿"}+if(existing.text("status")=="cancelled")" · 已取消，可恢复"else" · 继续编辑")}}
   templates.forEach{template->OutlinedButton({action{accept(repository.requestDurably("creation","POST","/api/v1/creation-drafts/from-template",buildJsonObject{put("templateId",template.text("templateId"))}))}},enabled=!busy){Text("模板：${template.text("name")}")};Text(template.text("description"))}
  }else{
   Text("草稿版本 ${draft!!.text("revision")} · ${draft!!.text("status")}")
   TextButton({confirmation="reload"},enabled=!busy){Text("读取服务端版本（替换当前输入）")}
   TextButton({draft=null;pendingFile=null;action{refreshList()}},enabled=!busy){Text("返回草稿列表")}
   TextButton({confirmation=if(draft!!.text("status")=="cancelled")"restore"else"cancel"},enabled=!busy&&!waiting){Text(if(draft!!.text("status")=="cancelled")"恢复草稿"else"取消草稿（保留资料）")}
  }
  if(draft?.text("status")=="cancelled")return@Column
  CreationPayloadFields(payload){payloadText=it.toString()}
  Button({confirmation="save"},enabled=!busy&&!waiting){Text(if(draft==null)"保存创建草稿"else"保存项目信息")}
  draft?.let{current->
   val dirty=current.obj("payload")!=payload;val pendingQuestion=current["clarification"]as? JsonObject
   Text("草稿附件",style=MaterialTheme.typography.titleLarge)
   Text("原件及正文上传至当前私有草稿；媒体上传可能触发现有后端的 AI 处理。")
   OutlinedButton({chooser.launch(arrayOf("*/*"))},enabled=!busy&&!waiting&&!dirty&&pendingQuestion?.text("status")!="pending"){Text("新增草稿附件")}
   val localDraftFiles=remember(current.text("id"),busy){File(repository.context.filesDir,"creation-files/$owner").listFiles().orEmpty().filter{it.isFile&&!it.name.endsWith(".partial")&&!it.name.endsWith(".draft")&&!it.name.endsWith(".upload")&&File(it.path+".draft").let{link->link.exists()&&link.readText()==current.text("id")}}}
   localDraftFiles.filter{it!=pendingFile}.forEach{file->TextButton({pendingFile=file;fileTarget=current.text("id");confirmation="upload"},enabled=!busy&&!waiting&&!dirty){Text("继续本地原件：${file.name.drop(37)}")}}
   pendingFile?.let{file->Text("本地保留：${file.name.drop(37)}");if(fileTarget==current.text("id"))TextButton({confirmation="upload"},enabled=!busy&&!waiting&&!dirty){Text("继续上传此原件")}}
   listOf("files" to false,"removedFiles" to true).forEach{(field,removed)->(current[field]as? JsonArray).orEmpty().forEach{item->val file=item.jsonObject
    Card{Column(Modifier.padding(10.dp)){Text(file.text("name"));Text(if(removed)"已移除"else if(file["textReady"]?.jsonPrimitive?.booleanOrNull==true)"正文已可读取"else"正文未就绪");listOf("textError","mediaStatus","mediaError").forEach{key->file.text(key).takeIf{it.isNotBlank()}?.let{Text(it)}}
     TextButton({action{accept(repository.requestDurably("creation","POST",path()+"/files/${file.text("id")}/state",buildJsonObject{put("expectedRevision",current["revision"]!!);put("removed",!removed)}))}},enabled=!busy&&!waiting&&!dirty){Text(if(removed)"恢复附件"else"移除附件")}
     (file["mediaSummary"]as? JsonObject)?.let{StructuredValue(it)};if(!removed)file.text("mediaJobId").takeIf{it.isNotBlank()}?.let{CreationMediaStatus(repository,it)};val audio=file["audio"]as? JsonObject;if(audio!=null){StructuredValue(audio);if(audio["canResumeFallback"]?.jsonPrimitive?.booleanOrNull==true)TextButton({confirmation="media:${file.text("id")}:${file.text("mediaJobId")}"},enabled=!busy){Text("继续音频回退（可能产生费用）")}}
    }}
   }}
   Text("任务预览",style=MaterialTheme.typography.titleLarge);current.obj("activity").let{activity->activityProgress(activity)?.let{Text(it)}};current.text("previewError").takeIf{it.isNotBlank()}?.let{Text(it,color=MaterialTheme.colorScheme.error)}
   val execution=current["execution"]as? JsonObject
   if(execution!=null){Text("执行状态：${execution.text("state")} · 累计模型调用 ${execution.text("totalCalls")} 次");if(execution["canContinue"]?.jsonPrimitive?.booleanOrNull==true){OutlinedButton({confirmation="continue"},enabled=!busy){Text("继续 AI 规划")};OutlinedButton({confirmation="output"},enabled=!busy){Text("输出已有结果")}};if(execution.text("state")in listOf("running","paused","finalizing"))TextButton({confirmation="execution-cancel"},enabled=!busy){Text("取消后台执行")}}
   if(pendingQuestion?.text("status")=="pending"){
    Text(pendingQuestion.text("question"),style=MaterialTheme.typography.titleMedium);Text(pendingQuestion.text("reason"));Text("澄清 ${pendingQuestion.text("round")}/${pendingQuestion.text("maxRounds")}")
    (pendingQuestion["options"]as? JsonArray).orEmpty().forEach{option->FilterChip(answerOption==option.jsonPrimitive.content,{answerOption=option.jsonPrimitive.content;undecided=false;answerText=""},label={Text(option.jsonPrimitive.content)})}
    CreationText("自由回答",answerText){answerText=it;answerOption="";undecided=false}
    if(pendingQuestion["allowUndecided"]?.jsonPrimitive?.booleanOrNull==true)Row{Checkbox(undecided,{undecided=it;answerText="";answerOption=""});Text("尚未决定")}
    Button({confirmation="answer"},enabled=!busy&&(answerText.isNotBlank()||answerOption.isNotBlank()||undecided)){Text("提交回答并继续 AI")};TextButton({confirmation="question-cancel"},enabled=!busy){Text("取消澄清，改为手动编辑")}
   }
   CreationTasks(tasks){tasksText=it.toString()}
   if(dirty)Text("请先保存项目信息，再生成预览。")
   OutlinedButton({confirmation="manual"},enabled=!busy&&!dirty&&!waiting&&pendingQuestion?.text("status")!="pending"){Text("生成手动预览")}
   OutlinedButton({confirmation="ai"},enabled=!busy&&!dirty&&!waiting&&pendingQuestion?.text("status")!="pending"){Text("AI 规划预览")}
   val preview=current["preview"]as? JsonObject;val previewTasks=preview?.get("tasks")as? JsonArray
   if(preview!=null){Text("预览目标：${preview.obj("goal").text("title")}");Text("预览详情：${preview.obj("goal").text("detail")}")}
   val tasksDirty=previewTasks!=tasks
   if(preview!=null&&tasksDirty)Text("任务已编辑，请生成手动预览以保存修改。")
   if(runCatching{creationCommitBody(current)}.isSuccess)Button({confirmation="commit"},enabled=!busy&&!dirty&&!tasksDirty&&!waiting){Text("确认预览并创建项目")}
  }
 }
 confirmation?.let{chosen->val uncertain=draft?.obj("execution")?.text("pauseReason")=="request_uncertain";val ai=chosen in listOf("ai","continue","output","answer")||chosen.startsWith("media:")
  AlertDialog(onDismissRequest={confirmation=null},title={Text(if(ai)"确认 AI 操作？"else if(chosen=="commit")"按当前固定预览创建项目？"else"确认操作？")},text={Text(when{ai->if(uncertain)"上次供应商请求结果未知。请先核对供应商是否已完成；再次确认表示仍要继续调用，可能重复计费。"else"将使用现有后端 AI 配置，可能产生费用。结果不明确时请先刷新核对，客户端不会自动重复执行。";chosen=="upload"->"上传 ${pendingFile?.name?.drop(37)} 到当前草稿。音频、视频或图片可能触发现有后端 AI 处理。";chosen=="commit"->"固定草稿版本 ${draft?.text("revision")} 及本次预览提交，创建项目、任务与已确认资料。";chosen=="reload"->"当前未保存输入将替换为服务端已保存版本。";else->"操作基于当前草稿版本；错误时保留输入与原件。"})},confirmButton={TextButton({confirmation=null;action{
   val snapshot=draft;
   when{
    chosen=="reload"->accept(repository.get(path()))
    chosen=="save"->{val schema=NativeContracts.operations.first{it.method=="POST"&&it.path=="/api/v1/creation-drafts"}.schema;validate(schema,payload)?.let{error(it)};accept(if(snapshot==null)repository.requestDurably("creation","POST","/api/v1/creation-drafts",payload)else repository.requestDurably("creation","PATCH",path(),buildJsonObject{put("expectedRevision",snapshot["revision"]!!);put("payload",payload)}))}
    chosen=="upload"->{check(fileTarget==draft!!.text("id")){"草稿已切换"};accept(CreationDocuments.upload(repository,draft!!,pendingFile?:error("原件不存在")){progress=it});pendingFile?.let{File(it.path+".draft").delete()};pendingFile=null}
    chosen=="restore"||chosen=="cancel"->accept(repository.requestDurably("creation","POST",path()+"/state",buildJsonObject{put("expectedRevision",snapshot!!["revision"]!!);put("status",if(chosen=="restore")"active"else"cancelled")}))
    chosen=="manual"||chosen=="ai"->accept(repository.requestDurably("creation","POST",path()+"/preview",buildJsonObject{put("expectedRevision",snapshot!!["revision"]!!);put("mode",if(chosen=="ai")"ai"else"manual");put("regenerate",true);put("background",chosen=="ai");put("tasks",tasks);payload["goal"]?.let{put("goal",it)}}))
    chosen=="commit"->result=repository.requestDurably("creation","POST",path()+"/commit",creationCommitBody(snapshot!!))
    chosen in listOf("continue","output","execution-cancel")->accept(repository.requestDurably("creation","POST",path()+"/execution/"+if(chosen=="execution-cancel")"cancel"else chosen,buildJsonObject{put("expectedGeneration",snapshot!!.obj("execution")["generation"]!!);if(snapshot.obj("execution").text("pauseReason")=="request_uncertain")put("allowUncertainDispatch",true)}))
    chosen=="answer"||chosen=="question-cancel"->{val question=snapshot!!.obj("clarification");accept(repository.requestDurably("creation","POST",path()+"/clarifications/${question.text("id")}/"+if(chosen=="answer")"answer"else"cancel",buildJsonObject{put("expectedRevision",question["revision"]!!);if(chosen=="answer")when{undecided->put("undecided",true);answerOption.isNotBlank()->put("option",answerOption);else->put("text",answerText)}}));answerText="";answerOption="";undecided=false}
    chosen.startsWith("media:")->{val parts=chosen.split(':');repository.requestDurably("creation","POST",path()+"/files/${parts[1]}/media-resume",buildJsonObject{put("jobId",parts[2])});accept(repository.get(path()),false)}
   }
  }}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})
 }
}





package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.core.net.toUri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@Composable
fun AiConversationScreen(repository:ClientRepository,projectId:String,onResource:(String)->Unit = {}){
 val base="/api/v1/projects/${Uri.encode(projectId)}/ai-chat";val scope=rememberCoroutineScope()
 var messages by remember(projectId,repository.accountId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember{mutableStateOf<String?>(null)};var pending by remember{mutableStateOf<String?>(null)}
 var input by rememberSaveable(projectId,repository.accountId){mutableStateOf("")};val intentKey=remember(input){UUID.randomUUID().toString()};var refresh by remember{mutableIntStateOf(0)};var busy by remember{mutableStateOf(false)};var loading by remember{mutableStateOf(true)};var error by remember{mutableStateOf<String?>(null)};var confirmClear by remember{mutableStateOf(false)}
 suspend fun readHistory(older:Boolean=false){val page=repository.get(base+(if(older&&cursor!=null)"?cursor=${Uri.encode(cursor)}"else""));val loaded=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};messages=(if(older)messages+loaded else loaded).distinctBy{it.text("id")}.sortedBy{it.text("createdAt")};cursor=page.text("nextCursor").takeIf{it.isNotBlank()};pending=page.text("pendingJobId").takeIf{it.isNotBlank()}}
 LaunchedEffect(projectId,repository.accountId,refresh){loading=true;try{readHistory();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{loading=false}}
 Column(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("项目 AI",style=MaterialTheme.typography.headlineSmall)
  Row{TextButton({refresh++},enabled=!busy){Text("刷新")};TextButton({confirmClear=true},enabled=!busy&&pending==null&&messages.isNotEmpty()){Text("清空历史")}}
  if(loading)LinearProgressIndicator(Modifier.fillMaxWidth())
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  LazyColumn(Modifier.weight(1f),verticalArrangement=Arrangement.spacedBy(10.dp)){
   if(cursor!=null)item{OutlinedButton({busy=true;scope.launch{try{readHistory(true)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("加载更早对话")}}
   if(messages.isEmpty()&&!loading)item{Text("可以询问项目目标、任务进度或资料中的要求。")}
   items(messages,key={it.text("id")}){message->Card(Modifier.fillMaxWidth(),colors=CardDefaults.cardColors(containerColor=if(message.text("role")=="user")MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer)){
    Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
     Text(if(message.text("role")=="user")"我"else"AI",style=MaterialTheme.typography.labelLarge)
     NativeMarkdown(message.text("content"))
     (message["references"]as? JsonArray).orEmpty().forEach{reference->val ref=reference.jsonObject;val section=safeProjectSection(ref.text("href"),projectId);if(section!=null)TextButton({onResource(section)}){Text(ref.text("title"))}else Text(ref.text("title"),style=MaterialTheme.typography.labelSmall)}
     if(message.text("role")=="user")ChatOperations(repository,base,message.text("questionId"),pending!=null)
    }
   }}
   pending?.let{id->item{NativeJobExecution(repository,id,onSettled={pending=null;refresh++})}}
  }
  OutlinedTextField(input,{if(it.length<=4000)input=it},Modifier.fillMaxWidth(),label={Text("询问项目 AI")},minLines=2,maxLines=5,supportingText={Text("${input.length} / 4000")},enabled=!busy)
  Button({busy=true;error=null;scope.launch{try{val response=repository.request("POST",base,buildJsonObject{put("content",input.trim())},intentKey);pending=response.text("jobId").takeIf{it.isNotBlank()};input="";readHistory()}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"请求失败")+"；内容已保留。请先刷新确认服务端状态，再决定是否重试。"}finally{busy=false}}},enabled=!busy&&pending==null&&input.isNotBlank()){Text(if(busy)"发送中"else"发送")}
 }
 if(confirmClear)AlertDialog(onDismissRequest={confirmClear=false},title={Text("清空当前项目的个人 AI 历史？")},text={Text("清空后无法从此列表恢复。")},confirmButton={TextButton({confirmClear=false;busy=true;scope.launch{try{repository.request("DELETE",base,idempotencyKey=UUID.randomUUID().toString());messages=emptyList();cursor=null;refresh++}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("清空")}},dismissButton={TextButton({confirmClear=false}){Text("取消")}})
}

private fun safeProjectSection(href:String,projectId:String):String?{
 if(!href.startsWith("/app/projects/${Uri.encode(projectId)}"))return null
 val prefix="/app/projects/${Uri.encode(projectId)}";val path=href.toUri().path?:return null
 if(path!=prefix&&!path.startsWith("$prefix/"))return null
 val part=path.removePrefix(prefix).trim('/').substringBefore('/')
 return when(part){"tasks"->"tasks";"sources","files","materials","data"->"data";"assessments","standards","reviews"->"assessment";"members","team"->"team";""->"overview";else->null}
}

@Composable
private fun ChatOperations(repository:ClientRepository,base:String,questionId:String,active:Boolean){
 var operations by remember(questionId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember{mutableStateOf<String?>(null)};var error by remember{mutableStateOf<String?>(null)};var expanded by remember{mutableStateOf(active)};val scope=rememberCoroutineScope()
 suspend fun read(older:Boolean=false){val page=repository.get("$base/questions/${Uri.encode(questionId)}/operations"+(if(older&&cursor!=null)"?cursor=${Uri.encode(cursor)}"else""));val loaded=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};operations=(if(older)operations+loaded else loaded).associateBy{it.text("id")}.values.toList();cursor=page.text("nextCursor").takeIf{it.isNotBlank()}}
 LaunchedEffect(questionId,active){do{try{read();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break};if(active)delay(3000L)}while(active&&isActive)}
 if(operations.isNotEmpty()||error!=null){TextButton({expanded=!expanded}){Text("操作记录 ${if(expanded)"−"else"+"}")};if(expanded){error?.let{Text(it,color=MaterialTheme.colorScheme.error)};operations.forEach{op->Text("${op.text("label")} · ${op.text("status")} · 尝试 ${op.text("attempt")}",style=MaterialTheme.typography.bodySmall);op.text("detail").takeIf{it.isNotBlank()}?.let{Text(it,style=MaterialTheme.typography.bodySmall)}};if(cursor!=null)TextButton({scope.launch{try{read(true)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}){Text("加载更多操作")}}}
}

/** GET polling follows server execution permissions; every write requires an explicit confirmation. */
@Composable
fun NativeJobExecution(repository:ClientRepository,jobId:String,onSettled:()->Unit = {}){
 var job by remember(jobId,repository.accountId){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)};var refresh by remember{mutableIntStateOf(0)};var action by remember{mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};val scope=rememberCoroutineScope();val settledCallback by rememberUpdatedState(onSettled)
 LaunchedEffect(jobId,repository.accountId,refresh){var delayMs=2000L;while(isActive){try{val next=repository.get("/api/v1/jobs/${Uri.encode(jobId)}");job=next;error=null;if(next.text("status")in listOf("succeeded","failed","cancelled")){settledCallback();break}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break};delay(delayMs);delayMs=(delayMs+1000L).coerceAtMost(10000L)}}
 Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("AI 执行 · ${job?.text("status").orEmpty()}",style=MaterialTheme.typography.titleMedium)
  job?.let{current->val activity=current.obj("activity");Text(activity.text("code"));activityProgress(activity)?.let{Text(it)};val execution=current.obj("execution");Text("模型请求累计 ${execution.text("totalCalls").ifBlank{"未知"}} 次",style=MaterialTheme.typography.bodySmall);if(activity.flag("uncertain"))Text("供应商请求结果不明确，请核对后再继续。",color=MaterialTheme.colorScheme.error);current.text("error").takeIf{it.isNotBlank()}?.let{Text(it)}
   Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
    if(execution.flag("canContinue"))OutlinedButton({action="continue"},enabled=!busy){Text("继续")}
    if(execution.flag("canOutput"))OutlinedButton({action="output"},enabled=!busy){Text("输出当前结果")}
    if(current.text("status")in listOf("queued","running","waiting_input")&&execution["generation"]!=null)TextButton({action="cancel"},enabled=!busy){Text("取消执行")}
   }
  };error?.let{Text(it,color=MaterialTheme.colorScheme.error);TextButton({refresh++}){Text("刷新状态")}}
 }}
 if(action!=null)AlertDialog(onDismissRequest={action=null},title={Text(when(action){"continue"->"继续执行？";"output"->"输出当前结果？";else->"取消执行？"})},text={Text(if(action=="continue")"继续可能调用模型并产生费用。请求结果不明确时不会自动重放。"else"此操作将改变当前后台执行状态。")},confirmButton={TextButton({val chosen=action!!;action=null;busy=true;scope.launch{try{val current=job?:return@launch;repository.request("POST","/api/v1/jobs/${Uri.encode(jobId)}/execution/$chosen",buildJsonObject{put("expectedGeneration",current.obj("execution")["generation"]?:JsonPrimitive(1))},UUID.randomUUID().toString());refresh++}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton({action=null}){Text("返回")}})
}

internal fun activityProgress(activity:JsonObject):String?{
 val progress=activity["progress"]as? JsonObject?:return null;val completed=progress.text("completed").takeIf{it.isNotBlank()}?:return null;val unit=progress.text("unit")
 if(activity.text("code")in listOf("executing_tool","tool","tool_call")&&unit in listOf("tool_call","step"))return "累计执行工具 $completed 次（含失败尝试）"
 val label=mapOf("page" to "页","chunk" to "块","window" to "个窗口")[unit]?:return null
 return "已处理 $completed${progress.text("total").takeIf{it.isNotBlank()}?.let{" / $it"}.orEmpty()} $label"
}

@Composable
internal fun NativeMarkdown(markdown:String){
 var code=false
 SelectionContainer{Column(verticalArrangement=Arrangement.spacedBy(5.dp)){markdown.lines().forEach{line->if(line.trimStart().startsWith("```")){code=!code}else if(code)Text(line,fontFamily=FontFamily.Monospace,style=MaterialTheme.typography.bodySmall)else when{line.startsWith("### ")->Text(line.drop(4),style=MaterialTheme.typography.titleMedium);line.startsWith("## ")->Text(line.drop(3),style=MaterialTheme.typography.titleLarge);line.startsWith("# ")->Text(line.drop(2),style=MaterialTheme.typography.headlineSmall);line.startsWith("- ")||line.startsWith("* ")->Text("• "+line.drop(2));else->Text(line)}}}}
}

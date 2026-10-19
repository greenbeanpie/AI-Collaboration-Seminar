package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable internal fun SupportWorkspaceConversation(repository:ClientRepository,ticketId:String){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope();val drafts=remember(repository){NativeDraftStore(repository)};val key="support-reply:$ticketId";val path="/api/v1/support/tickets/$ticketId"
 var ticket by remember(owner,ticketId){mutableStateOf<JsonObject?>(null)};var messages by remember(owner,ticketId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember(owner,ticketId){mutableStateOf<String?>(null)};var body by remember(owner,ticketId){mutableStateOf("")};var uncertain by remember(owner,ticketId){mutableStateOf(false)};var loaded by remember(owner,ticketId){mutableStateOf(false)};var selectedStatus by remember(owner,ticketId){mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirmation by remember{mutableStateOf<String?>(null)}
 suspend fun persist(){drafts.save(key,buildJsonObject{put("body",body);put("uncertain",uncertain)},owner?:error("请登录"),epoch)}
 suspend fun get(url:String)=repository.networkJson("GET",url,expectedOwner=owner,expectedEpoch=epoch)
 suspend fun loadMessages(more:Boolean){val previous=if(more)cursor else null;val result=get("$path/messages?limit=50"+(previous?.let{"&cursor="+Uri.encode(it)}?:""));val next=result.text("nextCursor").takeIf{it.isNotBlank()};check(next==null||next!=previous){"对话分页未前进，请重新读取"};messages=notificationWorkspaceMerge(if(more)messages else emptyList(),(result["items"]as? JsonArray).orEmpty().map{it.jsonObject});cursor=next}
 suspend fun reload(){ticket=get(path).obj("ticket");loadMessages(false)}
 fun action(block:suspend ()->Unit){if(busy)return;busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){if(e is ApiException&&e.status in listOf(401,403,404)){ticket=null;messages=emptyList()};error=e.message}finally{busy=false}}}
 LaunchedEffect(owner,ticketId){try{drafts.read(key)?.let{body=it.text("body");uncertain=it["uncertain"]?.jsonPrimitive?.booleanOrNull==true};loaded=true;reload()}catch(e:CancellationException){throw e}catch(e:Exception){loaded=true;error=e.message}}
 LaunchedEffect(owner,ticketId,loaded,body,uncertain){if(loaded&&owner!=null)drafts.scheduleSave(key,buildJsonObject{put("body",body);put("uncertain",uncertain)},owner,epoch){error=it.message}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());TextButton({action{reload()}},enabled=!busy){Text("刷新工单详情与对话")}
 ticket?.let{value->
  Text(value.text("title"),style=MaterialTheme.typography.titleLarge);Text("提交人：${value.text("ownerName")} · ${supportStatuses.firstOrNull{it.first==value.text("status")}?.second.orEmpty()}");Text(value.text("body"));Text("紧急度：${supportUrgencies.firstOrNull{it.first==value.text("urgency")}?.second.orEmpty()} · 分类：${supportCategories.firstOrNull{it.first==value.text("category")}?.second.orEmpty()}")
  (value["images"]as? JsonArray).orEmpty().forEach{SupportWorkspaceImage(repository,ticketId,it.jsonObject)}
  if(repository.account.value?.text("role")in listOf("admin","super_admin")){CreationChoice("管理员处理状态",selectedStatus.ifBlank{value.text("status")},supportStatuses){selectedStatus=it};Button({confirmation="status"},enabled=!busy&&selectedStatus.isNotBlank()&&selectedStatus!=value.text("status")){Text("保存工单状态")}}
  Text("回复与状态历史",style=MaterialTheme.typography.titleMedium);messages.forEach{message->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(10.dp)){Text("${message.text("authorName")} · ${message.text("createdAt")}");Text(if(message.text("kind")=="status")"状态更新为：${supportStatuses.firstOrNull{it.first==message.text("status")}?.second.orEmpty()}"else message.text("body"))}}}
  if(cursor!=null)OutlinedButton({action{loadMessages(true)}},enabled=!busy){Text("加载后续回复")}
  if(value.text("status")=="closed")Text("此工单已关闭。管理员重新打开后可继续回复。")else{
   OutlinedTextField(body,{body=it},label={Text("回复内容（最多8000字）")},modifier=Modifier.fillMaxWidth())
   if(uncertain){Text("上次回复结果未知，请先刷新对话核对。",color=MaterialTheme.colorScheme.error);TextButton({confirmation="unlock"},enabled=!busy){Text("已核对对话，允许再次发送")}}
   Button({confirmation="reply"},enabled=!busy&&!uncertain&&body.trim().length in 1..8000){Text("发送回复")}
  }
 }
 confirmation?.let{chosen->AlertDialog(onDismissRequest={confirmation=null},title={Text(when(chosen){"status"->"保存工单处理状态？";"unlock"->"确认对话没有重复回复？";else->"发送此回复？"})},text={Text(when(chosen){"unlock"->"后端回复接口不支持幂等去重。确认再次发送可能产生重复回复，请先核对完整对话。";"status"->"按当前工单版本更新状态；关闭后用户无法继续回复。";else->"发送给当前工单，结果未知时停止重复发送并保留正文。"})},confirmButton={TextButton({confirmation=null;action{when(chosen){
  "unlock"->{uncertain=false;persist()}
  "status"->{ticket=repository.networkJson("PATCH","$path/status",buildJsonObject{put("status",selectedStatus);put("revision",ticket!!["revision"]!!)},expectedOwner=owner,expectedEpoch=epoch).obj("ticket");selectedStatus="";loadMessages(false)}
  else->{uncertain=true;persist();try{repository.networkJson("POST","$path/messages",buildJsonObject{put("body",body.trim())},expectedOwner=owner,expectedEpoch=epoch);body="";uncertain=false;persist();reload()}catch(e:ApiException){if(e.status in 400..499){uncertain=false;persist()};throw e}}
 }}}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})}
}


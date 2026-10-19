package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@Composable
internal fun TaskInquiriesScreen(repository:ClientRepository,projectId:String,taskId:String){
 val base="/api/v1/projects/${Uri.encode(projectId)}";val path="$base/tasks/${Uri.encode(taskId)}/inquiries";val scope=rememberCoroutineScope()
 var inquiries by remember(projectId,taskId,repository.accountId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember{mutableStateOf<String?>(null)};var members by remember{mutableStateOf<List<JsonObject>>(emptyList())};var memberCursor by remember{mutableStateOf<String?>(null)}
 var recipient by remember{mutableStateOf<String?>(null)};var body by rememberSaveable(projectId,taskId,repository.accountId){mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirm by remember{mutableStateOf(false)};var refresh by remember{mutableIntStateOf(0)};val intentKey=remember(body,recipient){UUID.randomUUID().toString()}
 suspend fun load(older:Boolean=false){val page=repository.get(path+(if(older&&cursor!=null)"?cursor=${Uri.encode(cursor)}"else""));val records=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};inquiries=(if(older)inquiries+records else records).distinctBy{it.text("inquiryId")};cursor=page.text("nextCursor").takeIf{it.isNotBlank()}}
 suspend fun loadMembers(older:Boolean=false){val page=repository.get("$base/members"+(if(older&&memberCursor!=null)"?cursor=${Uri.encode(memberCursor)}"else""));val rows=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};members=(if(older)members+rows else rows).distinctBy{it.text("userId")}.filter{it.text("userId")!=repository.accountId};memberCursor=page.text("nextCursor").takeIf{it.isNotBlank()}}
 LaunchedEffect(projectId,taskId,repository.accountId,refresh){busy=true;try{load();loadMembers();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}
 Text("当前任务的私密问询",style=MaterialTheme.typography.titleLarge);Text("仅显示服务端授权给你的工单。一对一问询与此任务绑定。",style=MaterialTheme.typography.bodySmall)
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 TextButton({refresh++},enabled=!busy){Text("刷新")}
 inquiries.forEach{inquiry->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("${inquiry.text("requesterName")} → ${inquiry.text("recipientName")}",style=MaterialTheme.typography.titleMedium)
  (inquiry["messages"]as? JsonArray).orEmpty().forEach{message->val row=message.jsonObject;Text("${row.text("authorName")} · ${row.text("createdAt")}",style=MaterialTheme.typography.labelSmall);NativeMarkdown(row.text("body"))}
  InquiryReply(repository,"$base/task-inquiries/${Uri.encode(inquiry.text("inquiryId"))}/messages"){refresh++}
 }}}
 if(cursor!=null)OutlinedButton({busy=true;scope.launch{try{load(true)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("加载更多问询")}
 val displayedIds=inquiries.flatMap{(it["messages"]as? JsonArray).orEmpty()}.mapNotNull{it.jsonObject.text("messageId").takeIf{v->v.isNotBlank()}}.distinct().take(200)
 if(displayedIds.isNotEmpty())TextButton({busy=true;scope.launch{try{repository.request("POST","$path/read",buildJsonObject{put("messageIds",JsonArray(displayedIds.map{JsonPrimitive(it)}))},UUID.randomUUID().toString())}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("将本页展示的消息标记已读")}
 HorizontalDivider();Text("发起问询",style=MaterialTheme.typography.titleMedium)
 var chooseMember by remember{mutableStateOf(false)};OutlinedButton({chooseMember=!chooseMember}){Text(members.firstOrNull{it.text("userId")==recipient}?.text("displayName")?:"选择收件人")}
 if(chooseMember){members.forEach{member->FilterChip(recipient==member.text("userId"),{recipient=member.text("userId");chooseMember=false},label={Text(member.text("displayName").ifBlank{member.text("username")})})};if(memberCursor!=null)TextButton({scope.launch{try{loadMembers(true)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}){Text("更多成员")}}
 OutlinedTextField(body,{if(it.length<=4000)body=it},Modifier.fillMaxWidth(),label={Text("问询内容")},minLines=3)
 Button({confirm=true},enabled=!busy&&recipient!=null&&body.isNotBlank()){Text("发送私密问询")}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("发送给所选成员？")},text={Text(body)},confirmButton={TextButton({confirm=false;busy=true;scope.launch{try{repository.request("POST",path,buildJsonObject{put("recipientId",recipient!!);put("body",body.trim())},intentKey);body="";refresh++}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"发送失败")+"；内容已保留。"}finally{busy=false}}}){Text("发送")}},dismissButton={TextButton({confirm=false}){Text("返回")}})
}

@Composable
private fun InquiryReply(repository:ClientRepository,path:String,onSent:()->Unit){
 var reply by rememberSaveable(path,repository.accountId){mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};val key=remember(reply){UUID.randomUUID().toString()};val scope=rememberCoroutineScope()
 OutlinedTextField(reply,{if(it.length<=4000)reply=it},Modifier.fillMaxWidth(),label={Text("回复此问询")},minLines=2)
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 TextButton({busy=true;scope.launch{try{repository.request("POST",path,buildJsonObject{put("body",reply.trim())},key);reply="";onSent()}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"发送失败")+"；内容已保留。"}finally{busy=false}}},enabled=!busy&&reply.isNotBlank()){Text("发送回复")}
}

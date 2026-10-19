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
 val owner=repository.accountId;val epoch=repository.epoch
 var readProgress by remember(projectId,taskId,owner,epoch){mutableStateOf<InquiryReadProgress?>(null)}
 var markingRead by remember(projectId,taskId,owner,epoch){mutableStateOf(false)}
 var inquiries by remember(projectId,taskId,repository.accountId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember{mutableStateOf<String?>(null)};var members by remember{mutableStateOf<List<JsonObject>>(emptyList())};var memberCursor by remember{mutableStateOf<String?>(null)}
 var recipient by remember{mutableStateOf<String?>(null)};var body by rememberSaveable(projectId,taskId,repository.accountId){mutableStateOf("")};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirm by remember{mutableStateOf(false)};var refresh by remember{mutableIntStateOf(0)};val intentKey=remember(body,recipient){UUID.randomUUID().toString()}
 suspend fun load(older:Boolean=false){val page=repository.get(path+(if(older&&cursor!=null)"?cursor=${Uri.encode(cursor)}"else""));val records=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};inquiries=(if(older)inquiries+records else records).distinctBy{it.text("inquiryId")};cursor=page.text("nextCursor").takeIf{it.isNotBlank()}}
 suspend fun loadMembers(older:Boolean=false){val page=repository.get("$base/members"+(if(older&&memberCursor!=null)"?cursor=${Uri.encode(memberCursor)}"else""));val rows=(page["items"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject};members=(if(older)members+rows else rows).distinctBy{it.text("userId")}.filter{it.text("userId")!=repository.accountId};memberCursor=page.text("nextCursor").takeIf{it.isNotBlank()}}
 LaunchedEffect(projectId,taskId,repository.accountId,refresh){busy=true;try{load();loadMembers();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}
 Text("当前任务的私密问询",style=MaterialTheme.typography.titleLarge);Text("仅显示服务端授权给你的工单。一对一问询与此任务绑定。",style=MaterialTheme.typography.bodySmall)
 if(busy||markingRead)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 TextButton({refresh++},enabled=!busy){Text("刷新")}
 inquiries.forEach{inquiry->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("${inquiry.text("requesterName")} → ${inquiry.text("recipientName")}",style=MaterialTheme.typography.titleMedium)
  (inquiry["messages"]as? JsonArray).orEmpty().forEach{message->val row=message.jsonObject;Text("${row.text("authorName")} · ${row.text("createdAt")}",style=MaterialTheme.typography.labelSmall);NativeMarkdown(row.text("body"))}
  InquiryReply(repository,"$base/task-inquiries/${Uri.encode(inquiry.text("inquiryId"))}/messages"){refresh++}
 }}}
 if(cursor!=null)OutlinedButton({busy=true;scope.launch{try{load(true)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("加载更多问询")}
 val displayedIds=inquiries.flatMap{(it["messages"]as? JsonArray).orEmpty()}.mapNotNull{(it as? JsonObject)?.text("messageId")?.takeIf{v->v.isNotBlank()}}
 val pendingRead=readProgress?.takeIf{it.remainingCount>0&&it.failureMessage!=null}
 if(displayedIds.isNotEmpty()||pendingRead!=null)TextButton({
  if(!markingRead){
  val snapshot=pendingRead?:inquiryReadSnapshot(displayedIds);readProgress=snapshot.copy(failureMessage=null);markingRead=true
  scope.launch{try{
   fun assertAccount(){check(owner!=null&&repository.accountId==owner&&repository.epoch==epoch){"账户已变化，已停止后续已读批次"}}
   val result=markDisplayedInquiryMessages(snapshot,::assertAccount,postBatch={batch->
    val response=repository.request("POST","$path/read",buildJsonObject{put("messageIds",JsonArray(batch.map(::JsonPrimitive)))},UUID.randomUUID().toString(),expectedOwner=owner,expectedEpoch=epoch)
    (response["readCount"] as? JsonPrimitive)?.intOrNull?:error("服务端未返回新增已读数量，请刷新核对")
   },onProgress={progress->assertAccount();readProgress=progress})
   if(repository.accountId==owner&&repository.epoch==epoch)readProgress=result
  }catch(e:CancellationException){throw e}catch(e:Exception){if(repository.accountId==owner&&repository.epoch==epoch)readProgress=(readProgress?:snapshot).copy(failureMessage=e.message?:"标记已读失败")}finally{markingRead=false}}
  }
 },enabled=!busy&&!markingRead){Text(if(pendingRead!=null)"继续标记剩余展示消息（${pendingRead.remainingCount} 条）"else"将本页展示的消息标记已读")}
 if(displayedIds.isNotEmpty())Text("本次只处理点击时已加载并展示的消息；后续加载的消息请再次操作。每批最多 200 条。",style=MaterialTheme.typography.bodySmall)
 readProgress?.let{progress->
  Text("已确认处理 ${progress.processedCount} / ${progress.messageIds.size} 条展示消息；后端确认新增已读 ${progress.newlyReadCount} 条。",style=MaterialTheme.typography.bodySmall)
  progress.failureMessage?.let{failure->Text("$failure；已停止后续批次。剩余 ${progress.remainingCount} 条尚未确认，可手动继续；未加载消息不会处理。",color=MaterialTheme.colorScheme.error)}
 }
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

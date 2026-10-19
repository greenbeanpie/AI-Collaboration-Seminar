package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.ReferenceOutlinedTextField
import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Both comment targets share the existing project endpoint and durable offline-sync contract. */
@Composable internal fun MaterialDiscussionWorkspace(repository:ClientRepository,projectId:String,materialId:String){
 ProjectDiscussionWorkspace(repository,projectId,"material",materialId)
}
@Composable internal fun TaskDiscussionWorkspace(repository:ClientRepository,projectId:String,taskId:String){
 ProjectDiscussionWorkspace(repository,projectId,"task",taskId)
}
@Composable private fun ProjectDiscussionWorkspace(repository:ClientRepository,projectId:String,targetType:String,targetId:String){
 require(targetType in setOf("material","task"))
 val account by repository.account.collectAsState()
 key(projectId,targetType,targetId,account?.twText("id"),repository.epoch){DiscussionContent(repository,projectId,targetType,targetId)}
}

@Composable private fun DiscussionContent(repository:ClientRepository,projectId:String,targetType:String,targetId:String){
 val targetName=if(targetType=="material")"材料"else"任务"
 val focusManager=LocalFocusManager.current;val keyboard=LocalSoftwareKeyboardController.current
 val owner=repository.accountId;val epoch=repository.epoch
 val path="${twBase(projectId)}/comments";val draftKey="$targetType-comment:$owner:$projectId:$targetId"
 val recovered=remember{runCatching{repository.secrets.get(draftKey)?.let{repository.json.parseToJsonElement(it).jsonObject}}}
 var body by remember{mutableStateOf(recovered.getOrNull()?.twText("body").orEmpty())}
 var pendingId by remember{mutableStateOf(recovered.getOrNull()?.twText("operationId").orEmpty())}
 var draftFailure by remember{mutableStateOf(recovered.exceptionOrNull()?.let{"本机讨论草稿无法读取，请先备份：${it.message}"})}
 var readFailed by remember{mutableStateOf(recovered.isFailure)}
 var persisted by remember{mutableStateOf(recovered.isSuccess)}
 var comments by remember{mutableStateOf<List<JsonObject>>(emptyList())}
 var cursor by remember{mutableStateOf<String?>(null)}
 var seenCursors by remember{mutableStateOf<Set<String>>(emptySet())}
 var busy by remember{mutableStateOf(false)}
 var canWrite by remember{mutableStateOf(false)}
 var denied by remember{mutableStateOf(false)}
 var error by remember{mutableStateOf<String?>(null)}
 var notice by remember{mutableStateOf(if(body.isNotEmpty())"已恢复本机${targetName}讨论草稿，尚未发送。"else"")}
 var queuePresent by remember{mutableStateOf(true)}
 val scope=rememberCoroutineScope()
 fun owned(){check(owner!=null&&repository.accountId==owner&&repository.epoch==epoch){"账户已变化，讨论操作已停止"}}
 fun persist(){
  try{owned();repository.secrets.put(draftKey,if(body.isEmpty()&&pendingId.isEmpty())null else buildJsonObject{put("body",body);if(pendingId.isNotEmpty())put("operationId",pendingId)}.toString());persisted=true;draftFailure=null}
  catch(e:Exception){persisted=false;draftFailure="当前草稿尚未保存到本机，请复制备份：${e.message}"}
 }
 fun clearDraft(){owned();repository.secrets.put(draftKey,null);body="";pendingId="";persisted=true;readFailed=false;draftFailure=null}
 fun failure(e:Exception){
  if(e is ApiException&&e.status in listOf(401,403,404)){comments=emptyList();cursor=null;seenCursors=emptySet();canWrite=false;denied=true}
  error=e.message?:"讨论暂时不可用"
 }
 suspend fun ownPending(submitted:String)=repository.pending().lastOrNull{it.path==path&&runCatching{repository.json.parseToJsonElement(it.body).jsonObject.let{value->value.twText("targetType")==targetType&&value.twText("targetId")==targetId&&value.twText("body")==submitted}}.getOrDefault(false)}
 suspend fun read(more:Boolean){
  owned();val requested=if(more)cursor else null
  val page=repository.networkJson("GET","$path?targetType=$targetType&targetId=${Uri.encode(targetId)}&limit=50"+(requested?.let{"&cursor=${Uri.encode(it)}"}?:""),expectedOwner=owner,expectedEpoch=epoch)
  owned();check(page["items"] is JsonArray){"讨论响应缺少记录列表"}
  val next=page.twText("nextCursor").takeIf{it.isNotBlank()}
  val visited=if(more)seenCursors else emptySet()
  check(next==null||(next!=requested&&next !in visited)){"讨论分页未前进，请刷新重新读取"}
  comments=((if(more)comments else emptyList())+page.twRows()).distinctBy{it.twText("commentId")}
  cursor=next;seenCursors=visited+listOfNotNull(requested);canWrite=true;denied=false
  if(pendingId.isEmpty()&&body.isNotBlank()){
   val operation=ownPending(body.trim());owned();if(operation!=null){pendingId=operation.id;persist()}
  }
  if(pendingId.isNotEmpty()){
   queuePresent=repository.pending().any{it.id==pendingId};owned()
   notice=if(queuePresent)"此评论已保存为待同步记录，请在同步中心核对；不会再次创建。"else"待同步记录已结束，请核对评论列表后清除待确认草稿；本页不会自动重发。"
  }
 }
 fun load(more:Boolean){if(busy)return;busy=true;error=null;scope.launch{try{read(more)}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{busy=false}}}
 LaunchedEffect(Unit){busy=true;try{read(false)}catch(e:CancellationException){throw e}catch(e:Exception){failure(e)}finally{busy=false}}
 Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("${targetName}讨论",style=MaterialTheme.typography.titleLarge)
  Text(if(targetType=="material")"讨论保存在当前项目的这份材料下，与材料版本正文分开。"else"讨论保存在当前项目的这项任务下，与私密问询分开。")
  if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  if(denied)Text(if(targetType=="material")"当前无法访问这份材料的讨论；已清除服务端记录，未发送草稿保留。"else"当前无法访问这项任务的讨论；已清除服务端记录，未发送草稿保留。")
  TextButton({load(false)},enabled=!busy){Text("刷新${targetName}讨论")}
  if(comments.isEmpty()&&!busy&&error==null)Text("还没有${targetName}评论")
  comments.forEach{comment->key(comment.twText("commentId")){
   Text("${comment.twText("authorName")} · ${comment.twText("createdAt")}",style=MaterialTheme.typography.labelMedium)
   NativeMarkdown(comment.twText("body"));HorizontalDivider()
  }}
  if(cursor!=null)OutlinedButton({load(true)},enabled=!busy&&!denied){Text("加载更多${targetName}评论")}
  ReferenceOutlinedTextField(body,{value->if(value.length<=4000){body=value;readFailed=false;persist();notice=""}},Modifier.fillMaxWidth(),label=if(targetType=="material")"材料讨论内容"else"讨论内容",aiReference=true,minLines=3,enabled=!busy&&pendingId.isEmpty())
  Text("${body.length} / 4000",style=MaterialTheme.typography.bodySmall)
  if(body.isNotEmpty()&&persisted&&pendingId.isEmpty())Text("${targetName}讨论草稿已保存在当前账户的本机，尚未发送。")
  draftFailure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
  if(notice.isNotBlank())Text(notice)
  Button({
   if(!busy){focusManager.clearFocus(force=true);keyboard?.hide();busy=true;error=null;val submitted=body.trim()
    scope.launch{try{
     owned();check(!readFailed){"本机草稿读取失败，请先备份"};persist();check(persisted){"草稿尚未安全保存"}
     val response=repository.requestDurably("$targetType-comment:$projectId:$targetId","POST",path,buildJsonObject{put("targetType",targetType);put("targetId",targetId);put("body",submitted)})
     owned()
     if(response["queued"]?.jsonPrimitive?.booleanOrNull==true){pendingId=response.twText("operationId");check(pendingId.isNotEmpty()){"待同步响应缺少操作身份，请到同步中心核对"};persist();queuePresent=true;notice="此评论已保存为待同步记录，尚未确认发送成功；请在同步中心核对。"}
     else{check(response.twText("commentId").isNotEmpty()){"服务端未返回评论身份，请刷新核对"};comments=(comments+response).distinctBy{it.twText("commentId")};try{clearDraft();notice="${targetName}评论已发送。"}catch(e:Exception){pendingId="confirmed:${response.twText("commentId")}";queuePresent=false;persist();draftFailure="评论已发送，但旧草稿清理失败；请核对评论列表后处理：${e.message}"}}
    }catch(e:CancellationException){throw e}catch(e:Exception){
     failure(e)
     // requestDurably may have retained an ambiguous/blocked offline operation. Never create a second copy.
     if(repository.accountId==owner&&repository.epoch==epoch){
      val operation=ownPending(submitted)
      if(operation!=null){pendingId=operation.id;queuePresent=true;persist();notice="发送结果尚未确认；已保留同步记录和草稿，请在同步中心核对，避免重复发送。"}
     }
    }finally{busy=false}}
   }
  },enabled=!busy&&canWrite&&!denied&&!readFailed&&pendingId.isEmpty()&&body.isNotBlank()){Text(if(targetType=="material")"发送材料评论"else"发表评论")}
  if(pendingId.isNotEmpty()&&!queuePresent)OutlinedButton({try{clearDraft();notice="已按你的核对清除待确认草稿。"}catch(e:Exception){draftFailure=e.message}},enabled=!busy){Text("已核对评论列表，清除待确认草稿")}
 }
}

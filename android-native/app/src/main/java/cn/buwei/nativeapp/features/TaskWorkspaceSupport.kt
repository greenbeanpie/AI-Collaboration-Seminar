package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.ReferenceOutlinedTextField
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun JsonObject.twText(key:String)=get(key)?.let{(it as? JsonPrimitive)?.contentOrNull}.orEmpty()
internal fun JsonObject.twRows(key:String="items")=(get(key) as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}
internal fun JsonObject.twIds(key:String)=(get(key) as? JsonArray).orEmpty().mapNotNull{(it as? JsonPrimitive)?.contentOrNull}
internal fun twBase(project:String)="/api/v1/projects/${Uri.encode(project)}"
internal fun JsonObject.twCan(permission:String)=twText("role")=="owner"||(get("permissions") as? JsonObject)?.get(permission)?.jsonPrimitive?.booleanOrNull==true
internal fun twRevision(row:JsonObject)=row["revision"]?.jsonPrimitive?.int?:error("未读取到版本，请刷新")
internal fun twState(row:JsonObject)=mapOf("open" to "待领取","in_progress" to "执行中","submitted" to "待验收","accepted" to "已完成","improve" to "需改进","rework" to "需重做","todo" to "待办","doing" to "执行中","done" to "已完成","blocked" to "受阻")[row.twText("lifecycleState").ifBlank{row.twText("status")}]?:row.twText("status")

/** One user intent retains its key on ambiguous failure. No automatic write retries. */
@Composable internal fun TaskWorkspaceAction(repository:ClientRepository,label:String,path:String,body:JsonObject=JsonObject(emptyMap()),method:String="POST",enabled:Boolean=true,confirmation:String?=null,prepare:suspend (JsonObject)->JsonObject={it},onSuccess:suspend (JsonObject)->Unit={}) {
 val scope=rememberCoroutineScope();val owner=repository.accountId;val epoch=repository.epoch
 var busy by remember(path,owner){mutableStateOf(false)};var error by remember(path,owner){mutableStateOf<String?>(null)};var confirm by remember{mutableStateOf(false)}
 fun send(){if(busy)return;busy=true;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};val prepared=prepare(body);check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};val result=if(method=="GET")repository.get(path)else repository.requestDurably("task-team:$path",method,path,prepared);check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};error=null;onSuccess(result)}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"操作失败")+"；填写内容已保留，请核对服务端记录后再重试。"}finally{busy=false}}}
 Button({if(confirmation!=null)confirm=true else send()},enabled=enabled&&!busy){Text(if(busy)"处理中…"else label)}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text(label)},text={Text(confirmation.orEmpty())},confirmButton={TextButton({confirm=false;send()}){Text("确认")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}

@Composable internal fun TaskWorkspacePage(repository:ClientRepository,path:String,refresh:Int=0,content:@Composable (List<JsonObject>)->Unit){
 var rows by remember(path,repository.accountId){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember(path){mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};val scope=rememberCoroutineScope();val owner=repository.accountId;val epoch=repository.epoch
 suspend fun load(more:Boolean){busy=true;try{val data=repository.get(path+(if(more&&cursor!=null)(if(path.contains('?'))"&"else"?")+"cursor=${Uri.encode(cursor)}"else""));check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"};rows=if(more)rows+data.twRows()else data.twRows();cursor=data.twText("nextCursor").takeIf{it.isNotBlank()};error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message?:"读取失败"}finally{busy=false}}
 LaunchedEffect(path,owner,refresh){load(false)}
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error);TextButton({scope.launch{load(false)}}){Text("重试读取")}}
 content(rows)
 if(cursor!=null)OutlinedButton({scope.launch{load(true)}},enabled=!busy){Text("加载更多")}
}
@Composable internal fun TaskWorkspaceField(label:String,value:String,onChange:(String)->Unit,max:Int=4000,lines:Int=1,aiReference:Boolean=false){ReferenceOutlinedTextField(value,{if(it.length<=max)onChange(it)},Modifier.fillMaxWidth(),label=label,aiReference=aiReference,minLines=lines)}
@Composable internal fun TaskWorkspaceMemberPicker(members:List<JsonObject>,selected:String?,onChange:(String?)->Unit){
 var open by remember{mutableStateOf(false)};OutlinedButton({open=!open}){Text(members.firstOrNull{it.twText("userId")==selected}?.twText("displayName")?:"未安排负责人")}
 if(open){TextButton({onChange(null);open=false}){Text("不安排负责人")};members.forEach{member->TextButton({onChange(member.twText("userId"));open=false}){Text(member.twText("displayName").ifBlank{member.twText("username")})}}}
}
@Composable internal fun TaskWorkspaceNamedValues(value:JsonElement?,names:Map<String,String> = emptyMap()){
 when(value){is JsonObject->value.forEach{(key,v)->if(!key.endsWith("Id")&&!key.endsWith("Ids")&&key !in setOf("revision","profileStamp")){Text(names[key]?:mapOf("status" to "状态","summary" to "概述","steps" to "步骤","body" to "内容","feedback" to "反馈","criteria" to "验收标准","limitations" to "限制","plan" to "计划","title" to "标题","description" to "说明","text" to "正文")[key]?:key,style=MaterialTheme.typography.labelMedium);TaskWorkspaceNamedValues(v,names)}};is JsonArray->value.forEach{TaskWorkspaceNamedValues(it,names)};is JsonPrimitive->if(value!=JsonNull)NativeMarkdown(value.content);else->Unit}
}

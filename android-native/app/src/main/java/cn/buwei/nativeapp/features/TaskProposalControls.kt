package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.ReferenceOutlinedTextField
import cn.buwei.nativeapp.NativeAiReferenceBadge
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal val proposalGroups=listOf("tasks","updates","assignments")
internal fun proposalItemKey(group:String,row:JsonObject,index:Int)=if(group=="tasks")row.twText("key").ifBlank{"t${index+1}"}else row.twText("taskId")
internal fun proposalSelectionKeys(payload:JsonObject)=proposalGroups.flatMap{group->payload.twRows(group).mapIndexed{index,row->"$group:${proposalItemKey(group,row,index)}"}}.toSet()
internal fun proposalDependencies(row:JsonObject):List<String> = when(val value=row["dependsOn"]){is JsonPrimitive->value.content.split(',','，').map(String::trim).filter(String::isNotBlank);else->row.twIds("dependsOn")}

/** null means omitted/default-all; an explicit empty list must stay empty for every group. */
internal fun proposalApplyBody(revision:Int,payload:JsonObject,excluded:Set<String>?=null):JsonObject {
    require(revision>0)
    if(excluded!=null)require(proposalSelectionKeys(payload).containsAll(excluded)){"选择包含已变化的建议条目，请核对最新方案"}
    return buildJsonObject {
        put("expectedRevision",revision)
        if(excluded!=null)proposalGroups.zip(listOf("selectedTaskKeys","selectedUpdateTaskIds","selectedAssignmentTaskIds")).forEach{(group,field)->
            put(field,JsonArray(payload.twRows(group).mapIndexedNotNull{index,row->proposalItemKey(group,row,index).takeUnless{"$group:$it" in excluded}?.let(::JsonPrimitive)}))
        }
    }
}

internal fun proposalRevisionBody(revision:Int,payload:JsonObject,reason:String):JsonObject {
    require(revision>0&&reason.trim().length in 1..4000){"请填写 1–4000 字的修订理由"}
    val normalized=payload.toMutableMap()
    listOf("tasks","updates").forEach{group->if(payload[group] is JsonArray)normalized[group]=JsonArray(payload.twRows(group).mapIndexed{index,row->
        val hours=row.twText("effortHours").toDoubleOrNull()
        require(hours!=null&&hours.isFinite()&&hours in .25..200.0){"预计投入需要为 0.25–200 小时"}
        val saved=row.toMutableMap();saved["effortHours"]=JsonPrimitive(hours)
        if(group=="tasks") {
            val dependencies=proposalDependencies(row)
            require(dependencies.none{it.isBlank()}&&dependencies.distinct().size==dependencies.size&&proposalItemKey(group,row,index) !in dependencies){"前置任务不能包含自身、空值或重复条目"}
            if("dependsOn" in row)saved["dependsOn"]=JsonArray(dependencies.map(::JsonPrimitive))
        }
        JsonObject(saved)
    })}
    return buildJsonObject{put("expectedRevision",revision);put("payload",JsonObject(normalized));put("reason",reason.trim())}
}

internal fun proposalFeedbackBody(id:String,reason:String):JsonObject {
    require(reason.trim().length in 1..4000){"请填写重新反馈的理由"}
    return buildJsonObject{put("targetType","proposal");put("targetId",id);put("feedback",reason.trim());put("requestAiRedo",true)}
}

@Composable internal fun TaskProposalControls(repository:ClientRepository,base:String,proposal:JsonObject,tasks:List<JsonObject>,members:List<JsonObject>,onChanged:()->Unit) {
    key(base,proposal.twText("proposalId"),repository.accountId,repository.epoch) { TaskProposalEditor(repository,base,proposal,tasks,members,onChanged) }
}

@Composable private fun TaskProposalEditor(repository:ClientRepository,base:String,proposal:JsonObject,tasks:List<JsonObject>,members:List<JsonObject>,onChanged:()->Unit) {
    val id=proposal.twText("proposalId");val path="$base/collaboration/proposals/${Uri.encode(id)}";val owner=repository.accountId;val epoch=repository.epoch;val scope=rememberCoroutineScope()
    var open by remember{mutableStateOf(false)};var payload by remember{mutableStateOf(proposal.obj("payload"))};var savedPayload by remember{mutableStateOf(payload)}
    var revision by remember{mutableIntStateOf(twRevision(proposal))};var status by remember{mutableStateOf(proposal.twText("status"))};var fetched by remember{mutableStateOf<JsonObject?>(null)}
    var excluded by remember{mutableStateOf(emptySet<String>())};var reason by remember{mutableStateOf("")};var error by remember{mutableStateOf<String?>(null)};var message by remember{mutableStateOf("")}
    var conflict by remember{mutableStateOf(false)};var busy by remember{mutableStateOf(false)};var confirm by remember{mutableStateOf<String?>(null)};var applied by remember{mutableStateOf(false)};var followup by remember{mutableStateOf<String?>(null)}
    val latest=fetched?.takeIf{twRevision(it)>=twRevision(proposal)}?:proposal
    val outdated=conflict||revision!=twRevision(latest)||status!=latest.twText("status")
    val editable=!applied&&latest.twText("status") in setOf("pending","stale","rejected")
    val dirty=payload!=savedPayload
    AssessmentDraft(repository,"proposal-editor:$base:$id",buildJsonObject{put("open",open);put("payload",payload);put("savedPayload",savedPayload);put("revision",revision);put("status",status);put("reason",reason);put("excluded",JsonArray(excluded.sorted().map(::JsonPrimitive)))},restore={row->
        open=row.flag("open");payload=row.obj("payload");savedPayload=row.obj("savedPayload");revision=row.twText("revision").toIntOrNull()?:revision;status=row.twText("status");reason=row.twText("reason");excluded=row.twIds("excluded").toSet()
    },failure={error=it})
    suspend fun readLatest():JsonObject {
        val current=assessmentPages(repository,"$base/collaboration/proposals?limit=100").firstOrNull{it.twText("proposalId")==id}?:error("该方案已不可访问；本机修改仍保留")
        check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};fetched=current;return current
    }
    suspend fun refreshAfterConfirmedWrite(){try{readLatest()}catch(e:CancellationException){throw e}catch(e:Exception){error="操作已由服务端确认；最新方案暂未读取，请仅刷新核对：${e.message}"}}
    fun run(block:suspend ()->Unit){if(busy)return;busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){if(e is ApiException&&e.status==409){conflict=true;try{readLatest()}catch(cancel:CancellationException){throw cancel}catch(_:Exception){}};error=(e.message?:"操作失败")+"；输入和选择保留，请读取最新方案核对。不会自动重试。"}finally{busy=false}}}
    fun update(group:String,index:Int,field:String,value:JsonElement){val rows=payload.twRows(group).toMutableList();rows[index]=JsonObject(rows[index]+(field to value));payload=JsonObject(payload+(group to JsonArray(rows)))}
    OutlinedButton({open=!open}){Text("修正建议、部分应用或重新反馈")}
    if(!open)return
    NativeAiReferenceBadge()
    Text("本机基于 r$revision · ${proposalStatus(status)}；当前 r${latest.twText("revision")} · ${proposalStatus(latest.twText("status"))}")
    if(payload.twRows("references").any{it.twText("resourceType")=="decision"})Text("来源已移除：历史决策记录不能重新读取，请核对现有资料。",color=MaterialTheme.colorScheme.error)
    TextButton({run{readLatest();message="已读取最新方案，本机修改和选择保留"}},enabled=!busy){Text("读取最新方案（保留本机修改）")}
    fetched?.let{current->Text("已读取方案 r${current.twText("revision")} · ${proposalStatus(current.twText("status"))}",style=MaterialTheme.typography.titleSmall);TaskWorkspaceNamedValues(current.obj("payload"))}
    if(outdated){
        Text("方案已变化。请核对当前内容和状态，再决定是否保留本机修改继续。",color=MaterialTheme.colorScheme.error)
        if(fetched!=null&&editable)TextButton({
            if(!dirty){payload=latest.obj("payload");savedPayload=payload};revision=twRevision(latest);status=latest.twText("status");excluded=excluded.intersect(proposalSelectionKeys(payload));conflict=false;message="已确认当前版本，本机修改保留；编辑内容须先保存后应用"
        },enabled=!busy){Text("已核对最新方案，保留修改并继续")}
    }
    if(editable)proposalGroups.forEach{group->payload.twRows(group).forEachIndexed{index,row->key("$group:${proposalItemKey(group,row,index)}"){
        val token="$group:${proposalItemKey(group,row,index)}"
        val title=row.twText("title").ifBlank{tasks.firstOrNull{it.twText("taskId")==row.twText("taskId")}?.twText("title")?:"分工条目 ${index+1}"}
        Card(Modifier.fillMaxWidth().testTag("proposal-row-$token")){Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            Row{Checkbox(token !in excluded,{checked->excluded=if(checked)excluded-token else excluded+token},modifier=Modifier.testTag("proposal-select-$token"),enabled=!busy);Text("应用此条目：$title",Modifier.padding(top=12.dp))}
            if(group=="assignments") {
                Text("执行人");if(!busy)TaskWorkspaceMemberPicker(members,row.twText("assigneeId").takeIf{it.isNotBlank()}){update(group,index,"assigneeId",it?.let(::JsonPrimitive)?:JsonNull)}else Text("保存中，暂不可更改执行人")
                ProposalField(!busy,"分工理由",row.twText("reason"),{update(group,index,"reason",JsonPrimitive(it))},2000,2)
            }else {
                ProposalField(!busy,"任务名称",row.twText("title"),{update(group,index,"title",JsonPrimitive(it))},200)
                ProposalField(!busy,"任务说明",row.twText("detail"),{update(group,index,"detail",JsonPrimitive(it))},4000,2)
                ProposalField(!busy,"验收标准",row.twText("criteria"),{update(group,index,"criteria",JsonPrimitive(it))},4000,2)
                ProposalField(!busy,"预计投入（小时）",row.twText("effortHours"),{update(group,index,"effortHours",JsonPrimitive(it))},16)
                val parentField=if(group=="tasks")"parent"else"parentTaskId"
                val parentValue=if(parentField in row)row.twText(parentField)else tasks.firstOrNull{it.twText("taskId")==row.twText("taskId")}?.twText("parentTaskId").orEmpty()
                ProposalField(!busy,"父任务标识（留空为无父任务）",parentValue,{update(group,index,parentField,it.takeIf(String::isNotBlank)?.let(::JsonPrimitive)?:JsonNull)},200)
                if(group=="tasks") {
                    Text("本条标识：${proposalItemKey(group,row,index)}",style=MaterialTheme.typography.bodySmall)
                    ProposalField(!busy,"前置任务标识（逗号分隔）",if(row["dependsOn"] is JsonPrimitive)row.twText("dependsOn")else row.twIds("dependsOn").joinToString(","),{text->update(group,index,"dependsOn",JsonPrimitive(text))},4000)
                    Text("可用前置任务："+(payload.twRows("tasks").mapIndexed{n,item->"${proposalItemKey("tasks",item,n)}：${item.twText("title")}"}+tasks.map{"${it.twText("taskId")}：${it.twText("title")}"}).joinToString("；"),style=MaterialTheme.typography.bodySmall)
                }
            }
        }}
    }}}
    if(!editable)Text("已应用建议保留为历史；请在任务详情修改当前任务，或提交重新反馈。")
    ProposalField(!busy,"修正理由或重新反馈",reason,{reason=it},4000,3)
    if(editable){
        Button({confirm="revise"},enabled=!busy&&!outdated&&reason.isNotBlank()){Text("保存方案修正")}
        Button({confirm="apply"},enabled=!busy&&!outdated&&!dirty&&status=="pending"){Text("应用选中条目")}
        if(dirty)Text("本机建议已编辑，请先保存修正，再应用选中条目。",style=MaterialTheme.typography.bodySmall)
    }
    Button({confirm="feedback"},enabled=!busy&&reason.isNotBlank()){Text("反馈并要求 AI 重新判断")}
    if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(message.isNotBlank())Text(message)
    followup?.let{NativeJobExecution(repository,it,onSettled=onChanged)}
    confirm?.let{chosen->AlertDialog(onDismissRequest={confirm=null},title={Text(when(chosen){"revise"->"保存方案修正？";"apply"->"应用选中条目？";else->"保存重新反馈？"})},text={Text(when(chosen){"revise"->"按已核对的 r$revision 保存人工修改，原始 AI 建议及修订记录保留。";"apply"->"只应用勾选条目；没有勾选条目的类别将显式提交空数组。确认计划可能继续后续 AI 任务，产生模型费用。";else->"保存对此建议的反馈并使待确认建议失效。后端返回是否排队；不会由客户端自动发起新的模型请求。"})},confirmButton={TextButton({confirm=null;run{
        check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
        when(chosen){
            "revise"->{check(!outdated&&editable){"请先核对最新方案"};val body=proposalRevisionBody(revision,payload,reason);val schema=NativeContracts.operations.first{it.method=="PATCH"&&it.path=="/api/v1/projects/{projectId}/collaboration/proposals/{proposalId}"}.schema;validate(schema,body)?.let{error(it)};val result=repository.requestDurably("proposal-revise:$id","PATCH",path,body);fetched=result;payload=result.obj("payload");savedPayload=payload;revision=twRevision(result);status=result.twText("status");conflict=false;message="方案修正已保存，原始 AI 建议与修订记录保留"}
            "apply"->{check(!outdated&&!dirty&&status=="pending"){"请先保存修改并核对最新版本"};val result=repository.requestDurably("proposal-apply:$id","POST","$path/apply",proposalApplyBody(revision,payload,excluded));applied=true;followup=result.twText("followupJobId").takeIf(String::isNotBlank);message="选中条目已应用";result.twText("followupError").takeIf(String::isNotBlank)?.let{message+="；后续处理未启动：$it"};refreshAfterConfirmedWrite()}
            "feedback"->{val result=repository.requestDurably("proposal-feedback:$id","POST","$base/collaboration/feedback",proposalFeedbackBody(id,reason));message=if(result.flag("queued"))"反馈已保存，后端已排队"else"反馈已保存，未排队模型任务；需要时请明确请求新的 AI 建议";refreshAfterConfirmedWrite()}
        };onChanged()
    }}){Text("确认")}},dismissButton={TextButton({confirm=null}){Text("取消")}})}
}

private fun proposalStatus(value:String)=mapOf("pending" to "待确认","stale" to "已过期","rejected" to "已拒绝","applied" to "已应用")[value]?:value

@Composable private fun ProposalField(enabled:Boolean,label:String,value:String,onChange:(String)->Unit,max:Int,lines:Int=1){
    ReferenceOutlinedTextField(value,{if(it.length<=max)onChange(it)},Modifier.fillMaxWidth(),enabled=enabled,label=label,minLines=lines)
}

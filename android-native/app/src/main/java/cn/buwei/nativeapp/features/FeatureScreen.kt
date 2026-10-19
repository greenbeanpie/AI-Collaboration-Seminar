package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.*
import java.util.UUID

private data class Destination(val path:String,val title:String,val bindings:Map<String,String> = emptyMap())
private data class FormDestination(val operation:NativeOperation,val bindings:Map<String,String>,val initial:JsonObject=JsonObject(emptyMap()))
private val projectPrefix="/api/v1/projects/{projectId}"
private fun operation(method:String,path:String)=NativeContracts.operations.first{it.method==method&&it.path==path}
private fun projectPath(id:String,suffix:String="")="/api/v1/projects/${Uri.encode(id)}$suffix"

/** Native business entry points. API contract tools are deliberately labelled advanced, not parity. */
@Composable
fun FeatureScreen(repository:ClientRepository,section:String,projectId:String?,onProject:(String)->Unit,onNavigate:(String)->Unit){
 var destination by remember(section,projectId,repository.accountId){mutableStateOf<Destination?>(null)}
 var form by remember(section,projectId,repository.accountId){mutableStateOf<FormDestination?>(null)}
 var advanced by remember(section,projectId){mutableStateOf(false)}
 val bindings=if(projectId==null)emptyMap()else mapOf("projectId" to projectId)
 BackHandler(form!=null||destination!=null||advanced){when{form!=null->form=null;destination!=null->destination=null;else->advanced=false}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  if(form!=null){TextButton({form=null}){Text("返回")};OperationForm(repository,form!!){form=null};return@Column}
  if(destination!=null){TextButton({destination=null}){Text("返回")};ResourceView(repository,destination!!,onProject,{destination=it},{form=it});return@Column}
  val title=mapOf("projects" to "我的项目","overview" to "项目概览","tasks" to "任务协作","data" to "项目资料","team" to "团队","assessment" to "标准与评估","rehearsals" to "答辩演练","ledger" to "活动历史","export" to "成果导出","project-settings" to "项目设置","profile" to "账户与个人资料","notifications" to "通知","support" to "帮助工单","help" to "使用帮助","accounts" to "账户管理","system" to "系统管理","ai-settings" to "AI 配置","bridges" to "Agent Bridge","create-project" to "创建项目","join" to "加入项目")[section]?:section
  Text(title,style=MaterialTheme.typography.headlineSmall)
  if(advanced){TextButton({advanced=false}){Text("返回业务页面")};AdvancedActions(repository,section,bindings){form=it};return@Column}
  fun open(path:String,name:String,ids:Map<String,String> = bindings){destination=Destination(path,name,ids)}
  fun action(method:String,path:String,initial:JsonObject=JsonObject(emptyMap())){form=FormDestination(operation(method,path),bindings,initial)}
  when(section){
   "projects"->{Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Button({onNavigate("create-project")}){Text("创建项目")};OutlinedButton({onNavigate("join")}){Text("加入项目")}};ResourceView(repository,Destination("/api/v1/projects","我的项目"),onProject,{destination=it},{form=it})}
   "create-project"->{Button({action("POST","/api/v1/projects",buildJsonObject{put("aiCollaborationEnabled",false)})}){Text("手动创建")};OutlinedButton({open("/api/v1/project-templates","项目模板")}){Text("从模板创建")};OutlinedButton({open("/api/v1/creation-drafts","创建草稿")}){Text("继续草稿")}}
   "join"->{Button({action("POST","/api/v1/invitations/preview")}){Text("预览邀请码")};OutlinedButton({action("POST","/api/v1/invitations/accept")}){Text("接受邀请码")};ResourceView(repository,Destination("/api/v1/invitations/inbox","收到的邀请"),onProject,{destination=it},{form=it})}
   "profile"->{ResourceView(repository,Destination("/api/v1/auth/session","账户"),onProject,{destination=it},{form=it});OutlinedButton({action("PATCH","/api/v1/auth/profile")}){Text("修改账户资料")};OutlinedButton({action("POST","/api/v1/auth/password")}){Text("修改密码")};OutlinedButton({open("/api/v1/auth/personal-profile","个人资料")}){Text("全局个人资料")};OutlinedButton({open("/api/v1/auth/recovery-email","恢复邮箱")}){Text("恢复邮箱")}}
   "notifications"->{Row{OutlinedButton({action("POST","/api/v1/notifications/read-all")}){Text("全部已读")};TextButton({open("/api/v1/notifications/settings","通知设置")}){Text("设置")}};ResourceView(repository,Destination("/api/v1/notifications","通知"),onProject,{destination=it},{form=it})}
   "support"->{Button({action("POST","/api/v1/support/tickets")}){Text("新建工单")};ResourceView(repository,Destination("/api/v1/support/tickets","工单"),onProject,{destination=it},{form=it})}
   "help"->{Text("在项目中管理任务、资料和成员。所有 AI 生成、提交、删除操作均需主动确认。操作失败时保留表单；网络超时不会自动重复付费请求。资料导入、录制和离线同步入口由客户端工具提供。");OutlinedButton({onNavigate("support")}){Text("联系支持")}}
   "accounts"->{Button({action("POST","/api/v1/admin/account-invitations")}){Text("创建注册码")};ResourceView(repository,Destination("/api/v1/admin/accounts","账户列表"),onProject,{destination=it},{form=it})}
   "system"->{listOf("/api/v1/resource-usage" to "资源用量","/api/v1/admin/resource-policy" to "资源策略","/api/v1/admin/storage-inventory" to "存储清单","/api/v1/admin/ai-execution-policy" to "AI 执行策略","/api/v1/admin/ai-retries" to "失败请求重试","/api/v1/admin/ai-diagnostics" to "AI 诊断","/api/v1/admin/idempotency/stuck" to "滞留操作","/api/v1/admin/ai-resource-dispatches" to "AI 并发核对").forEach{(p,t)->OutlinedButton({open(p,t)}){Text(t)}}}
   "ai-settings"->ResourceView(repository,Destination("/api/v1/admin/ai-config","AI 配置"),onProject,{destination=it},{form=it})
   "bridges"->{Button({action("POST","/api/v1/agent-bridges/pairings")}){Text("创建配对")};ResourceView(repository,Destination("/api/v1/agent-bridges/devices","已连接设备"),onProject,{destination=it},{form=it})}
   else->{if(projectId==null){Text("请先选择项目");return@Column};val base=projectPath(projectId)
    when(section){
     "overview"->{ResourceView(repository,Destination(base,"项目",bindings),onProject,{destination=it},{form=it});listOf("tasks" to "任务","data" to "资料","team" to "团队","assessment" to "评估","rehearsals" to "演练","ledger" to "活动","export" to "导出","project-settings" to "设置").forEach{(s,t)->OutlinedButton({onNavigate(s)},Modifier.fillMaxWidth()){Text(t)}};OutlinedButton({open("$base/ai-chat","项目 AI")}){Text("项目 AI 对话")};OutlinedButton({open("$base/agent-sessions","AI 补位")}){Text("AI 补位会话")}}
     "tasks"->{Button({action("POST","$projectPrefix/tasks")}){Text("新建任务")};OutlinedButton({open("$base/tasks/graph","任务依赖图")}){Text("依赖与统计")};ResourceView(repository,Destination("$base/tasks","任务",bindings),onProject,{destination=it},{form=it})}
     "data"->{Text("资料统一入口",style=MaterialTheme.typography.titleMedium);Button({action("POST","$projectPrefix/materials")}){Text("新增成果材料")};OutlinedButton({action("POST","$projectPrefix/sources",buildJsonObject{put("kind","paste");put("purpose","reference")})}){Text("新增文本或网页资料")};listOf("resource-library" to "全部资料","materials" to "成果材料","sources" to "来源原文","files" to "文件与回收站").forEach{(p,t)->OutlinedButton({open("$base/$p",t)}){Text(t)}}}
     "team"->{ResourceView(repository,Destination("$base/members","成员",bindings),onProject,{destination=it},{form=it});listOf("invitations" to "邀请码","username-invitations" to "用户名邀请","invitation-requests" to "加入申请").forEach{(p,t)->OutlinedButton({open("$base/$p",t)}){Text(t)}}}
     "assessment"->listOf("standards" to "评估标准","assessments" to "评估与人工修正","requirement-sets" to "要求集","rubrics" to "评分标准","reviews" to "预审记录").forEach{(p,t)->OutlinedButton({open("$base/$p",t)}){Text(t)}}
     "rehearsals"->{Button({action("POST","$projectPrefix/rehearsals")}){Text("开始答辩演练")};ResourceView(repository,Destination("$base/rehearsals","演练历史",bindings),onProject,{destination=it},{form=it})}
     "ledger"->ResourceView(repository,Destination("$base/events","活动历史",bindings),onProject,{destination=it},{form=it})
     "export"->ResourceView(repository,Destination("$base/export-bundle","成果汇总",bindings),onProject,{destination=it},{form=it})
     "project-settings"->{ResourceView(repository,Destination(base,"设置",bindings),onProject,{destination=it},{form=it});OutlinedButton({open("$base/collaboration/settings","协作设置")}){Text("协作设置")};OutlinedButton({open("$base/goal","项目目标")}){Text("项目目标")}}
    }
   }
  }
  HorizontalDivider();TextButton({advanced=true}){Text("高级操作 · 原生接口表单")};Text("高级表单覆盖接口契约，不代表复杂业务与实机体验已完成验收。",style=MaterialTheme.typography.bodySmall)
 }
}

@Composable
private fun AdvancedActions(repository:ClientRepository,section:String,bindings:Map<String,String>,onAction:(FormDestination)->Unit){
 var search by rememberSaveable{mutableStateOf("")};var admin by remember(repository.accountId){mutableStateOf(false)}
 LaunchedEffect(repository.accountId){admin=runCatching{repository.get("/api/v1/auth/session").obj("user").flag("isAdmin")}.getOrDefault(false)}
 OutlinedTextField(search,{search=it},label={Text("搜索操作或路径")},modifier=Modifier.fillMaxWidth())
 NativeContracts.operations.filter{(admin||!it.path.startsWith("/api/v1/admin/"))&&(bindings.isNotEmpty()||!it.path.contains("{projectId}"))&&(search.isBlank()||it.title.contains(search,true)||it.path.contains(search,true))}.forEach{op->
  OutlinedButton({onAction(FormDestination(op,bindings))},Modifier.fillMaxWidth()){Column{Text(op.title);Text("${op.method} ${op.path}",style=MaterialTheme.typography.labelSmall)}}
 }
}

@Composable
private fun OperationForm(repository:ClientRepository,destination:FormDestination,onDone:()->Unit){
 val op=destination.operation;val scope=rememberCoroutineScope();var body by remember(op,destination){mutableStateOf(destination.initial)};val params=remember(op,destination){mutableStateMapOf<String,String>().apply{putAll(destination.bindings)}}
 val intentKey=remember(op,body,params.toMap()){UUID.randomUUID().toString()}
 var error by remember{mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};var confirm by remember{mutableStateOf(false)};var result by remember{mutableStateOf<JsonObject?>(null)};var submitted by remember{mutableStateOf(false)}
 Text(op.title,style=MaterialTheme.typography.titleLarge)
 if(op.binary){Text("此接口需要原生文件流，请使用文件/媒体工具中的上传或下载入口。此表单不发送损坏的文本替代文件。");return}
 op.parameters.forEach{element->val p=element.jsonObject;val name=p.text("name");if(p.text("in")in listOf("path","query"))SchemaField(name,p.obj("schema"),params[name]?.let{JsonPrimitive(it)},p.flag("required")){value->if(value==null)params.remove(name)else params[name]=(value as? JsonPrimitive)?.content.orEmpty()}}
 if(op.schema.isNotEmpty())SchemaField("请求内容",op.schema,body,true){body=it as? JsonObject?:JsonObject(emptyMap())}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
 result?.let{Text("操作结果",style=MaterialTheme.typography.titleMedium);StructuredValue(it);it.text("jobId").takeIf{v->v.isNotBlank()}?.let{id->JobMonitor(repository,id)};TextButton(onDone){Text("返回并刷新")}}
 if(!submitted)Button({
  val missing=op.parameters.map{it.jsonObject}.firstOrNull{it.flag("required")&&params[it.text("name")].isNullOrBlank()}
  error=if(missing!=null)"${label(missing.text("name"))} 必填"else if(op.schema.isNotEmpty())validate(op.schema,body)else null
  if(error==null)confirm=true
 },enabled=!busy){Text(if(op.method=="GET")"读取" else "检查并提交")}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text(if(op.method=="GET")"读取信息"else"确认操作")},text={Text(op.title+if(op.method!="GET")"\n将修改服务端状态；AI 操作可能产生费用。请求结果不明时请先查询状态，不自动重发。"else"")},confirmButton={TextButton({confirm=false;busy=true;scope.launch{try{
  var path=op.path;params.forEach{(k,v)->path=path.replace("{$k}",Uri.encode(v))};val query=op.parameters.map{it.jsonObject}.filter{it.text("in")=="query"}.mapNotNull{p->params[p.text("name")]?.takeIf{it.isNotBlank()}?.let{"${Uri.encode(p.text("name"))}=${Uri.encode(it)}"}.joinToString("&");if(query.isNotBlank())path+="?$query"
  result=repository.request(op.method,path,if(op.schema.isEmpty())null else body,if(op.method=="GET")null else intentKey);submitted=true;error=null
 }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message?:"操作失败；表单已保留。请先确认服务器状态。"}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton({confirm=false}){Text("取消")}})
}

@Composable
private fun JobMonitor(repository:ClientRepository,jobId:String){
 var job by remember(jobId,repository.accountId){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)};var events by remember{mutableStateOf<JsonObject?>(null)}
 LaunchedEffect(jobId,repository.accountId){var interval=2000L;while(isActive){try{val current=repository.get("/api/v1/jobs/${Uri.encode(jobId)}");job=current;error=null;events=runCatching{repository.get("/api/v1/jobs/${Uri.encode(jobId)}/activity-events")}.getOrNull();if(current.text("status")in listOf("succeeded","failed","cancelled"))break}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break};delay(interval);interval=(interval+1000L).coerceAtMost(10000L)}}
 Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){Text("后台执行状态",style=MaterialTheme.typography.titleMedium);job?.let{StructuredValue(it)};error?.let{Text(it,color=MaterialTheme.colorScheme.error)};events?.let{data->val items=(data["items"]as? JsonArray).orEmpty();Text("本页操作记录 ${items.size} 条（含失败记录）",style=MaterialTheme.typography.bodySmall);StructuredValue(data)}}}
}

@Composable
private fun ResourceView(repository:ClientRepository,destination:Destination,onProject:(String)->Unit,onOpen:(Destination)->Unit,onForm:(FormDestination)->Unit){
 var data by remember(destination,repository.accountId){mutableStateOf<JsonObject?>(null)};var failure by remember{mutableStateOf<String?>(null)};var refresh by remember{mutableIntStateOf(0)};var busy by remember{mutableStateOf(false)};var search by rememberSaveable(destination.path){mutableStateOf("")};var applied by remember{mutableStateOf("")};var cursor by remember{mutableStateOf<String?>(null)};var previous by remember{mutableStateOf<List<JsonElement>>(emptyList())}
 LaunchedEffect(destination,repository.accountId,refresh,applied,cursor){busy=true;try{val query=listOfNotNull(applied.takeIf{it.isNotBlank()}?.let{"q=${Uri.encode(it)}"},cursor?.let{"cursor=${Uri.encode(it)}"}).joinToString("&");val loaded=repository.get(destination.path+(if(query.isEmpty())""else if(destination.path.contains('?'))"&$query"else"?$query"));data=if(cursor!=null&&loaded["items"]is JsonArray)JsonObject(loaded+mapOf("items" to JsonArray(previous+loaded["items"]!!.jsonArray)))else loaded;failure=null}catch(e:CancellationException){throw e}catch(e:Exception){failure=e.message}finally{busy=false}}
 Text(destination.title,style=MaterialTheme.typography.titleLarge)
 val canonical=NativeContracts.operations.firstOrNull{it.method=="GET"&&bindPath(it.path,destination.bindings)==destination.path}?.path
 val hasSearch=NativeContracts.operations.firstOrNull{it.method=="GET"&&it.path==canonical}?.parameters?.any{it.jsonObject.text("name")=="q"}==true
 if(hasSearch){OutlinedTextField(search,{search=it},label={Text("搜索")},modifier=Modifier.fillMaxWidth());TextButton({cursor=null;previous=emptyList();applied=search}){Text("搜索")}}
 TextButton({cursor=null;previous=emptyList();refresh++},enabled=!busy){Text("刷新")}
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());failure?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 data?.let{payload->
  if(payload["items"] is JsonArray){val items=payload["items"]!!.jsonArray;if(items.isEmpty())Text("暂无记录")
   items.forEach{element->val item=element as? JsonObject;if(item==null)StructuredValue(element)else{
    val ids=destination.bindings+extractIds(item);val detail=detailOperation(canonical,item,ids)
    Card(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
     Text(itemTitle(item),style=MaterialTheme.typography.titleMedium);Text(listOf("status","lifecycleState","createdAt","dueDate").mapNotNull{item.text(it).takeIf{v->v.isNotBlank()}}.joinToString(" · "),style=MaterialTheme.typography.bodySmall)
     if(canonical=="/api/v1/projects")TextButton({(item.text("id").ifBlank{item.text("projectId")}).takeIf{it.isNotBlank()}?.let(onProject)}){Text("打开项目")}
     if(detail!=null)TextButton({val detailIds=ids.toMutableMap();if(item.text("id").isNotBlank())Regex("\\{([^}]+)}").findAll(detail.path).lastOrNull()?.groupValues?.get(1)?.let{detailIds[it]=item.text("id")};onOpen(Destination(bindPath(detail.path,detailIds),itemTitle(item),detailIds))}){Text("查看详情")}
     var expanded by remember{mutableStateOf(false)};TextButton({expanded=!expanded}){Text(if(expanded)"收起"else"展开内容")};if(expanded)StructuredValue(item)
     ContextActions(repository,canonical,item,ids,onOpen,onForm)
    }}
    }}
   payload.text("nextCursor").takeIf{it.isNotBlank()}?.let{next->OutlinedButton({previous=payload["items"]!!.jsonArray;cursor=next},enabled=!busy){Text("加载更多")}}
  }else{StructuredValue(payload);val ids=destination.bindings+extractIds(payload);if(canonical=="$projectPrefix/materials/{materialId}"&&payload.flag("canEdit"))MaterialEditor(repository,destination.path,payload);ContextActions(repository,canonical,payload,ids,onOpen,onForm)}
  val create=NativeContracts.operations.firstOrNull{it.path==canonical&&it.method=="POST"&&!it.binary};if(create!=null)OutlinedButton({onForm(FormDestination(create,destination.bindings))}){Text(create.title)}
 }
}

private fun itemTitle(item:JsonObject)=listOf("title","name","displayName","subject","username","summary","body","message","id","taskId","materialId").firstNotNullOfOrNull{item.text(it).takeIf{v->v.isNotBlank()}}?:"记录"
private fun bindPath(path:String,ids:Map<String,String>):String {var p=path;ids.forEach{(k,v)->p=p.replace("{$k}",Uri.encode(v))};return p}
private fun extractIds(item:JsonObject):Map<String,String>{val result=item.filter{(k,v)->(k=="id"||k.endsWith("Id"))&&v is JsonPrimitive&&!v.contentOrNull.isNullOrBlank()}.mapValues{it.value.jsonPrimitive.content}.toMutableMap();item.obj("currentVersion").text("versionId").takeIf{it.isNotBlank()}?.let{result["versionId"]=it;result["sourceVersionId"]=it};item.text("currentVersionId").takeIf{it.isNotBlank()}?.let{result["sourceVersionId"]=it};return result}
private fun detailOperation(canonical:String?,item:JsonObject,ids:Map<String,String>):NativeOperation?{
 if(canonical==null)return null
 return NativeContracts.operations.firstOrNull{it.method=="GET"&&it.path.startsWith("$canonical/{")&&it.path.removePrefix("$canonical/").count{c->c=='/'}==0&& !bindPath(it.path,ids).contains('{')}
 ?:NativeContracts.operations.firstOrNull{it.method=="GET"&&it.path.startsWith("$canonical/{")&&it.path.removePrefix("$canonical/").count{c->c=='/'}==0&&item.text("id").isNotBlank()}
}

@Composable
private fun ContextActions(repository:ClientRepository,canonical:String?,item:JsonObject,bindings:Map<String,String>,onOpen:(Destination)->Unit,onForm:(FormDestination)->Unit){
 if(canonical==null)return
 var project by remember(bindings["projectId"]){mutableStateOf<JsonObject?>(null)};var isAdmin by remember{mutableStateOf(false)}
 LaunchedEffect(repository.accountId,bindings["projectId"]){isAdmin=runCatching{repository.get("/api/v1/auth/session").obj("user").flag("isAdmin")}.getOrDefault(false);bindings["projectId"]?.let{project=runCatching{repository.get(projectPath(it))}.getOrNull()}}
 val owner=project?.text("myRole")=="owner";val permissions=project?.obj("permissions")?:JsonObject(emptyMap())
 fun allowed(op:NativeOperation):Boolean{
  if(op.path.contains("/admin/")&&!isAdmin)return false
  if(op.method=="GET")return true
  if(op.path.contains("/members/")||op.path.contains("/invitations")||op.path.contains("/username-invitations"))return owner||permissions.flag("teamManage")
  if(op.path.endsWith("/permissions")||op.path.contains("/standards/")||op.path.contains("/rubrics/"))return owner
  if(op.path.endsWith("/scores"))return owner||permissions.flag("scoreCorrect")
  if(op.path.endsWith("/archive")||op.path.endsWith("/unarchive"))return item.flag("canArchive")||owner||permissions.flag("resourceManage")
  if(op.method=="DELETE")return item.flag("canDelete")||owner||permissions.flag("resourceManage")||!op.path.contains("/projects/")
  return true // Server enforces per-task ownership and operation-specific permissions.
 }
 var expanded by remember(canonical){mutableStateOf(false)}
 val itemId=item.text("id")
 val base=if(canonical.endsWith("}"))canonical else if(itemId.isNotBlank())NativeContracts.operations.firstOrNull{it.path.startsWith("$canonical/{")}?.path?.let{candidate->val end=candidate.indexOf('}',canonical.length);if(end>=0)candidate.substring(0,end+1)else null} else null
 val ids=bindings.toMutableMap();if(base!=null&&itemId.isNotBlank()){Regex("\\{([^}]+)}").findAll(base).lastOrNull()?.groupValues?.get(1)?.let{ids[it]=itemId}}
 val prefix=base?:canonical
 val actions=NativeContracts.operations.filter{op->(op.path==prefix&&op.method!="GET"||op.path.startsWith("$prefix/")&&op.path.removePrefix("$prefix/").count{it=='/'}<=1)&&allowed(op)&&!op.binary&&Regex("\\{([^}]+)}").findAll(op.path).all{it.groupValues[1] in ids}}
 if(actions.isEmpty())return
 TextButton({expanded=!expanded}){Text(if(expanded)"收起操作"else"相关操作与历史")}
 if(expanded)actions.forEach{op->TextButton({if(op.method=="GET")onOpen(Destination(bindPath(op.path,ids),op.title,ids))else{val props=op.schema["properties"] as? JsonObject?:JsonObject(emptyMap());val initial=JsonObject(props.keys.mapNotNull{k->when(k){"expectedRevision"->item["revision"]?.let{k to it};else->item[k]?.let{k to it}}}.toMap());onForm(FormDestination(op,ids,initial))}}){Text(op.title)}}
}

@Composable
private fun MaterialEditor(repository:ClientRepository,path:String,material:JsonObject){ NativeRichMaterialEditor(repository,path,material) }

@Composable
internal fun StructuredValue(value:JsonElement,depth:Int=0){
 if(depth>8){Text("内容层级过深，请打开对应详情");return}
 when(value){
  is JsonObject->Column(verticalArrangement=Arrangement.spacedBy(6.dp)){value.forEach{(key,v)->if(v!=JsonNull){if(v is JsonPrimitive){SelectionContainer{Text("${label(key)}：${v.content}",style=MaterialTheme.typography.bodyMedium)}}else{var open by remember(key){mutableStateOf(depth<1)};TextButton({open=!open}){Text("${label(key)} ${if(open)"−"else"+"}")};if(open)Column(Modifier.padding(start=10.dp)){StructuredValue(v,depth+1)}}}}}
  is JsonArray->value.forEachIndexed{i,v->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(8.dp)){Text("${i+1}",style=MaterialTheme.typography.labelSmall);StructuredValue(v,depth+1)}}}
  is JsonPrimitive->SelectionContainer{Text(value.contentOrNull?:"—")}
 }
}

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
import cn.buwei.nativeapp.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal suspend fun aiAllPages(repository:ClientRepository,path:String):List<JsonObject> {
    val seen=mutableSetOf<String>();var cursor:String?=null;val rows=mutableListOf<JsonObject>()
    do {
        val page=repository.get(path+(cursor?.let{(if(path.contains('?'))"&"else"?")+"cursor=${Uri.encode(it)}"}?:""))
        rows+=materialAiPageRows(page)
        cursor=materialAiNextCursor(page)
        if(cursor!=null)check(seen.add(cursor)){"服务返回了重复分页位置，请刷新重试"}
    }while(cursor!=null)
    return rows
}

@Composable fun MaterialAiWorkspace(repository:ClientRepository,projectId:String) {
    val base="/api/v1/projects/${Uri.encode(projectId)}";val owner=repository.accountId;val epoch=repository.epoch
    val scope=rememberCoroutineScope();val drafts=remember(repository){NativeDraftStore(repository)}
    var sessions by remember(projectId,owner){mutableStateOf<List<JsonObject>>(emptyList())}
    var materials by remember(projectId,owner){mutableStateOf<List<JsonObject>>(emptyList())}
    var sources by remember(projectId,owner){mutableStateOf<List<JsonObject>>(emptyList())}
    var tasks by remember(projectId,owner){mutableStateOf<List<JsonObject>>(emptyList())}
    var selected by rememberSaveable(projectId,owner){mutableStateOf<String?>(null)}
    var session by remember(projectId,owner){mutableStateOf<JsonObject?>(null)}
    var aiEnabled by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)}
    var refresh by remember{mutableIntStateOf(0)};var busy by remember{mutableStateOf(false)};var job by remember(projectId,owner){mutableStateOf<String?>(null)}
    var mode by rememberSaveable(projectId,owner){mutableStateOf("do")};var instruction by rememberSaveable(projectId,owner){mutableStateOf("")}
    var role by rememberSaveable(projectId,owner){mutableStateOf("")};var task by rememberSaveable(projectId,owner){mutableStateOf<String?>(null)}
    var chosenMaterials by remember(projectId,owner){mutableStateOf<Set<String>>(emptySet())};var chosenSources by remember(projectId,owner){mutableStateOf<Set<String>>(emptySet())}
    var search by rememberSaveable(projectId,owner){mutableStateOf(false)};var query by rememberSaveable(projectId,owner){mutableStateOf("")}
    var answer by rememberSaveable(selected,owner){mutableStateOf("")};var confirm by remember{mutableStateOf<Pair<String,suspend ()->Unit>?>(null)}
    suspend fun write(path:String,body:JsonObject):JsonObject {check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"};return repository.requestDurably("material-ai:$path","POST",path,body)}
    LaunchedEffect(projectId,owner,refresh) {try{
        aiEnabled=repository.get("/api/v1/capabilities").obj("features").flag("aiEnabled")
        sessions=aiAllPages(repository,"$base/agent-sessions?status=all&limit=100")
        materials=aiAllPages(repository,"$base/materials?limit=100");sources=aiAllPages(repository,"$base/sources?limit=100");tasks=aiAllPages(repository,"$base/tasks?limit=100")
        error=null
    }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
    LaunchedEffect(projectId,owner,selected,refresh){session=null;selected?.let{id->try{
        val current=repository.networkJson("GET","$base/agent-sessions/${Uri.encode(id)}",expectedOwner=owner,expectedEpoch=epoch)
        session=current;job=materialAiActiveJob(current)
    }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}
    LaunchedEffect(projectId,owner){try{drafts.read("agent-composer:$projectId")?.let{saved->instruction=saved.text("instruction");role=saved.text("roleTemplate");mode=saved.text("mode").ifBlank{"do"};task=saved.text("taskId").takeIf{it.isNotBlank()}}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
    fun rememberComposer(){drafts.scheduleSave("agent-composer:$projectId",buildJsonObject{put("instruction",instruction);put("roleTemplate",role);put("mode",mode);put("taskId",task?.let(::JsonPrimitive)?:JsonNull)})}
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
        Text("成果 AI 协作",style=MaterialTheme.typography.headlineSmall)
        Text("让 AI 起草、带着你完成，或只作审阅。结果先作为草稿，人工核对后才进入正式材料。")
        if(!aiEnabled)Text("AI 当前不可用；仍可阅读历史和核对已有草稿。")
        error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        TaskWorkspaceChoice("协助方式",listOf("do" to "直接起草","guide" to "引导完成","review_only" to "仅审阅"),mode){mode=it;rememberComposer()}
        TaskWorkspaceField("角色或任务背景",role,{role=it;rememberComposer()},200,aiReference=true)
        TaskWorkspaceField("本次协助要求",instruction,{instruction=it;rememberComposer()},4000,3,aiReference=true)
        Text("关联任务（可选）",style=MaterialTheme.typography.titleSmall)
        AiChoice(tasks,"taskId","title",task){task=it;rememberComposer()}
        AiVersionChoices("固定成果版本",materials,"materialId",chosenMaterials){chosenMaterials=it}
        AiVersionChoices("固定来源版本",sources,"sourceId",chosenSources){chosenSources=it}
        Row {Checkbox(search,{search=it});Text("允许联网检索")}
        if(search)TaskWorkspaceField("检索内容",query,{query=it},500,aiReference=true)
        Button(onClick={confirm="发起 AI 协作？本次会调用已配置模型，可能产生费用。选择的材料与来源版本将固定用于本轮。" to {
            val result=write("$base/agent-sessions",buildJsonObject{put("mode",mode);role.takeIf{it.isNotBlank()}?.let{put("roleTemplate",it)};put("taskId",task?.let(::JsonPrimitive)?:JsonNull);put("instruction",instruction.takeIf{it.isNotBlank()}?.let(::JsonPrimitive)?:JsonNull);put("materialVersionIds",JsonArray(chosenMaterials.sorted().map(::JsonPrimitive)));put("sourceVersionIds",JsonArray(chosenSources.sorted().map(::JsonPrimitive)));put("allowSearch",search);if(search)put("searchQuery",query.trim())})
            selected=result.text("sessionId");job=result.text("jobId");refresh++
        }},enabled=aiEnabled&&!busy&&(!search||query.isNotBlank())){Text("确认发起协作")}
        HorizontalDivider();Row {Text("协作历史",style=MaterialTheme.typography.titleLarge);TextButton(onClick={refresh++},enabled=!busy){Text("刷新")}}
        sessions.forEach {row->TextButton(onClick={selected=row.text("sessionId");job=null;answer=""}){Text(row.text("title").ifBlank{"AI 协作"}+" · "+mapOf("do" to "起草","guide" to "引导","review_only" to "审阅")[row.text("capability")].orEmpty()+" · "+row.text("createdAt"))}}
        session?.let {current->
            Text("当前会话",style=MaterialTheme.typography.titleMedium)
            (current["turns"]as? JsonArray).orEmpty().forEach {element->val turn=element.jsonObject;val payload=turn.obj("payload")
                Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text(if(turn.text("role")=="user")"我的输入"else"AI 结果",style=MaterialTheme.typography.labelMedium)
                    if(turn.text("kind")=="draft"&&turn.text("runId").isNotBlank()) {
                        val run=(current["runs"]as? JsonArray).orEmpty().map{it.jsonObject}.firstOrNull{it.text("runId")==turn.text("runId")}
                        AgentDraftAdoption(repository,projectId,turn.text("runId"),run?.text("status").orEmpty(),payload,materials){refresh++}
                    }else NativeMarkdown(listOf("content","question","answer","markdown","summary","text").firstNotNullOfOrNull{payload.text(it).takeIf(String::isNotBlank)}?:payload.values.filterIsInstance<JsonPrimitive>().mapNotNull{it.contentOrNull}.joinToString("\n"))
                }}
            }
            if(current.text("capability")=="guide"&&current.text("status")=="active") {
                TaskWorkspaceField("回答 AI 的问题",answer,{answer=it;drafts.scheduleSave("agent-answer:$projectId:$selected",buildJsonObject{put("text",it)})},8000,3,aiReference=true)
                LaunchedEffect(selected){drafts.read("agent-answer:$projectId:$selected")?.let{answer=it.text("text")}}
                Button(onClick={confirm="提交回答并继续引导？这可能继续调用模型。" to {val result=write("$base/agent-sessions/${Uri.encode(selected)}/turns",buildJsonObject{put("content",answer.trim())});job=result.text("jobId");answer="";drafts.remove("agent-answer:$projectId:$selected");refresh++}},enabled=aiEnabled&&!busy&&job==null&&answer.isNotBlank()){Text("提交本轮回答")}
            }
        }
        job?.takeIf{it.isNotBlank()}?.let{id->NativeJobExecution(repository,id){if(job==id){job=null;refresh++}}}
        if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    }
    confirm?.let{(notice,action)->AlertDialog(onDismissRequest={confirm=null},title={Text("确认 AI 操作")},text={Text(notice)},confirmButton={TextButton(onClick={confirm=null;busy=true;scope.launch{try{action();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=(e.message?:"操作失败")+"；输入保留，请先核对历史，不会自动重试。"}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton(onClick={confirm=null}){Text("取消")}})}
}

@Composable private fun AiChoice(rows:List<JsonObject>,id:String,title:String,selected:String?,onSelect:(String?)->Unit) {
    var expanded by remember{mutableStateOf(false)}
    OutlinedButton(onClick={expanded=!expanded}){Text(rows.firstOrNull{it.text(id)==selected}?.text(title)?:"请选择（可留空）")}
    if(expanded){TextButton(onClick={onSelect(null);expanded=false}){Text("不关联")};rows.forEach{row->TextButton(onClick={onSelect(row.text(id));expanded=false}){Text(row.text(title))}}}
}
@Composable private fun AiVersionChoices(title:String,rows:List<JsonObject>,id:String,selected:Set<String>,onSelect:(Set<String>)->Unit) {
    var expanded by remember{mutableStateOf(false)}
    TextButton(onClick={expanded=!expanded}){Text("$title · 已选 ${selected.size} / 10")}
    if(expanded)rows.filter{it.text("currentVersionId").isNotBlank()}.forEach {row->val version=row.text("currentVersionId");Row(Modifier.fillMaxWidth()){
        Checkbox(version in selected,{checked->if(!checked)onSelect(selected-version)else if(selected.size<10)onSelect(selected+version)})
        Text(row.text("title").ifBlank{row.text(id)}+" · 版本 "+row.text("revision").ifBlank{row.text("version").ifBlank{"当前"}},Modifier.weight(1f))
    }}
}

@Composable internal fun AgentDraftAdoption(repository:ClientRepository,projectId:String,runId:String,status:String,payload:JsonObject,materials:List<JsonObject>,onAdopted:()->Unit) {
    val owner=repository.accountId;val epoch=repository.epoch
    val originalDoc=(payload["doc"]as? JsonObject)?.takeIf{it.text("type")=="doc"&&it["content"]is JsonArray}
    val initial=payload.text("markdown").ifBlank{originalDoc?.let(::richPlainText).orEmpty()}
    var text by rememberSaveable(runId,owner){mutableStateOf(initial)};var target by rememberSaveable(runId,owner){mutableStateOf<String?>(null)}
    val choices=materials.filter{!it.flag("systemManaged")&&it.text("kind")!="task-file"&&it["canEdit"]?.jsonPrimitive?.booleanOrNull!=false}
    val selectedRevision=choices.firstOrNull{it.text("materialId")==target}?.get("revision")?.jsonPrimitive?.intOrNull
    var reviewed by remember(runId,owner,target,text,selectedRevision,payload){mutableStateOf(false)}
    var reviewedRevision by remember(runId,owner,target,text,selectedRevision,payload){mutableStateOf<Int?>(null)}
    var confirm by remember{mutableStateOf(false)};var busy by remember{mutableStateOf(false)}
    var adopted by remember(runId,owner,status){mutableStateOf(status=="adopted")};var error by remember{mutableStateOf<String?>(null)};val scope=rememberCoroutineScope();val drafts=remember(repository){NativeDraftStore(repository)}
    var recoveryLoaded by remember(runId,owner){mutableStateOf(false)}
    LaunchedEffect(runId,owner){try{drafts.read("agent-adoption:$projectId:$runId",owner?:error("请登录"),epoch)?.let{text=it.text("text");target=it.text("target").takeIf{value->value.isNotBlank()}};recoveryLoaded=true}catch(e:CancellationException){throw e}catch(e:Exception){error="无法读取保留的采纳草稿：${e.message}；不会覆盖旧草稿"}}
    fun persist(){if(recoveryLoaded)drafts.scheduleSave("agent-adoption:$projectId:$runId",buildJsonObject{put("text",text);put("target",target?.let(::JsonPrimitive)?:JsonNull)},onFailure={error="本机草稿保存失败，请保留页面并复制备份：${it.message}"})}
    Text("AI 草稿 · ${if(adopted)"已采纳"else"待人工复核"}",style=MaterialTheme.typography.titleMedium)
    if(originalDoc!=null&&text==initial)Text("未修改时保留原始文档的格式、表格、引用与其他内容块。",style=MaterialTheme.typography.bodySmall)
    OutlinedTextField(text,{if(it.length<=200000){text=it;persist()}},Modifier.fillMaxWidth(),label={Text("核对并编辑草稿 Markdown")},minLines=4,enabled=!adopted&&!busy&&recoveryLoaded)
    if(!adopted){Text("采纳到已有成果材料");if(!busy)AiChoice(choices,"materialId","title",target){target=it;persist()};Row{Checkbox(reviewed,{reviewed=it;reviewedRevision=if(it)selectedRevision else null},enabled=!busy&&recoveryLoaded&&selectedRevision!=null);Text("我已人工复核，确认可保存为正式材料新版本",Modifier.weight(1f))}}
    error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    val hasContent=text.isNotBlank()||(originalDoc!=null&&text==initial)
    Button(onClick={confirm=true},enabled=recoveryLoaded&&reviewed&&reviewedRevision!=null&&target!=null&&hasContent&&!busy&&!adopted&&status=="succeeded"){Text(if(adopted)"已创建正式版本"else"确认复核并采纳")}
    if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("保存 AI 草稿为新材料版本？")},text={Text("将校验所选材料版本，并保留 AI 原草稿和人工修改。不会自动覆盖其他人的修改。")},confirmButton={TextButton(onClick={
        val selectedTarget=target?:return@TextButton;val expected=reviewedRevision?:return@TextButton
        val reviewedText=text;val reviewedPayload=payload;val wasReviewed=reviewed
        confirm=false;busy=true;scope.launch{try {
            check(owner!=null&&owner==repository.accountId&&epoch==repository.epoch){"账户已变化"}
            require(choices.any{it.text("materialId")==selectedTarget}){"目标材料已不可用，请刷新"}
            drafts.save("agent-adoption:$projectId:$runId",buildJsonObject{put("text",reviewedText);put("target",selectedTarget)},owner,epoch)
            val latest=repository.networkJson("GET","/api/v1/projects/${Uri.encode(projectId)}/materials/${Uri.encode(selectedTarget)}",expectedOwner=owner,expectedEpoch=epoch)
            check(latest["revision"]?.jsonPrimitive?.intOrNull==expected){"材料版本已变化，请刷新后重新核对再采纳"}
            val body=materialAiAdoptionBody(reviewedPayload,reviewedText,initial,selectedTarget,expected,wasReviewed)
            check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"}
            repository.requestDurably("agent-adoption:$projectId:$runId","POST","/api/v1/projects/${Uri.encode(projectId)}/agent-runs/${Uri.encode(runId)}/adopt",body)
            check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"}
            adopted=true;drafts.remove("agent-adoption:$projectId:$runId",owner,epoch);onAdopted()
        }catch(e:CancellationException){throw e}catch(e:Exception){reviewed=false;reviewedRevision=null;error=(e.message?:"采纳失败")+"；编辑仍保留，请先核对历史版本并重新复核。"}finally{busy=false}}
    }){Text("确认采纳")}},dismissButton={TextButton(onClick={confirm=false}){Text("取消")}})
}

/** A preserved rich document must let the backend derive Markdown unless the draft supplied it. */
internal fun materialAiAdoptionBody(payload:JsonObject,edited:String,initial:String,materialId:String,expectedRevision:Int,reviewed:Boolean):JsonObject {
    require(reviewed){"采纳必须明确确认已人工复核"};require(expectedRevision>0){"材料版本无效"};require(materialId.isNotBlank()){"请选择目标材料"}
    val original=(payload["doc"]as? JsonObject)?.takeIf{it.text("type")=="doc"&&it["content"]is JsonArray}
    val unchanged=original!=null&&edited==initial
    val document=if(unchanged)original else markdownToNativeDoc(edited)
    require(document.toString().toByteArray().size<=200*1024){"正文超过材料文档保存上限，编辑仍会保留"}
    require(edited.length<=200000){"Markdown 超过保存上限"}
    return buildJsonObject {
        put("materialId",materialId);put("expectedRevision",expectedRevision);put("reviewed",true);put("doc",document)
        if(!unchanged)put("markdown",edited)else payload.text("markdown").takeIf{it.isNotBlank()}?.let{put("markdown",it)}
    }
}

internal fun materialAiPageRows(page:JsonObject):List<JsonObject> =(page["items"]as? JsonArray?:error("列表响应缺少记录")).map{it as? JsonObject?:error("列表记录格式无效")}
internal fun materialAiNextCursor(page:JsonObject):String? {
    require(page.containsKey("nextCursor")){"列表响应缺少分页位置，请刷新重试"}
    val cursor=page["nextCursor"]
    if(cursor==JsonNull)return null
    require(cursor is JsonPrimitive&&cursor.isString&&cursor.content.isNotBlank()){"列表分页位置无效，请刷新重试"}
    return cursor.content
}
/** Detail runs are oldest-first by the existing backend; list summaries may lag behind a new turn. */
internal fun materialAiActiveJob(session:JsonObject):String? {
    val runs=session["runs"]as? JsonArray?:error("会话响应缺少运行状态，请刷新重试")
    val latest=runs.lastOrNull()?.let{it as? JsonObject?:error("运行状态格式无效")}?:return null
    return latest.text("jobId").takeIf{it.isNotBlank()&&latest.text("status")in listOf("queued","running","waiting_input","pending")}
}
internal fun richPlainText(node:JsonObject):String=if(node.text("type")=="text")node.text("text")else (node["content"]as? JsonArray).orEmpty().joinToString(if(node.text("type")in listOf("doc","table","tableRow","bulletList","orderedList"))"\n"else""){(it as? JsonObject)?.let(::richPlainText).orEmpty()}
internal fun markdownToNativeDoc(markdown:String):JsonObject {
    val blocks=mutableListOf<JsonObject>();var list:JsonObject?=null;var code:StringBuilder?=null;var language=""
    fun flushList(){list?.let{blocks+=it};list=null}
    fun paragraph(value:String)=richNode("paragraph",markdownInlineNodes(value))
    for(line in markdown.replace("\r\n","\n").lines()) {
        if(line.trimStart().startsWith("```")){flushList();if(code==null){code=StringBuilder();language=line.trim().removePrefix("```")}else{blocks+=materialAiCodeBlock(code.toString().removeSuffix("\n"),language);code=null};continue}
        if(code!=null){code.append(line).append('\n');continue}
        val bullet=Regex("^\\s*[-*]\\s+(.*)$").matchEntire(line);val ordered=Regex("^\\s*\\d+[.)、]\\s+(.*)$").matchEntire(line)
        if(bullet!=null||ordered!=null){val kind=if(bullet!=null)"bulletList"else"orderedList";if(list?.text("type")!=kind){flushList();list=richNode(kind)};list=richReplaceChildren(list!!,richChildren(list!!)+richNode("listItem",listOf(paragraph((bullet?:ordered)!!.groupValues[1]))));continue}
        flushList();if(line.isBlank())continue
        val heading=Regex("^(#{1,3})\\s+(.*)$").matchEntire(line)
        when{heading!=null->blocks+=richNode("heading",markdownInlineNodes(heading.groupValues[2]),buildJsonObject{put("level",heading.groupValues[1].length)})
            line.startsWith('>')->blocks+=richNode("blockquote",listOf(paragraph(line.drop(1).trimStart())))
            else->blocks+=paragraph(line)}
    }
    flushList();code?.let{blocks+=materialAiCodeBlock(it.toString().removeSuffix("\n"),language)}
    return richNode("doc",blocks)
}
private fun markdownInlineNodes(value:String):List<JsonObject> {
    val regex=Regex("\\*\\*([^*]+)\\*\\*|\\*([^*]+)\\*|`([^`]+)`|\\[([^]]+)]\\((https?://[^)]+)\\)")
    val result=mutableListOf<JsonObject>();var previous=0
    fun text(value:String,kind:String?=null,href:String?=null)=buildJsonObject{put("type","text");put("text",value);if(kind!=null)put("marks",buildJsonArray{add(buildJsonObject{put("type",kind);if(href!=null)put("attrs",buildJsonObject{put("href",href)})})})}
    regex.findAll(value).forEach{match->if(match.range.first>previous)result+=text(value.substring(previous,match.range.first));val kind=when{match.groups[1]!=null->"bold";match.groups[2]!=null->"italic";match.groups[3]!=null->"code";else->"link"};result+=text(match.groups[1]?.value?:match.groups[2]?.value?:match.groups[3]?.value?:match.groupValues[4],kind,match.groups[5]?.value);previous=match.range.last+1}
    if(previous<value.length)result+=text(value.substring(previous));return result
}

private fun materialAiCodeBlock(value:String,language:String)=richNode("codeBlock",if(value.isEmpty())emptyList()else listOf(buildJsonObject{put("type","text");put("text",value)}),buildJsonObject{put("language",language.ifBlank{"text"})})

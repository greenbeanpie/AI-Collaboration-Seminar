package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.voice.VoiceWorkspace
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun rehearsalCreation(scope: String, member: String, materials: Set<String>, sources: Set<String>): JsonObject {
    require(scope in setOf("all", "member")); require(scope != "member" || member.isNotBlank()) { "请选择答辩成员" }
    require(materials.size <= 10 && sources.size <= 5) { "参考版本选择超出限制" }
    return buildJsonObject { put("scope", scope); put("memberId", if (scope == "member") JsonPrimitive(member) else JsonNull); put("materialVersionIds", JsonArray(materials.sorted().map(::JsonPrimitive))); put("sourceVersionIds", JsonArray(sources.sorted().map(::JsonPrimitive))) }
}

@Composable
private fun RehearsalAssessmentResult(repository: ClientRepository, projectId: String, rehearsalId: String, refresh: Int, canCorrect: Boolean, onChanged: () -> Unit, onConfirm: (String, suspend () -> Unit) -> Unit) {
    val base = assessmentBase(projectId); var assessment by remember(rehearsalId) { mutableStateOf<JsonObject?>(null) }; var standard by remember { mutableStateOf<JsonObject?>(null) }; var error by remember { mutableStateOf<String?>(null) }
    val owner = repository.accountId; val epoch = repository.epoch
    LaunchedEffect(rehearsalId, refresh) { try { val record = assessmentPages(repository, "$base/assessments?kind=rehearsal&limit=50").firstOrNull { it.text("rehearsalId") == rehearsalId && !it.flag("historical") }; assessment = record?.let {repository.networkJson("GET","$base/assessments/${Uri.encode(it.text("assessmentId"))}")}; standard = repository.networkJson("GET", "$base/standards/current")["standard"] as? JsonObject } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    assessment?.let { row ->
        Text("本轮答辩评分 · 标准 v${row.text("standardsVersion")} · 评分 r${row.text("revision")}", style = MaterialTheme.typography.titleMedium)
        Text("固定主目标：${row.obj("goal").text("title")} · r${row.text("goalRevision")}")
        AssessmentReport(row.obj("report"))
        if (row["aiReport"] is JsonObject) { Text("原始 AI 建议与当前人工评分"); AssessmentReport(row.obj("aiReport"), row.obj("report")) }
        AssessmentManualEditor(repository, projectId, standard, row, row.obj("goal"), emptySet(), canCorrect && row.text("status") in listOf("succeeded", "failed") && row.text("standardsVersionId") == standard?.text("standardsVersionId")) { body ->
            onConfirm("保存本轮答辩人工修正？只修改已编辑维度，原始 AI 建议保留。") { check(repository.accountId == owner && repository.epoch == epoch); repository.requestDurably("rehearsal-score:$projectId:${row.text("assessmentId")}", "PATCH", "$base/assessments/${Uri.encode(row.text("assessmentId"))}/scores", body); onChanged() }
        }
    }
}

internal fun rehearsalCanAnswer(detail: JsonObject): Boolean {
    val turns = detail.rows("turns"); val latest = turns.lastOrNull()
    return detail.flag("canOperate") && detail.text("status") == "active" && detail.text("processingStatus") !in setOf("queued", "running", "waiting_input") && latest?.text("role") == "assistant" && latest.text("kind") in setOf("question", "followup")
}

@Composable
fun RehearsalWorkspace(repository: ClientRepository, projectId: String, initialRehearsalId:String?=null, initialAssessmentId:String?=null) {
    val account by repository.account.collectAsState()
    key(projectId, account?.text("id"), repository.epoch, initialRehearsalId, initialAssessmentId) { RehearsalWorkspaceContent(repository, projectId, initialRehearsalId, initialAssessmentId) }
}

@Composable
private fun RehearsalWorkspaceContent(repository: ClientRepository, projectId: String, initialRehearsalId:String?, initialAssessmentId:String?) {
    val base = assessmentBase(projectId); val coroutineScope = rememberCoroutineScope(); val owner = repository.accountId; val epoch = repository.epoch
    var aiEnabled by remember { mutableStateOf(false) }; var scope by remember { mutableStateOf("all") }; var member by remember { mutableStateOf("") }; var materials by remember { mutableStateOf(emptySet<String>()) }; var sources by remember { mutableStateOf(emptySet<String>()) }
    var members by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var history by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var project by remember { mutableStateOf(JsonObject(emptyMap())) }; var detail by remember { mutableStateOf<JsonObject?>(null) }
    var selected by remember { mutableStateOf(initialRehearsalId.orEmpty()) }; var answer by remember { mutableStateOf("") }; var refresh by remember { mutableIntStateOf(0) }; var busy by remember { mutableStateOf(false) }; var voiceOpen by remember { mutableStateOf(false) }; var jobId by remember { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }; var confirm by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }
    var linkedAssessment by remember {mutableStateOf<JsonObject?>(null)}
    LaunchedEffect(initialAssessmentId) {if(initialAssessmentId!=null)try {
        val records=assessmentPages(repository,"$base/assessments?kind=rehearsal&limit=50")
        val record=records.firstOrNull{it.text("assessmentId")==initialAssessmentId || it.text("rehearsalId")==initialAssessmentId}?:error("未找到有权访问的答辩记录")
        linkedAssessment=repository.networkJson("GET","$base/assessments/${Uri.encode(record.text("assessmentId"))}")
        selected=record.text("rehearsalId")
    }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
    suspend fun loadHistory() { history = assessmentPages(repository, "$base/rehearsals?limit=30") }
    LaunchedEffect(refresh) { try { aiEnabled = repository.networkJson("GET", "/api/v1/capabilities").obj("features").flag("aiEnabled"); project = repository.networkJson("GET", base); members = assessmentPages(repository, "$base/members"); loadHistory(); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    LaunchedEffect(selected, refresh, voiceOpen) { if (detail?.text("rehearsalId") != selected) detail = null; if (selected.isNotBlank() && !voiceOpen) while (isActive) { try { detail = repository.networkJson("GET", "$base/rehearsals/${Uri.encode(selected)}"); error = null; if (detail?.text("status") != "active") break } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message; break }; delay(4000L) } }
    fun action(block: suspend () -> Unit) { if (busy) return; busy = true; error = null; coroutineScope.launch { try { block(); refresh++ } catch (e: CancellationException) { throw e } catch (e: Exception) { error = (e.message ?: "请求失败") + "；请刷新核对，当前草稿保留，不会自动重放。" } finally { busy = false } } }
    suspend fun send(method: String, tail: String, body: JsonObject? = null): JsonObject { check(repository.accountId == owner && repository.epoch == epoch); return repository.requestDurably("rehearsal:$projectId:$tail", method, base + tail, body) }
    AssessmentDraft(repository, "rehearsal-answer:$projectId:$selected", buildJsonObject { put("answer", answer) }, restore = { answer = it.text("answer") }, failure = { error = it })
    AssessmentDraft(repository, "rehearsal-selection:$projectId", buildJsonObject { put("scope", scope); put("member", member); put("selected", selected); put("materials", JsonArray(materials.map(::JsonPrimitive))); put("sources", JsonArray(sources.map(::JsonPrimitive))) }, restore = { saved -> scope = saved.text("scope").ifBlank { "all" }; member = saved.text("member"); if(initialRehearsalId==null&&initialAssessmentId==null)selected = saved.text("selected"); materials = (saved["materials"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet(); sources = (saved["sources"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet() }, failure = { error = it })
    if (voiceOpen && selected.isNotBlank()) {
        Column(Modifier.fillMaxSize()) { TextButton({ voiceOpen = false; refresh++ }) { Text("返回文字演练与历史") }; Box(Modifier.weight(1f)) { VoiceWorkspace(repository, projectId, selected) } }
    } else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("答辩演练", style = MaterialTheme.typography.headlineSmall)
        if(selected.isBlank())linkedAssessment?.let{Text("引用的历史答辩评分",style=MaterialTheme.typography.titleMedium);AssessmentReport(it.obj("report"))}
        Text("围绕固定目标、标准和资料进行真实问答。只有明确确认的创建、回答和结束操作会调用模型。", style = MaterialTheme.typography.bodySmall)
        TextButton({ refresh++ }, enabled = !busy) { Text("刷新演练与历史") }; error?.let { Text(it, color = MaterialTheme.colorScheme.error) }; if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        AssessmentChoice("演练范围", scope, listOf("all" to "全体答辩", "member" to "指定成员")) { scope = it }
        if (scope == "member") AssessmentChoice("答辩成员", member, members.map { it.text("userId") to it.text("displayName").ifBlank { it.text("name").ifBlank { it.text("username") } } }) { member = it }
        AssessmentReferencePicker(repository, projectId, materials, sources) { m, s -> materials = m; sources = s }
        Button({ val body = rehearsalCreation(scope, member, materials, sources); confirm = "开始本轮答辩演练？后端将固定授权资料并调用模型生成第一问。" to { val result = send("POST", "/rehearsals", body); selected = result.text("rehearsalId"); jobId = result.text("jobId"); answer = "" } }, enabled = aiEnabled && !busy && (scope == "all" || member.isNotBlank()) && (project.text("myRole") == "owner" || project.obj("permissions").flag("scoreInitiate"))) { Text("开始新演练") }
        Button({ val body = buildJsonObject { put("kind", "rehearsal"); put("materialVersionIds", JsonArray(materials.sorted().map(::JsonPrimitive))); put("sourceVersionIds", JsonArray(sources.sorted().map(::JsonPrimitive))) }; confirm = "开始带评分的答辩演练？这会固定主目标、统一标准和成果版本，按本轮真实回答生成维度评分。" to { val result = send("POST", "/assessments", body); selected = result.text("rehearsalId"); jobId = result.text("jobId"); answer = "" } }, enabled = aiEnabled && !busy && (project.text("myRole") == "owner" || project.obj("permissions").flag("scoreInitiate"))) { Text("开始带评分的答辩演练") }
        AssessmentChoice("历史演练", selected, history.mapIndexed { index, row -> row.text("rehearsalId") to "${row.text("createdAt")} · ${if (row.text("scope") == "member") "成员演练" else "全体演练"} · ${if (row.text("status") == "finished") "已结束" else "进行中"} · ${index + 1}" }) { selected = it; answer = ""; jobId = "" }
        detail?.let { current ->
            Text(if (current.text("status") == "finished") "本轮已结束" else "本轮正在进行", style = MaterialTheme.typography.titleMedium)
            current.rows("turns").forEach { turn -> Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = if (turn.text("role") == "user") MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer)) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text("第 ${turn.text("sequence")} 回合 · ${if (turn.text("role") == "user") "真实回答" else when (turn.text("kind")) { "summary" -> "总结"; "followup" -> "追问"; else -> "问题" }}", style = MaterialTheme.typography.labelLarge); NativeMarkdown(turn.text("content")); turn.rows("references").forEach { reference -> Text(reference.text("title").ifBlank { reference.text("quote") }, style = MaterialTheme.typography.bodySmall) } } } }
            val processing = current.text("processingStatus") in listOf("queued", "running", "waiting_input")
            val active = current.flag("canOperate") && current.text("status") == "active"
            if (active) {
                OutlinedTextField(answer, { if (it.length <= 8000) answer = it }, Modifier.fillMaxWidth(), label = { Text("本轮真实回答") }, minLines = 3, enabled = aiEnabled && !busy && !processing)
                Button({ val body = buildJsonObject { put("content", answer.trim()) }; val id = selected; confirm = "提交本轮真实回答？内容将保存并用于后续追问及评分，会调用模型。" to { val result = send("POST", "/rehearsals/${Uri.encode(id)}/answers", body); jobId = result.text("jobId"); answer = "" } }, enabled = aiEnabled && !busy && answer.isNotBlank() && rehearsalCanAnswer(current)) { Text("提交回答") }
                OutlinedButton({ voiceOpen = true }, enabled = aiEnabled && !busy && !processing) { Text("进入原生实时语音演练") }
                Button({ val id = selected; confirm = "结束本轮并生成总结评分？将依据本轮固定资料和真实回答调用模型。" to { val result = send("POST", "/rehearsals/${Uri.encode(id)}/finish"); jobId = result.text("jobId") } }, enabled = aiEnabled && !busy && !processing && current.rows("turns").isNotEmpty()) { Text("结束并生成总结") }
                TextButton({ val id = selected; confirm = "取消并删除本场演练？本场问答及未完成评分不会保存，取消后无法恢复。" to { send("DELETE", "/rehearsals/${Uri.encode(id)}"); selected = ""; detail = null; answer = ""; jobId = "" } }, enabled = !busy) { Text("取消并删除本场演练") }
            } else if (current.text("status") == "active") Text("仅本轮有操作权限的答辩成员可回答或结束。")
            RehearsalAssessmentResult(repository, projectId, selected, refresh, project.text("myRole") == "owner" || project.obj("permissions").flag("scoreCorrect"), onChanged = { refresh++ }, onConfirm = { message, block -> confirm = message to block })
            val visibleJob = jobId.ifBlank { current.text("processingJobId").ifBlank { current.text("aiJobId") } }; if (visibleJob.isNotBlank()) NativeJobExecution(repository, visibleJob, allowResume = aiEnabled && active, onResumed = { jobId = it }, onSettled = { refresh++ })
        }
        if (detail == null && jobId.isNotBlank()) NativeJobExecution(repository, jobId, allowResume = aiEnabled, onResumed = { jobId = it }, onSettled = { refresh++ })
    }
    confirm?.let { (message, block) -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text("确认演练操作") }, text = { Text(message) }, confirmButton = { TextButton({ confirm = null; action(block) }) { Text("确认") } }, dismissButton = { TextButton({ confirm = null }) { Text("取消") } }) }
}

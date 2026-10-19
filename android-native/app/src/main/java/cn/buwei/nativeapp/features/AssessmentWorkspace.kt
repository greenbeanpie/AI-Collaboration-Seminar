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
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

internal fun JsonObject.rows(key: String = "items") = (get(key) as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
internal fun assessmentBase(project: String) = "/api/v1/projects/${Uri.encode(project)}"

@Composable
internal fun AssessmentDraft(repository: ClientRepository, key: String, value: JsonObject, restore: (JsonObject) -> Unit, failure: (String?) -> Unit) {
    val store = remember(repository) { NativeDraftStore(repository) }; var loaded by remember(key) { mutableStateOf(false) }
    val onRestore by rememberUpdatedState(restore); val onFailure by rememberUpdatedState(failure)
    LaunchedEffect(key) { loaded = false; try { store.read(key)?.let(onRestore) } catch (e: CancellationException) { throw e } catch (e: Exception) { onFailure(e.message) }; loaded = true }
    LaunchedEffect(key, value, loaded) { if (loaded) store.scheduleSave(key, value, onFailure = { onFailure(it.message) }) }
}

/** Reads all pages without silently truncating the set of available fixed versions. */
internal suspend fun assessmentPages(repository: ClientRepository, path: String): List<JsonObject> {
    val owner = repository.accountId; val epoch = repository.epoch
    val result = mutableListOf<JsonObject>(); val seen = mutableSetOf<String>(); var cursor = ""
    do {
        val page = repository.networkJson("GET", path + (if (cursor.isBlank()) "" else if (path.contains('?')) "&cursor=${Uri.encode(cursor)}" else "?cursor=${Uri.encode(cursor)}"), expectedOwner = owner, expectedEpoch = epoch)
        result += page.rows(); cursor = page.text("nextCursor")
        check(cursor.isBlank() || seen.add(cursor)) { "分页游标重复，请刷新重试" }
    } while (cursor.isNotBlank())
    return result
}

@Composable
internal fun AssessmentChoice(label: String, selected: String, options: List<Pair<String, String>>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box { OutlinedButton({ expanded = true }, Modifier.fillMaxWidth()) { Text("$label：${options.find { it.first == selected }?.second ?: "请选择"}") }
        DropdownMenu(expanded, { expanded = false }) { options.forEach { (id, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { onChange(id); expanded = false }) } }
    }
}

/** Selections carry immutable version IDs; display labels never require entering an identifier. */
@Composable
internal fun AssessmentReferencePicker(repository: ClientRepository, projectId: String, materials: Set<String>, sources: Set<String>, onChange: (Set<String>, Set<String>) -> Unit) {
    val base = assessmentBase(projectId)
    var opened by remember { mutableStateOf(false) }; var materialRows by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var sourceRows by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var chosen by remember { mutableStateOf("") }; var versions by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(opened, repository.accountId, projectId) { if (opened) try { materialRows = assessmentPages(repository, "$base/materials?limit=100"); sourceRows = assessmentPages(repository, "$base/sources?limit=100") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    LaunchedEffect(chosen) { versions = emptyList(); if (chosen.isNotBlank()) try { versions = assessmentPages(repository, "$base/materials/${Uri.encode(chosen)}/versions?limit=100") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    TextButton({ opened = !opened }) { Text("固定参考版本 · 文档 ${materials.size}/10 · 来源 ${sources.size}/5") }
    if (opened) {
        Text("后续编辑不会替换本轮固定正文。未选择时由后端查阅授权资料。", style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        sourceRows.forEach { source -> val id = source.text("currentVersionId"); if (id.isNotBlank()) Row { Checkbox(id in sources, { checked -> if (!checked || sources.size < 5) onChange(materials, if (checked) sources + id else sources - id) }); Text(source.text("title"), Modifier.padding(top = 12.dp)) } }
        AssessmentChoice("选择文档", chosen, materialRows.map { it.text("materialId") to it.text("title") }) { chosen = it }
        versions.forEach { row -> val id = row.text("versionId"); Row { Checkbox(id in materials, { checked -> if (!checked || materials.size < 10) onChange(if (checked) materials + id else materials - id, sources) }); Text("r${row.text("revision")} · ${row.text("createdAt")}", Modifier.padding(top = 12.dp)) } }
        if (materials.isNotEmpty() || sources.isNotEmpty()) TextButton({ onChange(emptySet(), emptySet()) }) { Text("清除已选版本") }
    }
}

internal data class AssessmentDimension(val key: String = "criterion_" + UUID.randomUUID().toString().replace("-", "").take(20), val label: String = "", val weight: String = "", val citations: List<JsonObject> = emptyList())

internal fun assessmentCorrectionBody(assessment: JsonObject, dimensions: List<JsonObject>, values: Map<String, String>, comments: Map<String, String>, reason: String, summary: String): JsonObject {
    require(reason.isNotBlank() && reason.length <= 4000) { "请填写人工修正理由" }
    val report = assessment.obj("report")
    val edited = dimensions.filter { it.text("key") in values || it.text("key") in comments }
    require(edited.isNotEmpty()) { "请至少修改一个维度" }
    val scores = edited.map { dimension ->
        val id = dimension.text("key"); val existing = report.rows("scores").find { it.text("key") == id }
        val raw = values[id] ?: existing?.text("score").orEmpty(); val number = raw.takeIf { it.isNotBlank() }?.toDoubleOrNull()
        require(raw.isBlank() || number?.let { it.isFinite() && it in 0.0..100.0 } == true) { "分数应为 0–100" }
        val comment = comments[id] ?: existing?.text("comment").orEmpty(); require(comment.length <= 2000 && summary.length <= 8000) { "评语或总体反馈过长" }
        buildJsonObject { put("key", id); put("score", number?.let(::JsonPrimitive) ?: JsonNull); put("comment", comment) }
    }
    return buildJsonObject { put("expectedRevision", assessment["revision"] ?: error("当前评分缺少版本，请刷新")); put("scores", JsonArray(scores)); put("reason", reason.trim()); put("summary", summary) }
}

internal fun assessmentStandardBody(title: String, dimensions: List<AssessmentDimension>): JsonObject {
    require(title.isNotBlank() && title.length <= 200) { "请填写标准名称" }
    require(dimensions.size in 1..10 && dimensions.map { it.key }.distinct().size == dimensions.size) { "需要 1–10 个不同评分维度" }
    require(dimensions.sumOf { it.weight.toDoubleOrNull() ?: 0.0 } > 0) { "总权重必须大于零" }
    require(dimensions.all { it.label.isNotBlank() && it.label.length <= 60 && it.weight.toDoubleOrNull()?.let { n -> n.isFinite() && n in 0.0..100.0 } == true }) { "请填写维度名称及 0–100 的权重" }
    return buildJsonObject { put("title", title.trim()); put("notes", ""); putJsonArray("weights") { dimensions.forEach { d -> add(buildJsonObject { put("key", d.key); put("label", d.label.trim()); put("weight", d.weight.toDouble()) }) } }; putJsonArray("requirements") { dimensions.forEach { d -> add(buildJsonObject { put("title", d.label.trim()); put("detail", ""); put("category", "scoring"); put("dimensionKey", d.key); put("dueDate", JsonNull); put("duePrecision", "unknown"); put("citations", JsonArray(d.citations)) }) } } }
}

@Composable
fun AssessmentWorkspace(repository: ClientRepository, projectId: String, initialAssessmentId:String?=null, initialSection:String?=null) {
    val account by repository.account.collectAsState()
    key(projectId, account?.text("id"), repository.epoch, initialAssessmentId, initialSection) { AssessmentWorkspaceContent(repository, projectId, initialAssessmentId, initialSection) }
}

@Composable
private fun AssessmentWorkspaceContent(repository: ClientRepository, projectId: String, initialAssessmentId:String?, initialSection:String?) {
    val base = assessmentBase(projectId); val scope = rememberCoroutineScope(); val owner = repository.accountId; val epoch = repository.epoch
    var aiEnabled by remember { mutableStateOf(false) }; var section by remember { mutableStateOf(initialSection?.takeIf{it in listOf("standards","assessments","reviews")}?:"standards") }; var refresh by remember { mutableIntStateOf(0) }; var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    var standards by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var records by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var goal by remember { mutableStateOf(JsonObject(emptyMap())) }; var project by remember { mutableStateOf(JsonObject(emptyMap())) }
    var selected by remember { mutableStateOf(initialAssessmentId.orEmpty()) }; var detail by remember { mutableStateOf<JsonObject?>(null) }; var jobId by remember { mutableStateOf("") }
    var materials by remember { mutableStateOf(setOf<String>()) }; var sources by remember { mutableStateOf(setOf<String>()) }
    var confirm by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }
    fun runAction(block: suspend () -> Unit) { if (busy) return; busy = true; error = null; scope.launch { try { block(); refresh++ } catch (e: CancellationException) { throw e } catch (e: Exception) { error = (e.message ?: "操作失败") + "；请先刷新核对服务端状态，不会自动重放。" } finally { busy = false } } }
    suspend fun send(method: String, tail: String, body: JsonObject? = null): JsonObject { check(repository.accountId == owner && repository.epoch == epoch) { "账户已变化" }; return repository.requestDurably("assessment:$projectId:$tail", method, base + tail, body) }
    LaunchedEffect(refresh, section) { try { aiEnabled = repository.networkJson("GET", "/api/v1/capabilities").obj("features").flag("aiEnabled"); project = repository.networkJson("GET", base); goal = repository.networkJson("GET", "$base/goal"); standards = assessmentPages(repository, "$base/standards"); if (section != "standards") records = assessmentPages(repository, base + if (section == "reviews") "/reviews?limit=30" else "/assessments?limit=30"); error = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    LaunchedEffect(selected, refresh, section) { if (detail?.text(if (section == "reviews") "reviewId" else "assessmentId") != selected) detail = null; if (selected.isNotBlank()) try { detail = repository.networkJson("GET", "$base/${if (section == "reviews") "reviews" else "assessments"}/${Uri.encode(selected)}") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    AssessmentDraft(repository, "assessment-selection:$projectId", buildJsonObject { put("materials", JsonArray(materials.map(::JsonPrimitive))); put("sources", JsonArray(sources.map(::JsonPrimitive))) }, restore = { saved -> materials = (saved["materials"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet(); sources = (saved["sources"] as? JsonArray).orEmpty().map { it.jsonPrimitive.content }.toSet() }, failure = { error = it })
    val standard = standards.maxByOrNull { it.text("version").toIntOrNull() ?: 0 }
    val ownerRole = project.text("myRole") == "owner"; val permissions = project.obj("permissions"); val canInitiate = ownerRole || permissions.flag("scoreInitiate"); val canCorrect = ownerRole || permissions.flag("scoreCorrect")
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (!aiEnabled) Text("AI 当前不可用；已有标准、评分与人工修正仍可使用。")
        Text("标准与成果评估", style = MaterialTheme.typography.headlineSmall)
        AssessmentChoice("工作区", section, listOf("standards" to "项目标准与版本", "assessments" to "成果评分与复核", "reviews" to "历史预审")) { section = it; selected = "" }
        TextButton({ refresh++ }, enabled = !busy) { Text("刷新") }; if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()); error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (section == "standards") {
            AssessmentStandardEditor(repository, projectId, standard, standards, ownerRole, busy, onSave = { title, dimensions, original -> confirm = "保存并生效项目标准？本操作会创建新标准版本，历史评分依据保持不变。" to { val body = assessmentStandardBody(title, dimensions); send(if (original == null) "POST" else "PATCH", "/standards" + (original?.let { "/${Uri.encode(it.text("standardsVersionId"))}" } ?: ""), if (original == null) body else JsonObject(body + ("expectedRevision" to (original["revision"] ?: JsonPrimitive(1))))) } }, onGenerate = { if (aiEnabled) confirm = "调用 AI 生成标准草稿？生成会调用已配置的模型；结果需要核对后保存生效。" to { val response = send("POST", "/standards/generate", buildJsonObject {}); jobId = response.text("jobId") } }, generatedJobId = jobId)
            AssessmentLegacyStandards(repository, projectId, ownerRole, refresh) { refresh++ }
        } else {
            Text("主目标：${goal.text("title")} · r${goal.text("revision")}")
            Text("生效标准：${standard?.text("title") ?: "尚未建立"} · v${standard?.text("version").orEmpty()}")
            AssessmentReferencePicker(repository, projectId, materials, sources) { m, s -> materials = m; sources = s }
            if (section == "assessments") {
                Button({ confirm = "开始本轮成果检查？后端将冻结目标、标准和实际成果版本，并调用模型评分。" to { val result = send("POST", "/assessments", buildJsonObject { put("kind", "material_review"); put("materialVersionIds", JsonArray(materials.sorted().map(::JsonPrimitive))); put("sourceVersionIds", JsonArray(sources.sorted().map(::JsonPrimitive))); goal["revision"]?.let { put("goalRevision", it) } }); selected = result.text("assessmentId"); jobId = result.text("jobId") } }, enabled = aiEnabled && !busy && canInitiate && standard != null && goal.text("title").isNotBlank()) { Text("开始成果检查") }
            } else Button({ confirm = "发起预审？本次将固定所选成果版本并调用模型。" to { val result = send("POST", "/reviews", buildJsonObject { put("materialVersionIds", JsonArray(materials.sorted().map(::JsonPrimitive))) }); selected = result.text("reviewId"); jobId = result.text("jobId") } }, enabled = aiEnabled && !busy && canInitiate && materials.isNotEmpty()) { Text("开始预审") }
            Text("独立记录", style = MaterialTheme.typography.titleMedium)
            records.filter { section == "reviews" || it.text("kind") == "material_review" }.forEach { row -> val id = row.text(if (section == "reviews") "reviewId" else "assessmentId"); OutlinedButton({ selected = id }, Modifier.fillMaxWidth()) { Text("${row.text("createdAt")} · ${businessValue("status", JsonPrimitive(row.text("status")))} · 标准 v${row.text("standardsVersion")}") } }
            detail?.let { row ->
                Text("固定目标：${row.obj("goal").text("title")} · r${row.text("goalRevision")}")
                Text("本轮固定成果 ${(row["materialVersionIds"] as? JsonArray)?.size ?: 0} 个；当前评分 r${row.text("revision")}")
                AssessmentReport(row.obj("report"))
                if (row["aiReport"] is JsonObject) { Text("原始 AI 建议（人工修正前）", style = MaterialTheme.typography.titleMedium); AssessmentReport(row.obj("aiReport"), row.obj("report")) }
                if (section == "assessments" && !row.flag("historical")) {
                    val sameStandard = row.text("standardsVersionId") == standard?.text("standardsVersionId")
                    AssessmentManualEditor(repository, projectId, standard, row, goal, materials, canCorrect && !busy && sameStandard && row.text("status") in listOf("succeeded", "failed")) { body -> confirm = "发布人工修正？只修改已编辑维度，原始 AI 建议和版本修正记录保留。" to { send("PATCH", "/assessments/${Uri.encode(selected)}/scores", body) } }
                    if (!sameStandard) Text("标准已变化，本轮仅供查看。请按当前标准新建评分。")
                    if (row.text("status") == "succeeded") AssessmentFollowupWorkspace(repository, projectId, row, aiEnabled && canCorrect && !busy, onChanged = { refresh++ }, onConfirm = { message, action -> confirm = message to action })
                }
                row.text("jobId").takeIf { it.isNotBlank() }?.let { id -> NativeJobExecution(repository, id, onSettled = { refresh++ }) }
            }
        }
        if (jobId.isNotBlank()) NativeJobExecution(repository, jobId, onSettled = { refresh++ })
    }
    confirm?.let { (message, action) -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text("确认操作") }, text = { Text(message) }, confirmButton = { TextButton({ confirm = null; runAction(action) }) { Text("确认") } }, dismissButton = { TextButton({ confirm = null }) { Text("取消") } }) }
}

@Composable
internal fun AssessmentReport(report: JsonObject, before: JsonObject? = null) {
    if (report.isEmpty()) { Text("本轮结果尚未返回。"); return }
    Text("总分：${report.text("weightedTotal").ifBlank { report.obj("overall").text("score").ifBlank { "未评分" } }}", style = MaterialTheme.typography.titleLarge)
    NativeMarkdown(report.text("summary").ifBlank { report.obj("overall").text("summary") })
    report.rows("scores").forEach { score -> Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val prior = before?.rows("scores")?.find { it.text("key") == score.text("key") }
        Text("${score.text("label").ifBlank { "评分维度" }}：${prior?.text("score")?.let { "$it → " }.orEmpty()}${score.text("score").ifBlank { "未评分" }}", style = MaterialTheme.typography.titleMedium)
        NativeMarkdown(score.text("comment")); score.rows("evidence").forEach { Text("${if (it.text("type") == "answer") "真实回答 · 第 ${it.text("turnSequence")} 回合" else "固定成果原文"}：${it.text("quote")}", style = MaterialTheme.typography.bodySmall) }
        (score["suggestions"] as? JsonArray).orEmpty().forEach { Text("建议：${it.jsonPrimitive.content}") }
    } } }
    report.rows("requirementChecks").forEach { Text("要求检查 · ${it.text("status")}：${it.text("comment")}") }
    (report["limitations"] as? JsonArray).orEmpty().forEach { Text("限制与待核验：${it.jsonPrimitive.content}", color = MaterialTheme.colorScheme.error) }
}

@Composable
internal fun AssessmentManualEditor(repository: ClientRepository, projectId: String, standard: JsonObject?, assessment: JsonObject?, goal: JsonObject, materials: Set<String>, enabled: Boolean, onSave: (JsonObject) -> Unit) {
    var open by remember { mutableStateOf(false) }; val report = assessment?.obj("report") ?: JsonObject(emptyMap())
    var values by remember(assessment?.text("assessmentId"), assessment?.text("revision")) { mutableStateOf(mapOf<String, String>()) }; var comments by remember(assessment?.text("assessmentId"), assessment?.text("revision")) { mutableStateOf(mapOf<String, String>()) }
    var reason by remember(assessment?.text("assessmentId"), assessment?.text("revision")) { mutableStateOf("") }; var summary by remember(assessment?.text("revision")) { mutableStateOf(report.text("summary")) }; var error by remember { mutableStateOf<String?>(null) }
    AssessmentDraft(repository, "manual-score:$projectId:${assessment?.text("assessmentId") ?: "new"}:${assessment?.text("revision") ?: standard?.text("version")}", buildJsonObject { put("values", JsonObject(values.mapValues { JsonPrimitive(it.value) })); put("comments", JsonObject(comments.mapValues { JsonPrimitive(it.value) })); put("reason", reason); put("summary", summary) }, restore = { saved -> values = saved.obj("values").mapValues { it.value.jsonPrimitive.content }; comments = saved.obj("comments").mapValues { it.value.jsonPrimitive.content }; reason = saved.text("reason"); summary = saved.text("summary") }, failure = { error = it })
    TextButton({ open = !open }) { Text("人工修正本轮评分") }
    if (open) {
        standard?.obj("rubric")?.rows("weights")?.forEach { d -> val id = d.text("key"); val existing = report.rows("scores").find { it.text("key") == id }
            OutlinedTextField(values[id] ?: existing?.text("score").orEmpty(), { values = values + (id to it) }, Modifier.fillMaxWidth(), label = { Text("${d.text("label")}（0–100，空为未评分）") }, enabled = enabled)
            OutlinedTextField(comments[id] ?: existing?.text("comment").orEmpty(), { comments = comments + (id to it) }, Modifier.fillMaxWidth(), label = { Text("${d.text("label")} · 理由") }, enabled = enabled)
        }
        OutlinedTextField(summary, { summary = it }, Modifier.fillMaxWidth(), label = { Text("总体反馈") }); OutlinedTextField(reason, { if (it.length <= 4000) reason = it }, Modifier.fillMaxWidth(), label = { Text("人工评分或修正理由（必填）") })
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button({ try {
            require(assessment != null) { "请选择已有评分记录" }
            onSave(assessmentCorrectionBody(assessment, standard?.obj("rubric")?.rows("weights").orEmpty(), values, comments, reason, summary))
        } catch (e: Exception) { error = e.message } }, enabled = enabled && standard != null && reason.isNotBlank()) { Text("保存人工评分") }
    }
}

@Composable
private fun AssessmentFollowupWorkspace(repository: ClientRepository, projectId: String, assessment: JsonObject, enabled: Boolean, onChanged: () -> Unit, onConfirm: (String, suspend () -> Unit) -> Unit) {
    val path = assessmentBase(projectId) + "/assessments/${Uri.encode(assessment.text("assessmentId"))}/followups"; val owner = repository.accountId; val epoch = repository.epoch
    var turns by remember(path) { mutableStateOf<List<JsonObject>>(emptyList()) }; var message by remember(path) { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }; var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(path, assessment.text("revision"), reload) { try { turns = assessmentPages(repository, "$path?limit=20") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    AssessmentDraft(repository, "assessment-followup:$projectId:${assessment.text("assessmentId")}", buildJsonObject { put("message", message) }, restore = { message = it.text("message") }, failure = { error = it })
    Text("固定材料追问与版本对比", style = MaterialTheme.typography.titleMedium); Text("新对话中的事实不能作为评分证据；复核只使用本轮固定材料与标准，已有人工分数会保留。")
    turns.forEach { turn -> Text("${turn.text("message")} · ${turn.text("status")} · r${turn.text("baseRevision")} → r${turn.text("publishedRevision")}"); val result = turn["publishedReport"] as? JsonObject ?: turn["proposedReport"] as? JsonObject; result?.let { AssessmentReport(it, turn.obj("baseReport")) }; if (turn["publishedReport"] is JsonObject && turn["proposedReport"] is JsonObject) { Text("AI 建议（人工分数保留前）"); AssessmentReport(turn.obj("proposedReport"), turn.obj("publishedReport")) }; turn.text("error").takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.error) }; turn.text("jobId").takeIf { it.isNotBlank() }?.let { NativeJobExecution(repository, it, onSettled = { reload++; onChanged() }) } }
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }; TextButton({ reload++ }) { Text("刷新追问记录") }
    OutlinedTextField(message, { if (it.length <= 8000) message = it }, Modifier.fillMaxWidth(), label = { Text("指出固定材料中的遗漏或询问评分依据") }, minLines = 3)
    Button({ val submitted = message.trim(); onConfirm("发送追问并复核当前评分 r${assessment.text("revision")}？这会调用模型；只使用固定材料，保留人工分数。") { check(repository.accountId == owner && repository.epoch == epoch); repository.requestDurably("followup:$projectId:${assessment.text("assessmentId")}", "POST", path, buildJsonObject { put("message", submitted); put("expectedRevision", assessment["revision"] ?: JsonPrimitive(1)) }); message = ""; reload++; onChanged() } }, enabled = enabled && message.isNotBlank() && turns.none { it.text("status") in listOf("queued", "running", "waiting_input") }) { Text("发送追问并复核") }
}

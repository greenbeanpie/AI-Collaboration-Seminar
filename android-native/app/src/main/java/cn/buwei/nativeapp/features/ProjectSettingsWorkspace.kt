package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun projectSettingsPatch(base: JsonObject, changes: JsonObject): JsonObject {
    require(changes.keys.all { it in setOf("name", "description", "deadlineDate", "status") })
    changes["name"]?.let { require(it.jsonPrimitive.content.trim().length in 1..100) { "项目名称需要 1–100 字" } }
    changes["description"]?.let { require(it.jsonPrimitive.content.length <= 2000) }
    val body = changes.toMutableMap(); body["expectedRevision"] = base["revision"] ?: error("缺少项目版本")
    if ("deadlineDate" in changes) {
        val raw = changes.text("deadlineDate"); if (raw.isNotBlank()) java.time.LocalDate.parse(raw)
        body["deadlineDate"] = raw.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull
        body["deadlinePrecision"] = JsonPrimitive(if (raw.isBlank()) "unknown" else "date")
    }
    return JsonObject(body)
}

@Composable
fun ProjectSettingsWorkspace(repository: ClientRepository, projectId: String) {
    val account by repository.account.collectAsState(); key(projectId, account?.text("id")) { ProjectSettingsContent(repository, projectId) }
}

@Composable
private fun ProjectSettingsContent(repository: ClientRepository, projectId: String) {
    val base = assessmentBase(projectId); val scope = rememberCoroutineScope(); val owner = repository.accountId; val epoch = repository.epoch
    var server by remember { mutableStateOf(JsonObject(emptyMap())) }; var goal by remember { mutableStateOf(JsonObject(emptyMap())) }; var collaboration by remember { mutableStateOf(JsonObject(emptyMap())) }
    var projectBase by remember { mutableStateOf<JsonObject?>(null) }; var goalBase by remember { mutableStateOf<JsonObject?>(null) }; var collaborationBase by remember { mutableStateOf<JsonObject?>(null) }
    var projectChanges by remember { mutableStateOf(JsonObject(emptyMap())) }; var goalChanges by remember { mutableStateOf(JsonObject(emptyMap())) }; var collaborationChanges by remember { mutableStateOf(JsonObject(emptyMap())) }
    var refresh by remember { mutableIntStateOf(0) }; var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var message by remember { mutableStateOf("") }; var confirm by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }; var left by remember { mutableStateOf(false) }
    LaunchedEffect(refresh) { if (!left) try { server = repository.networkJson("GET", base); goal = repository.networkJson("GET", "$base/goal"); collaboration = repository.networkJson("GET", "$base/collaboration/settings") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    AssessmentDraft(repository, "project-settings:$projectId", buildJsonObject { put("projectBase", projectBase ?: JsonNull); put("goalBase", goalBase ?: JsonNull); put("collaborationBase", collaborationBase ?: JsonNull); put("project", projectChanges); put("goal", goalChanges); put("collaboration", collaborationChanges) }, restore = { saved -> projectBase = saved["projectBase"] as? JsonObject; goalBase = saved["goalBase"] as? JsonObject; collaborationBase = saved["collaborationBase"] as? JsonObject; projectChanges = saved.obj("project"); goalChanges = saved.obj("goal"); collaborationChanges = saved.obj("collaboration") }, failure = { error = it })
    fun changeProject(key: String, value: JsonElement) { if (projectBase == null) projectBase = server; projectChanges = JsonObject(projectChanges + (key to value)) }
    fun changeGoal(key: String, value: JsonElement) { if (goalBase == null) goalBase = goal; goalChanges = JsonObject(goalChanges + (key to value)) }
    fun changeCollaboration(key: String, value: JsonElement) { if (collaborationBase == null) collaborationBase = collaboration; collaborationChanges = JsonObject(collaborationChanges + (key to value)) }
    suspend fun send(method: String, tail: String, body: JsonObject? = null): JsonObject { check(repository.accountId == owner && repository.epoch == epoch); return repository.requestDurably("project-settings:$projectId:$tail", method, base + tail, body) }
    val canEdit = server.text("myRole") == "owner"
    val projectConflict = projectBase != null && projectBase?.get("revision") != server["revision"]
    val goalConflict = goalBase != null && goalBase?.get("revision") != goal["revision"]
    val collaborationConflict = collaborationBase != null && collaborationBase?.get("revision") != collaboration["revision"]
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("项目设置", style = MaterialTheme.typography.headlineSmall)
        if (left) Text("已退出项目，可从项目列表选择其他项目。")
        else {
        Text(if (canEdit) "项目负责人 · 可修改" else "成员只读"); TextButton({ refresh++; error = null }, enabled = !busy) { Text("刷新服务端版本") }; if (busy) LinearProgressIndicator(Modifier.fillMaxWidth()); error?.let { Text(it, color = MaterialTheme.colorScheme.error) }; if (message.isNotBlank()) Text(message)
        Text("项目基本信息 · r${server.text("revision")}", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(projectChanges.text("name").ifBlank { server.text("name") }, { changeProject("name", JsonPrimitive(it.take(100))) }, Modifier.fillMaxWidth(), label = { Text("项目名称") }, enabled = canEdit && !busy)
        OutlinedTextField((projectChanges["description"] ?: server["description"])?.jsonPrimitive?.contentOrNull.orEmpty(), { changeProject("description", JsonPrimitive(it.take(2000))) }, Modifier.fillMaxWidth(), label = { Text("项目说明") }, minLines = 3, enabled = canEdit && !busy)
        OutlinedTextField(if ("deadlineDate" in projectChanges) projectChanges.text("deadlineDate") else server.text("deadlineDate").take(10), { changeProject("deadlineDate", JsonPrimitive(it)) }, Modifier.fillMaxWidth(), label = { Text("截止日期 YYYY-MM-DD（可空）") }, enabled = canEdit && !busy)
        Text("原日期精度：${server.text("deadlinePrecision")}；未编辑日期时保留原精度和时刻。", style = MaterialTheme.typography.bodySmall)
        if (projectConflict) { Text("服务端已更新：${server.text("name")} · ${server.text("description")}；本机编辑保留。", color = MaterialTheme.colorScheme.error); TextButton({ projectBase = server }) { Text("已核对当前版本，保留本机编辑继续") } }
        Button({ try { val body = projectSettingsPatch(projectBase ?: server, projectChanges); confirm = "保存项目基本信息？" to { send("PATCH", "", body); projectBase = null; projectChanges = JsonObject(emptyMap()); message = "项目设置已保存" } } catch (e: Exception) { error = e.message } }, enabled = canEdit && !busy && !projectConflict && projectChanges.isNotEmpty()) { Text("保存项目设置") }
        Text("项目主目标 · r${goal.text("revision")}", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField((goalChanges["title"] ?: goal["title"])?.jsonPrimitive?.contentOrNull.orEmpty(), { changeGoal("title", JsonPrimitive(it.take(200))) }, Modifier.fillMaxWidth(), label = { Text("主目标标题") }, enabled = canEdit && !busy)
        OutlinedTextField((goalChanges["detail"] ?: goal["detail"])?.jsonPrimitive?.contentOrNull.orEmpty(), { changeGoal("detail", JsonPrimitive(it)) }, Modifier.fillMaxWidth(), label = { Text("主目标说明") }, minLines = 3, enabled = canEdit && !busy)
        if (goalConflict) Text("主目标版本已变化，请重新读取后核对编辑。", color = MaterialTheme.colorScheme.error)
        Button({ val body = buildJsonObject { put("expectedRevision", (goalBase ?: goal)["revision"]!!); put("title", (goalChanges["title"] ?: goal["title"])!!); put("detail", (goalChanges["detail"] ?: goal["detail"]) ?: JsonPrimitive("")) }; confirm = "保存项目主目标？历史评分继续保留各自冻结目标。" to { send("PATCH", "/goal", body); goalBase = null; goalChanges = JsonObject(emptyMap()); message = "项目主目标已保存" } }, enabled = canEdit && !busy && !goalConflict && goalChanges.isNotEmpty()) { Text("保存主目标") }
        if (goalConflict) TextButton({ goalBase = null; goalChanges = JsonObject(emptyMap()) }) { Text("丢弃本机目标编辑，载入最新版本") }
        Text("AI 智能协作 · r${collaboration.text("revision")}", style = MaterialTheme.typography.titleLarge)
        Row { Checkbox((collaborationChanges["aiCollaborationEnabled"] ?: collaboration["aiCollaborationEnabled"])?.jsonPrimitive?.booleanOrNull == true, { changeCollaboration("aiCollaborationEnabled", JsonPrimitive(it)) }, enabled = canEdit && !busy); Text("启用本项目 AI 智能协作", Modifier.padding(top = 12.dp)) }
        listOf("assignmentMode" to "分工方式", "evaluationMode" to "成果验收", "planningMode" to "任务规划审核", "progressionMode" to "进度推进审核").forEach { (field, title) -> if (canEdit) AssessmentChoice(title, (collaborationChanges[field] ?: collaboration[field])?.jsonPrimitive?.contentOrNull ?: "manual", listOf("manual" to "负责人事先确认", "automatic" to "允许 AI 自动应用")) { changeCollaboration(field, JsonPrimitive(it)) } else Text("$title：${collaboration.text(field)}") }
        if (collaborationConflict) { Text("协作规则版本已变化，本机草稿保留，请重新载入再修改。", color = MaterialTheme.colorScheme.error); TextButton({ collaborationBase = null; collaborationChanges = JsonObject(emptyMap()) }) { Text("重新载入协作规则") } }
        Button({ val body = JsonObject(collaborationChanges + ("expectedRevision" to (collaborationBase ?: collaboration)["revision"]!!)); confirm = "保存 AI 协作规则？自动模式可能使后续 AI 规划、分工、验收或推进自动生效。" to { send("PATCH", "/collaboration/settings", body); collaborationBase = null; collaborationChanges = JsonObject(emptyMap()); message = "协作规则已保存" } }, enabled = canEdit && !busy && !collaborationConflict && collaborationChanges.isNotEmpty()) { Text("保存协作规则") }
        Text("项目状态与成员关系", style = MaterialTheme.typography.titleLarge)
        if (canEdit) Button({ val next = if (server.text("status") == "archived") "active" else "archived"; confirm = if (next == "archived") "归档此项目？项目数据和历史记录保留。" to { send("PATCH", "", buildJsonObject { put("expectedRevision", server["revision"]!!); put("status", next) }); message = "项目已归档" } else "恢复此项目为进行中？" to { send("PATCH", "", buildJsonObject { put("expectedRevision", server["revision"]!!); put("status", next) }); message = "项目已恢复" } }, enabled = !busy) { Text(if (server.text("status") == "archived") "恢复项目" else "归档项目") }
        else TextButton({ confirm = "退出当前项目？退出后将失去项目访问权限，原有项目数据保留。" to { send("DELETE", "/members/me"); left = true; message = "已退出项目" } }, enabled = !busy && server.isNotEmpty()) { Text("退出项目") }
        }
    }
    confirm?.let { (prompt, action) -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text("确认项目操作") }, text = { Text(prompt) }, confirmButton = { TextButton({ confirm = null; if (!busy) { busy = true; scope.launch { try { action(); refresh++ } catch (e: CancellationException) { throw e } catch (e: Exception) { error = (e.message ?: "保存失败") + "；草稿保留，请刷新核对。" } finally { busy = false } } } }) { Text("确认") } }, dismissButton = { TextButton({ confirm = null }) { Text("取消") } }) }
}

package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.*
import java.time.LocalDate

internal fun dashboardTasks(graph: JsonObject): List<JsonObject> = graph.rows().groupBy { it.text("taskId") }.values.map { versions -> versions.maxBy { it.text("revision").toIntOrNull() ?: 0 } }
internal fun dashboardStatus(project: JsonObject, graph: JsonObject?): String = when {
    project.text("status") == "archived" -> "archived"
    graph == null || graph["items"] !is JsonArray -> "unknown"
    dashboardTasks(graph).let { tasks -> tasks.isNotEmpty() && tasks.all { it.text("status") == "done" } } -> "done"
    dashboardTasks(graph).any { it.text("status") in setOf("todo", "blocked") || it.text("lifecycleState") == "submitted" } -> "pending"
    else -> "active"
}
internal fun dashboardActionable(graph: JsonObject): List<JsonObject> {
    val tasks = dashboardTasks(graph); val members = (graph["memberIds"] as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() ?: return emptyList(); val byId = tasks.associateBy { it.text("taskId") }
    return tasks.filter { task ->
        task.text("assigneeId") in members && task.text("status") in setOf("todo", "doing") && task.text("lifecycleState").let { it.isBlank() || it in setOf("open", "in_progress", "improve", "rework") } &&
        (task["unfinishedDependencyIds"] as? JsonArray)?.isEmpty() == true &&
        ((task["dependsOnTaskIds"] as? JsonArray)?.all { byId[it.jsonPrimitive.content]?.text("status") == "done" } ?: true)
    }
}
internal fun dashboardDays(task: JsonObject, today: LocalDate = LocalDate.now()): Long? {
    if(task.text("duePrecision") == "unknown") return null
    return runCatching { java.time.temporal.ChronoUnit.DAYS.between(today, LocalDate.parse(task.text("dueDate"))) }.getOrNull()
}
internal fun dashboardStatusLabel(status: String) = mapOf("archived" to "已归档", "pending" to "待响应", "done" to "已完成", "active" to "进行中", "unknown" to "进度待确认")[status] ?: status
internal fun dashboardDeadline(row: JsonObject): String = if(row.text("deadlinePrecision") == "unknown" || row.text("deadlineDate").isBlank()) "截止日期待确认" else "截止 ${row.text("deadlineDate")}"
internal fun dashboardProjectsQuery(search: String, filter: String, cursor: String? = null): String {
    val status = if(filter == "archived") "archived" else "active"
    return "/api/v1/projects?status=$status&limit=20" + (search.trim().takeIf { it.isNotBlank() }?.let { "&q=${Uri.encode(it)}" } ?: "") + (cursor?.let { "&cursor=${Uri.encode(it)}" } ?: "")
}

@Composable
fun ProjectDashboardWorkspace(repository: ClientRepository, onProject: (String) -> Unit, onNavigate: (String) -> Unit) {
    val account by repository.account.collectAsState(); key(account?.text("id")) { ProjectDashboardContent(repository, onProject, onNavigate) }
}

@Composable
private fun ProjectDashboardContent(repository: ClientRepository, onProject: (String) -> Unit, onNavigate: (String) -> Unit) {
    var search by remember { mutableStateOf("") }; var appliedSearch by remember { mutableStateOf("") }; var filter by remember { mutableStateOf("all") }; var refresh by remember { mutableIntStateOf(0) }
    var projects by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var graphs by remember { mutableStateOf<Map<String, JsonObject>>(emptyMap()) }; var graphErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var cursor by remember { mutableStateOf<String?>(null) }; var seen by remember { mutableStateOf(setOf<String>()) }; var loading by remember { mutableStateOf(true) }; var error by remember { mutableStateOf<String?>(null) }; var usage by remember { mutableStateOf<JsonObject?>(null) }; val scope = rememberCoroutineScope()
    suspend fun load(older: Boolean) {
        val identity = Triple(appliedSearch, filter, refresh); loading = true; error = null
        try { val requested = if(older) cursor else null; val page = repository.get(dashboardProjectsQuery(appliedSearch, filter, requested)); if(identity != Triple(appliedSearch, filter, refresh)) return; check(page["items"] is JsonArray) { "项目分页响应缺少记录列表，请刷新重试。" }; val next = page.text("nextCursor").takeIf { it.isNotBlank() }; check(next == null || (next != requested && next !in seen)) { "项目分页游标重复，请刷新重试" }; projects = ((if(older) projects else emptyList()) + page.rows()).distinctBy { it.text("id") }; cursor = next; seen = if(older) seen + listOfNotNull(next) else setOfNotNull(next) } catch(e: CancellationException) { throw e } catch(e: Exception) { if(identity == Triple(appliedSearch, filter, refresh)) error = e.message ?: "项目列表暂不可用" } finally { if(identity == Triple(appliedSearch, filter, refresh)) loading = false }
    }
    LaunchedEffect(appliedSearch, filter, refresh) { projects = emptyList(); graphs = emptyMap(); graphErrors = emptyMap(); seen = emptySet(); cursor = null; load(false) }
    LaunchedEffect(refresh) { try { usage = repository.networkJson("GET", "/api/v1/resource-usage") } catch(e: CancellationException) { throw e } catch(_: Exception) { usage = null } }
    LaunchedEffect(projects.map { it.text("id") }, refresh) { val permits = Semaphore(3); coroutineScope { projects.filter { it.text("id") !in graphs && it.text("id") !in graphErrors }.forEach { project -> launch { permits.withPermit { val id = project.text("id"); try { graphs = graphs + (id to repository.get(assessmentBase(id) + "/tasks/graph").also { check(it["items"] is JsonArray && it["memberIds"] is JsonArray) { "完整任务或成员统计尚未读取" } }) } catch(e: CancellationException) { throw e } catch(e: Exception) { graphErrors = graphErrors + (id to (e.message ?: "任务进度暂不可用")) } } } } } }
    val visible = projects.filter { project -> val status = dashboardStatus(project, graphs[project.text("id")]); when(filter) { "done" -> status == "done"; "active" -> status in setOf("active", "pending"); else -> true } }
    val complete = !loading && error == null && cursor == null && projects.all { it.text("id") in graphs }
    val allTasks = projects.filter { it.text("status") != "archived" }.flatMap { graphs[it.text("id")]?.let(::dashboardTasks).orEmpty() }
    val actionable = projects.filter { it.text("status") != "archived" }.flatMap { project -> graphs[project.text("id")]?.let(::dashboardActionable).orEmpty().map { project to it } }.sortedWith(compareBy<Pair<JsonObject, JsonObject>> { dashboardDays(it.second) ?: Long.MAX_VALUE }.thenBy { it.second.text("taskId") })
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
        item { Text("我的项目", style = MaterialTheme.typography.headlineSmall); Text("让每个项目有序向前，让下一步清晰可见。", style = MaterialTheme.typography.bodyMedium) }
        item { Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { Button({ onNavigate("create-project") }) { Text("新建项目") }; OutlinedButton({ onNavigate("join") }) { Text("加入团队") } } }
        item { OutlinedTextField(search, { if(it.length <= 200) search = it }, Modifier.fillMaxWidth(), label = { Text("搜索项目名称或说明") }, singleLine = true); Row { TextButton({ appliedSearch = search.trim(); refresh++ }, enabled = !loading) { Text("搜索") }; TextButton({ refresh++ }, enabled = !loading) { Text("刷新项目与进度") } } }
        item { AssessmentChoice("项目筛选", filter, listOf("all" to "全部当前项目", "active" to "进行中（含待响应）", "done" to "全部任务已完成", "archived" to "已归档项目")) { filter = it } }
        if(loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        item { Text("已加载 ${projects.size} 个匹配项目${if(cursor != null) "，还有后续项目待加载" else ""}。${if(appliedSearch.isNotBlank()) "统计仅包含当前搜索结果。" else ""}", style = MaterialTheme.typography.bodySmall) }
        if(filter != "archived") item { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text("项目与任务进度", style = MaterialTheme.typography.titleMedium); if(complete) { Text("进行中 ${projects.count { dashboardStatus(it, graphs[it.text("id")]) != "done" }} 个项目 · 任务完成 ${allTasks.count { it.text("status") == "done" }} / ${allTasks.size}"); Text("待响应 ${actionable.size} 项 · 今日截止 ${actionable.count { dashboardDays(it.second) == 0L }} · 近3日截止 ${actionable.count { dashboardDays(it.second)?.let { days -> days in 0..3 } == true }}"); Text("已逾期 ${actionable.count { dashboardDays(it.second)?.let { days -> days < 0 } == true }} · 截止待确认 ${actionable.count { dashboardDays(it.second) == null }}", style = MaterialTheme.typography.bodySmall) } else Text(if(graphErrors.isNotEmpty()) "任务统计暂不可用，请刷新重试。" else "加载全部项目及任务图后显示完整统计。") } } }
        usage?.let { row -> item { val ai = row.obj("ai").obj("user"); val storage = row.obj("storage").obj("user"); Text("今日 AI ${ai.text("used")} / ${ai.text("limit")} 次 · 存储 ${storage.text("used")} / ${storage.text("limit")} 字节", style = MaterialTheme.typography.bodySmall) } }
        items(visible, key = { it.text("id") }) { project -> val graph = graphs[project.text("id")]; val status = dashboardStatus(project, graph); Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${dashboardStatusLabel(status)} · ${if(project.text("myRole") == "owner") "负责人" else "成员"}", style = MaterialTheme.typography.labelLarge)
            Text(project.text("name"), style = MaterialTheme.typography.titleLarge); Text(project.text("description").ifBlank { "尚未添加项目说明。" }); Text(dashboardDeadline(project), style = MaterialTheme.typography.bodySmall)
            if(graph != null) { val tasks = dashboardTasks(graph); val done = tasks.count { it.text("status") == "done" }; Text("$done / ${tasks.size} 项任务完成"); LinearProgressIndicator(progress = { if(tasks.isEmpty()) 0f else done.toFloat() / tasks.size }, modifier = Modifier.fillMaxWidth()) } else Text(graphErrors[project.text("id")] ?: "读取任务进度…")
            Button({ onProject(project.text("id")) }) { Text("进入项目") }
        } } }
        if(!loading && error == null && visible.isEmpty()) item { Text(if(projects.isEmpty()) "还没有匹配项目，可以创建项目或加入团队。" else "已加载项目中暂无此类项目。") }
        if(cursor != null) item { OutlinedButton({ scope.launch { load(true) } }, Modifier.fillMaxWidth(), enabled = !loading) { Text("加载更多项目") } }
        if(filter != "archived") {
            item { Text("待响应事项", style = MaterialTheme.typography.titleLarge); Text("已分配给有效项目成员、前置任务完成的未完成任务。", style = MaterialTheme.typography.bodySmall) }
            items(actionable.take(30), key = { it.first.text("id") + ":" + it.second.text("taskId") }) { (project, task) -> OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) { Text(project.text("name"), style = MaterialTheme.typography.labelLarge); Text(task.text("title"), style = MaterialTheme.typography.titleMedium); val days = dashboardDays(task); Text(when { days == null -> "截止待确认"; days < 0 -> "已逾期 ${-days} 日"; days == 0L -> "今日截止"; else -> "截止还有 $days 日" }); TextButton({ onProject(project.text("id")); onNavigate("tasks") }) { Text("打开项目任务列表") } } } }
            if(actionable.size > 30) item { Text("已展示最近30项，进入项目任务列表查看其余事项。") }
            if(complete && actionable.isEmpty()) item { Text("暂时没有待响应事项。") }
        }
    }
}

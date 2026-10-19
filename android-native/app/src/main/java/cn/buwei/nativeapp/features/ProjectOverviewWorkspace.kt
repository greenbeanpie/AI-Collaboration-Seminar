package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun overviewPendingTasks(tasks: List<JsonObject>, userId: String?): List<JsonObject> = tasks.filter { it.text("status") != "done" }.sortedWith(compareByDescending<JsonObject> { userId != null && it.text("assigneeId") == userId }.thenByDescending { it.text("createdAt") }.thenBy { it.text("taskId") }).take(2)

@Composable
fun ProjectOverviewWorkspace(repository: ClientRepository, projectId: String, onNavigate: (String) -> Unit) {
    val account by repository.account.collectAsState(); key(projectId, account?.text("id")) { ProjectOverviewContent(repository, projectId, onNavigate) }
}

@Composable
private fun ProjectOverviewContent(repository: ClientRepository, projectId: String, onNavigate: (String) -> Unit) {
    val base = assessmentBase(projectId); var refresh by remember { mutableIntStateOf(0) }; var loading by remember { mutableStateOf(true) }
    var reads by remember { mutableStateOf<Map<String, JsonObject>>(emptyMap()) }; var errors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    LaunchedEffect(refresh) {
        loading = true; errors = emptyMap()
        suspend fun read(key: String, path: String) { try { val value = repository.get(path); reads = reads + (key to value) } catch(e: CancellationException) { throw e } catch(e: Exception) { reads = reads - key; errors = errors + (key to (e.message ?: "数据暂不可用")) } }
        try { coroutineScope { listOf("project" to base, "goal" to "$base/goal", "graph" to "$base/tasks/graph", "sources" to "$base/sources?limit=3", "requirements" to "$base/requirement-sets", "events" to "$base/events?limit=3", "resources" to "$base/resource-library?limit=3").forEach { (key, path) -> launch { read(key, path) } } }
            val project = reads["project"]; if(project?.text("myRole") == "owner" || project?.obj("permissions")?.flag("teamManage") == true) read("invitations", "$base/invitation-requests") else reads = reads - "invitations"
        } finally { loading = false }
    }
    val project = reads["project"]; val goal = reads["goal"]; val graph = reads["graph"]; val tasks = graph?.let(::dashboardTasks).orEmpty(); val owner = project?.text("myRole") == "owner"
    val pendingInvitations = reads["invitations"]?.rows()?.count { it.text("status") == "pending" }
    val draftSets = reads["requirements"]?.rows()?.count { it.text("status") != "confirmed" }
    val deadlineMissing = project != null && (project.text("deadlineDate").isBlank() || project.text("deadlinePrecision") == "unknown")
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
        item { Text(project?.text("name") ?: "项目概览", style = MaterialTheme.typography.headlineSmall); Text(if(project == null) "正在读取项目身份" else "${if(owner) "负责人" else "项目成员"} · ${if(project.text("status") == "archived") "已归档" else "进行中"}"); TextButton({ refresh++ }, enabled = !loading) { Text("刷新项目进度") } }
        if(loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        errors.forEach { (key, error) -> item { Text("${mapOf("project" to "项目", "goal" to "主目标", "graph" to "任务", "sources" to "来源", "requirements" to "标准要求", "events" to "活动", "resources" to "资料", "invitations" to "邀请申请")[key]}：$error", color = MaterialTheme.colorScheme.error) } }
        item { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text("项目主目标", style = MaterialTheme.typography.titleLarge); if(goal != null) { Text(goal.text("title").ifBlank { "尚未填写主目标" }, style = MaterialTheme.typography.titleMedium); Text(goal.text("detail")); Text("主目标 r${goal.text("revision")}", style = MaterialTheme.typography.bodySmall) } else Text("主目标暂不可用"); TextButton({ onNavigate("tasks") }) { Text("查看目标与依赖任务") } } } }
        item { Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { Button({ onNavigate("tasks") }) { Text("查看任务") }; OutlinedButton({ onNavigate("ai-chat") }) { Text("询问项目 AI") } } }
        item { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Text("任务完成情况", style = MaterialTheme.typography.titleLarge); if(graph != null && graph["items"] is JsonArray) { val done = tasks.count { it.text("status") == "done" }; Text("已完成 $done / ${tasks.size} 项"); LinearProgressIndicator(progress = { if(tasks.isEmpty()) 0f else done.toFloat() / tasks.size }, modifier = Modifier.fillMaxWidth()); Text("待开始 ${tasks.count { it.text("status") == "todo" }} · 进行中 ${tasks.count { it.text("status") == "doing" }} · 受阻 ${tasks.count { it.text("status") == "blocked" }}"); (graph["memberIds"] as? JsonArray)?.let { Text("项目成员 ${it.distinct().size} 人", style = MaterialTheme.typography.bodySmall) } } else Text("任务统计暂不可用") } } }
        item { Text("待处理事项", style = MaterialTheme.typography.titleLarge) }
        if(pendingInvitations != null && pendingInvitations > 0) item { OverviewAction("有 $pendingInvitations 条邀请申请等待批准", "在团队管理中核对后，批准才会发送邀请。", "核对团队申请") { onNavigate("team") } }
        if(graph != null) overviewPendingTasks(tasks, repository.accountId).forEach { task -> item { OverviewAction(task.text("title"), (if(task.text("assigneeId") == repository.accountId) "由你负责 · " else "") + businessValue("status", JsonPrimitive(task.text("status"))) + task.text("dueDate").takeIf { it.isNotBlank() }?.let { " · 截止 $it" }.orEmpty(), "打开项目任务列表") { onNavigate("tasks") } } }
        if(deadlineMissing) item { OverviewAction("截止日期尚未确认", "请保留官方通知的日期精度。", "查看项目设置") { onNavigate("project-settings") } }
        if(reads["sources"]?.rows()?.isEmpty() == true) item { OverviewAction("导入通知或项目资料", "粘贴原文、公开网址或上传文件，再提取要求。", "新增资料") { onNavigate("data") } }
        if(draftSets != null && draftSets > 0) item { OverviewAction("有 $draftSets 份要求等待纳入统一标准", "复核要求与评分维度后，固定标准版本。", "复核项目标准") { onNavigate("assessment") } }
        if(errors.isEmpty() && graph != null && graph["items"] is JsonArray && reads["sources"] != null && reads["requirements"] != null && tasks.none { it.text("status") != "done" } && !deadlineMissing && reads["sources"]!!.rows().isNotEmpty() && draftSets == 0 && (pendingInvitations ?: 0) == 0) item { Text("暂无待处理事项。") }
        item { Text("最近资料", style = MaterialTheme.typography.titleLarge) }
        reads["resources"]?.rows()?.forEach { resource -> item { OverviewAction(resource.text("title"), "${mapOf("background" to "项目背景", "reference" to "参考资料", "output" to "成果")[resource.text("purpose")] ?: "项目资料"} · ${resource.text("updatedAt")}", "查看项目资料") { onNavigate("data") } } }
        if(reads["resources"]?.rows()?.isEmpty() == true) item { Text("尚无资料记录。") }
        item { Text("最近项目活动", style = MaterialTheme.typography.titleLarge) }
        reads["events"]?.rows()?.forEach { event -> item { ProjectEventCard(event) } }
        if(reads["events"]?.rows()?.isEmpty() == true) item { Text("暂无项目活动。") }
        item { Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { OutlinedButton({ onNavigate("ledger") }) { Text("查看全部活动") }; TextButton({ onNavigate("team") }) { Text("查看团队") } } }
    }
}

@Composable
private fun OverviewAction(title: String, detail: String, action: String, onClick: () -> Unit) { OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { Text(title, style = MaterialTheme.typography.titleMedium); Text(detail); TextButton(onClick) { Text(action) } } } }

package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import cn.buwei.nativeapp.NativeAiReferenceBadge
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

internal data class ProjectEventPresentation(val title: String, val detail: String, val actor: String)
internal val projectEventTypes = linkedMapOf("decision.recorded" to "记录团队决策", "material.saved" to "保存材料版本", "material.adopted" to "采纳 AI 材料", "task.status_changed" to "更新任务状态", "task.assignment_applied" to "更新任务分工", "assignment.suggestions_created" to "生成分工建议", "ai.run_succeeded" to "完成 AI 辅助任务", "review.succeeded" to "完成材料预审", "rehearsal.finished" to "完成答辩演练")
internal fun presentProjectEvent(event: JsonObject): ProjectEventPresentation {
    val payload = event.obj("payload"); val revision = payload.text("revision").takeIf { it.isNotBlank() }?.let { "，版本 r$it" }.orEmpty()
    val actor = when(event.text("actorType")) { "ai" -> "AI 辅助"; "system" -> "系统记录"; else -> "成员操作" }
    val detail = when(event.text("type")) {
        "decision.recorded" -> payload.text("title").ifBlank { "已保存一条团队决策。" }
        "material.saved" -> "成员已保存材料$revision。"
        "material.adopted" -> "成员确认后已保存正式材料$revision。"
        "task.status_changed" -> { val names = mapOf("todo" to "待开始", "doing" to "进行中", "blocked" to "受阻", "done" to "已完成"); val from = names[payload.text("from")]; val to = names[payload.text("to")]; if(from != null && to != null) "$from → $to" else "任务状态已更新，请在任务页查看。" }
        "task.assignment_applied" -> "成员已确认任务负责人，请在任务页查看。"
        "assignment.suggestions_created" -> "AI 建议已生成，等待成员逐项确认。"
        "ai.run_succeeded" -> "结果已生成，仍需人工复核后采纳。"
        "review.succeeded" -> "预审结果已生成，请在评估页查看。"
        "rehearsal.finished" -> "演练记录已保存，请在答辩演练页查看。"
        else -> "已记录一项项目活动，完整记录可随项目导出。"
    }
    return ProjectEventPresentation(projectEventTypes[event.text("type")] ?: "项目活动", detail, actor)
}
internal fun projectLedgerQuery(projectId: String, type: String, limit: Int, cursor: String?): String {
    require(limit in setOf(10,20,50))
    return assessmentBase(projectId) + "/events?limit=$limit" + (type.takeIf { it.isNotBlank() }?.let { "&type=${Uri.encode(it)}" } ?: "") + (cursor?.let { "&cursor=${Uri.encode(it)}" } ?: "")
}

@Composable
internal fun ProjectEventCard(event: JsonObject) {
    val presented = presentProjectEvent(event); var expanded by remember(event.text("eventId")) { mutableStateOf(false) }
    OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(presented.title, style = MaterialTheme.typography.titleMedium); Text(presented.actor, style = MaterialTheme.typography.labelLarge); Text(presented.detail)
        Text(businessValue("occurredAt", JsonPrimitive(event.text("occurredAt"))), style = MaterialTheme.typography.bodySmall)
        val detail = event.obj("payload").filterKeys { it in setOf("title", "name", "description", "detail", "summary", "reason", "feedback", "note", "notes", "status", "revision", "decision", "coverage", "limitations") }
        if(detail.isNotEmpty()) { TextButton({ expanded = !expanded }) { Text(if(expanded) "收起活动详情" else "查看活动详情") }; if(expanded) detail.forEach { (name, value) -> when(value) { is JsonPrimitive -> if(value != JsonNull) { Text(label(name), style = MaterialTheme.typography.labelLarge); NativeMarkdown(value.content) }; is JsonArray -> value.filterIsInstance<JsonPrimitive>().forEach { Text(it.content) }; else -> Unit } } }
    } }
}

@Composable
fun ProjectLedgerWorkspace(repository: ClientRepository, projectId: String) {
    val account by repository.account.collectAsState(); key(projectId, account?.text("id")) { ProjectLedgerContent(repository, projectId) }
}

@Composable
private fun ProjectLedgerContent(repository: ClientRepository, projectId: String) {
    var type by remember { mutableStateOf("") }; var limit by remember { mutableIntStateOf(10) }; var cursors by remember { mutableStateOf(listOf<String?>(null)) }; var pageIndex by remember { mutableIntStateOf(0) }; var nextCursor by remember { mutableStateOf<String?>(null) }; var refresh by remember { mutableIntStateOf(0) }
    var events by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var knownTypes by remember { mutableStateOf<Map<String, String>>(projectEventTypes.toMap()) }; var loading by remember { mutableStateOf(true) }; var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(type, limit, pageIndex, refresh) {
        loading = true; error = null; nextCursor = null
        try { val requested = cursors[pageIndex]; val page = repository.get(projectLedgerQuery(projectId, type, limit, requested)); check(page["items"] is JsonArray) { "活动分页响应缺少记录列表，请刷新重试。" }; val next = page.text("nextCursor").takeIf { it.isNotBlank() }; check(next == null || (next != requested && next !in cursors.take(pageIndex + 1))) { "活动分页游标重复，请刷新重试。" }; events = page.rows(); nextCursor = next; knownTypes = LinkedHashMap(knownTypes).apply { events.forEach { event -> putIfAbsent(event.text("type"), presentProjectEvent(event).title) } } } catch(e: CancellationException) { throw e } catch(e: Exception) { events = emptyList(); error = e.message ?: "活动记录暂不可用" } finally { loading = false }
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
        item { Text("活动历史", style = MaterialTheme.typography.headlineSmall); Text("任务、成果与 AI 操作按发生时间倒序记录。筛选使用后端的精确事件类型。") }
        item { AssessmentChoice("事件类型", type, listOf("" to "全部活动") + knownTypes.map { it.key to it.value }) { type = it; cursors = listOf(null); pageIndex = 0 }; AssessmentChoice("每页条数", limit.toString(), listOf("10" to "10 条", "20" to "20 条", "50" to "50 条")) { limit = it.toInt(); cursors = listOf(null); pageIndex = 0 } }
        item { TextButton({ refresh++ }, enabled = !loading) { Text("刷新本页活动") }; Text("第 ${pageIndex + 1} 页 · 本页 ${if(loading || error != null) "—" else events.size} 条") }
        if(loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        items(events, key = { it.text("eventId") }) { NativeAiReferenceBadge(); ProjectEventCard(it) }
        if(!loading && error == null && events.isEmpty()) item { Text("暂无此类事件记录。操作发生后会在此保留历史。") }
        item { Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { OutlinedButton({ pageIndex-- }, enabled = !loading && pageIndex > 0) { Text("上一页") }; Button({ val next = nextCursor; if(next != null) { cursors = cursors.take(pageIndex + 1) + next; pageIndex++ } }, enabled = !loading && error == null && nextCursor != null) { Text("下一页") } } }
    }
}

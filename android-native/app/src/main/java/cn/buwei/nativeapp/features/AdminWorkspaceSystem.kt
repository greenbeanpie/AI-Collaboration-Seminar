package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import java.util.UUID

internal suspend fun adminQueueRetries(repository: ClientRepository): JsonObject {
    val owner = repository.accountId ?: error("请先登录"); val epoch = repository.epoch
    val drafts = NativeDraftStore(repository); val record = "admin-retry-body"
    val key = drafts.read(record, owner, epoch)?.text("key")?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().also { generated -> drafts.save(record, buildJsonObject { put("key", generated) }, owner, epoch) }
    check(repository.accountId == owner && repository.epoch == epoch)
    return repository.requestDurably("admin-ai-retry", "POST", "/api/v1/admin/ai-retries", buildJsonObject { put("idempotencyKey", key) }).also { drafts.remove(record, owner, epoch) }
}

@Composable
internal fun AdminRead(repository: ClientRepository, title: String, path: String, refresh: Int, failed: (Exception) -> Unit) {
    var value by remember(path) { mutableStateOf<JsonObject?>(null) }; var open by remember(path) { mutableStateOf(false) }
    TextButton({ open = !open }) { Text(title) }
    LaunchedEffect(path, open, refresh) { if(open) try { value = repository.networkJson("GET", path) } catch(e: CancellationException) { throw e } catch(e: Exception) { value = null; failed(e) } }
    if(open) value?.let { AdminSummary(it) }
}

@Composable
internal fun AdminSystem(repository: ClientRepository, superAdmin: Boolean, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    AdminRead(repository, "后端能力与上传限制", "/api/v1/capabilities", refresh, failed)
    AdminRead(repository, "当前账户资源用量", "/api/v1/resource-usage", refresh, failed)
    var retry by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(refresh) { try { retry = repository.networkJson("GET", "/api/v1/admin/ai-retries") } catch(e: CancellationException) { throw e } catch(e: Exception) { retry = null; failed(e) } }
    Text("失败 AI 请求重试", style = MaterialTheme.typography.titleLarge)
    retry?.let { status -> Text("失败请求 ${status.text("failedCount")} · 待重试队列 ${status.text("pendingRetryCount")}"); (status["activeBatch"] as? JsonObject ?: status["latestBatch"] as? JsonObject)?.let { AdminSummary(it); Text("排队完成仅表示交给后台，不代表模型已执行成功。") }
        if(superAdmin) {
            Button({ ask("将当前失败请求排队重试？可能产生模型费用。请先核对供应商结果，结果不明的请求不得盲目重复。") { adminQueueRetries(repository) } }, enabled = !busy && status.text("failedCount").toIntOrNull()?.let { it > 0 } == true && status["activeBatch"] !is JsonObject) { Text("将失败请求排队重试") }
            TextButton({ ask("仅清除尚未领取的待重试记录？失败任务、原日志及正在处理/已排队条目保留。") { repository.requestDurably("admin-clear-pending-retries", "DELETE", "/api/v1/admin/ai-retries") } }, enabled = !busy && status.text("pendingRetryCount").toIntOrNull()?.let { it > 0 } == true) { Text("清除待重试记录") }
        }
    }
    if(superAdmin) {
        AdminRead(repository, "AI 诊断日志（不含密钥或提示正文）", "/api/v1/admin/ai-diagnostics", refresh, failed)
        TextButton({ ask("清空 AI 诊断日志？只影响诊断记录，不发起模型请求。") { repository.requestDurably("admin-clear-diagnostics", "DELETE", "/api/v1/admin/ai-diagnostics") } }, enabled = !busy) { Text("清空诊断日志") }
        AdminHeldRequests(repository, refresh, busy, ask, failed)
        AdminStorageInventory(repository, refresh, busy, ask, failed)
        AdminIdempotencyRecovery(repository, refresh, busy, ask, failed)
    }
}

@Composable
internal fun AdminHeldRequests(repository: ClientRepository, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    var rows by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var selected by remember { mutableStateOf("") }; var reason by remember { mutableStateOf("") }; var confirmed by remember { mutableStateOf(false) }; var open by remember { mutableStateOf(false) }
    TextButton({ open = !open }) { Text("AI 并发异常核对") }
    LaunchedEffect(open, refresh) { if(open) try { rows = assessmentPages(repository, "/api/v1/admin/ai-resource-dispatches") } catch(e: CancellationException) { throw e } catch(e: Exception) { failed(e) } }
    if(open) {
        Text("只有供应商确认原请求已结束后，才能释放名额；保留当日调用计数，不自动重放。")
        AssessmentChoice("待核对请求", selected, rows.map { it.text("id") to "${it.text("operation")} · ${it.text("model")} · ${it.text("created_at")}" }) { selected = it; reason = ""; confirmed = false }
        rows.find { it.text("id") == selected }?.let { row -> AdminSummary(row); OutlinedTextField(reason, { reason = it.take(500) }, Modifier.fillMaxWidth(), label = { Text("核对依据与原因（至少10字）") }); Row { Checkbox(confirmed, { confirmed = it }); Text("已向供应商确认请求结束") }; Button({ val id = selected; val evidence = reason.trim(); ask("审计释放此请求并发名额？当日调用次数不会退还。") { repository.requestDurably("admin-ai-release:$id", "POST", "/api/v1/admin/ai-resource-dispatches/${Uri.encode(id)}/release", buildJsonObject { put("providerConfirmedEnded", true); put("reason", evidence) }) } }, enabled = !busy && confirmed && reason.trim().length >= 10) { Text("审计释放并发") } }
        if(rows.isEmpty()) Text("没有待核对请求。")
    }
}

@Composable
internal fun AdminStorageInventory(repository: ClientRepository, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    var inventory by remember { mutableStateOf<JsonObject?>(null) }; var policy by remember { mutableStateOf<JsonObject?>(null) }; var note by remember { mutableStateOf("") }; var open by remember { mutableStateOf(false) }
    TextButton({ open = !open }) { Text("当前应用桶的存储盘点") }
    LaunchedEffect(open, refresh) { if(open) try { inventory = repository.networkJson("GET", "/api/v1/admin/storage-inventory"); policy = repository.networkJson("GET", "/api/v1/admin/resource-policy") } catch(e: CancellationException) { throw e } catch(e: Exception) { inventory = null; failed(e) } }
    if(open) {
        Text("只盘点当前项目应用桶，不扣除其他桶占用。盘点可能暂时影响上传额度判断，保留所有原对象。")
        inventory?.let { current -> AdminSummary(current); OutlinedTextField(note, { note = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text("盘点核验说明（至少10字）") })
            Button({ val version = policy?.get("version") ?: return@Button; val evidence = note.trim(); ask("开始当前应用桶盘点？此操作更新存储账本与策略版本，不删除对象。") { repository.requestDurably("admin-storage-start", "POST", "/api/v1/admin/storage-inventory/start", buildJsonObject { put("expectedVersion", version); put("verificationNote", evidence) }) } }, enabled = !busy && !current.flag("scanning") && note.trim().length >= 10 && policy != null) { Text("开始盘点") }
            Button({ ask("继续读取下一批最多100个对象并更新盘点进度？") { repository.requestDurably("admin-storage-continue:${current.text("objectCount")}", "POST", "/api/v1/admin/storage-inventory/continue") } }, enabled = !busy && current.flag("scanning")) { Text("继续下一批盘点") }
        }
    }
}

@Composable
private fun AdminIdempotencyRecovery(repository: ClientRepository, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    var rows by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var selected by remember { mutableStateOf("") }; var checked by remember { mutableStateOf(false) }; var open by remember { mutableStateOf(false) }
    TextButton({ open = !open }) { Text("滞留幂等记录人工核对") }
    LaunchedEffect(open, refresh) { if(open) try { rows = assessmentPages(repository, "/api/v1/admin/idempotency/stuck") } catch(e: CancellationException) { throw e } catch(e: Exception) { failed(e) } }
    if(open) {
        Text("先核实业务是否已经完成。释放后允许原键再次提交，不会自动重试业务。")
        AssessmentChoice("滞留业务", selected, rows.mapIndexed { i, row -> i.toString() to "${row.text("operation")} · ${row.text("createdAt")}" }) { selected = it; checked = false }
        rows.getOrNull(selected.toIntOrNull() ?: -1)?.let { row -> AdminSummary(row); Row { Checkbox(checked, { checked = it }); Text("已人工核实该业务当前状态") }; Button({ val payload = buildJsonObject { put("idempotencyKey", row["idempotencyKey"] ?: row["key"] ?: JsonPrimitive("")); put("userId", row["userId"] ?: JsonPrimitive("")); put("operation", row["operation"] ?: JsonPrimitive("")) }; ask("释放所选滞留幂等记录？只有人工确认后，原键才允许重新提交。") { repository.requestDurably("admin-idempotency-release:${row.text("idempotencyKey")}", "POST", "/api/v1/admin/idempotency/release", payload) } }, enabled = !busy && checked) { Text("释放已核实的滞留记录") } }
        if(rows.isEmpty()) Text("没有滞留记录。")
    }
}

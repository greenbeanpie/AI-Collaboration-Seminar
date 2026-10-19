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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import kotlinx.serialization.json.*

internal typealias AdminAsk = (String, suspend () -> JsonObject) -> Unit
internal fun adminLabel(key: String): String = mapOf("userDailyCalls" to "个人每日 AI 调用上限", "projectDailyCalls" to "项目每日 AI 调用上限", "platformDailyCalls" to "平台每日 AI 调用上限", "globalConcurrency" to "平台同时 AI 请求数", "userStorageBytes" to "个人存储上限（字节）", "projectStorageBytes" to "项目存储上限（字节）", "platformStorageBytes" to "平台存储上限（字节）", "uploadPoolBytes" to "上传池上限（字节）", "maxModelCalls" to "每窗口模型调用上限", "aiEnabled" to "允许平台 AI 请求", "inventoryReady" to "存储盘点已就绪", "ready" to "已就绪", "scanning" to "正在盘点", "hasMore" to "仍有后续批次", "checkedAt" to "核验时间", "objectCount" to "账本对象数", "accountedBytes" to "已入账字节数", "reservedBytes" to "预占字节数", "operation" to "业务操作", "created_at" to "创建时间", "quota_day" to "计数日期", "lease_until" to "语音期限", "deletedItems" to "已清除待重试记录", "completedBatches" to "已结束排队批次", "replayed" to "读取原批次而未重复排队", "released" to "已释放", "retainedEntries" to "保留日志数", "retainedBytes" to "保留日志字节数")[key] ?: label(key)
internal fun adminSecret(name: String) = name.contains("encrypted", true) || name.contains("secret", true) || name.contains("password", true) || name == "apiKey" || name == "gatewayToken" || name == "token" || name == "code"
internal fun adminPublicDraft(value: JsonObject): JsonObject = JsonObject(value.filterKeys { !adminSecret(it) && !it.contains("authorization", true) && !it.contains("credential", true) && !it.endsWith("Headers", true) }.mapValues { (_, v) -> when(v) { is JsonObject -> adminPublicDraft(v); is JsonArray -> JsonArray(v.map { if(it is JsonObject) adminPublicDraft(it) else it }); else -> v } })
internal fun adminEditableConfig(value: JsonObject): JsonObject = JsonObject(value.filterKeys { !adminSecret(it) && !it.endsWith("Configured") && it !in setOf("enabledOutputLimit", "maxOutputTokens", "pricePerMTokens", "cachedInputPricePerMTokens", "mediaInputPricePerMTokens") }.mapValues { (_, v) -> if(v is JsonObject) adminEditableConfig(v) else v })
internal fun adminAiPatch(version: Int, changed: JsonObject): JsonObject {
    require(changed.keys.none { it in setOf("id", "version", "enabled", "expectedVersion") }) { "启用和停用必须单独确认" }
    return JsonObject(changed + ("expectedVersion" to JsonPrimitive(version)))
}

@Composable
internal fun AdminSummary(value: JsonElement, name: String = "") {
    when(value) {
        is JsonObject -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) { value.filterKeys { !adminSecret(it) && it !in setOf("nextCursor", "id", "userId", "projectId", "target_id", "user_id", "project_id", "requestId", "idempotencyKey") }.forEach { (key, child) -> if(child != JsonNull) { if(child is JsonObject || child is JsonArray) { Text(label(key), style = MaterialTheme.typography.titleSmall); Box(Modifier.padding(start = 8.dp)) { AdminSummary(child, key) } } else AdminSummary(child, key) } } }
        is JsonArray -> value.forEach { child -> AdminSummary(child, name) }
        is JsonPrimitive -> if(value != JsonNull) Text("${adminLabel(name)}：${businessValue(name, value)}")
    }
}

@Composable
fun AdminWorkspace(repository: ClientRepository, section: String) {
    val account by repository.account.collectAsState(); key(account?.text("id"), section) {
        val user = account
        if (user?.flag("isAdmin") != true) { Column(Modifier.padding(16.dp)) { Text("需要系统管理员权限"); Text("项目负责人身份不赋予系统管理权限。") } }
        else if(section == "ai-settings" && user.text("role") != "super_admin") { Text("模型与全局策略仅供超级管理员管理。", Modifier.padding(16.dp)) }
        else AdminWorkspaceContent(repository, section, user.text("role") == "super_admin")
    }
}

@Composable
private fun AdminWorkspaceContent(repository: ClientRepository, section: String, superAdmin: Boolean) {
    var refresh by remember { mutableIntStateOf(0) }; var busy by remember { mutableStateOf(false) }; var denied by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }; var result by remember { mutableStateOf<JsonObject?>(null) }; var confirm by remember { mutableStateOf<Pair<String, suspend () -> JsonObject>?>(null) }; val scope = rememberCoroutineScope()
    val owner = repository.accountId; val epoch = repository.epoch
    val ask: AdminAsk = { prompt, block -> if(!busy && !denied) confirm = prompt to block }
    fun failed(exception: Exception) { if(exception is cn.buwei.nativeapp.data.ApiException && exception.status in listOf(401,403,404)) { denied = true; result = null }; error = exception.message }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(when(section) { "accounts" -> "账户与注册管理"; "ai-settings" -> "AI 模型与全局策略"; else -> "系统概况与维护" }, style = MaterialTheme.typography.headlineSmall)
        TextButton({ refresh++; error = null; result = null }, enabled = !busy && !denied) { Text("刷新管理数据") }; if(busy) LinearProgressIndicator(Modifier.fillMaxWidth()); error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if(denied) Text("管理员权限已变化。请重新登录或在其他页面刷新账户身份后重试。")
        else when(section) { "accounts" -> AdminAccounts(repository, superAdmin, refresh, busy, ask, ::failed); "ai-settings" -> AdminAiSettings(repository, refresh, busy, ask, ::failed); else -> AdminSystem(repository, superAdmin, refresh, busy, ask, ::failed) }
        result?.let { Text("操作结果", style = MaterialTheme.typography.titleMedium); AdminSummary(it) }
    }
    confirm?.let { (prompt, block) -> AlertDialog(onDismissRequest = { confirm = null }, title = { Text("确认管理操作") }, text = { Text(prompt) }, confirmButton = { TextButton({ confirm = null; if(!busy) { busy = true; scope.launch { try { check(repository.accountId == owner && repository.epoch == epoch) { "账户已变化" }; result = block(); refresh++ } catch(e: CancellationException) { throw e } catch(e: Exception) { failed(e) } finally { busy = false } } } }) { Text("确认执行") } }, dismissButton = { TextButton({ confirm = null }) { Text("取消") } }) }
}

@Composable
private fun AdminAccounts(repository: ClientRepository, superAdmin: Boolean, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    var accounts by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var invitations by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var selected by remember { mutableStateOf("") }; var displayName by remember { mutableStateOf("") }; var role by remember { mutableStateOf("user") }; var code by remember { mutableStateOf("") }
    LaunchedEffect(refresh) { try { accounts = assessmentPages(repository, "/api/v1/admin/accounts"); invitations = assessmentPages(repository, "/api/v1/admin/account-invitations") } catch(e: CancellationException) { throw e } catch(e: Exception) { failed(e) } }
    val account = accounts.find { it.text("id") == selected }; val canEdit = account != null && (superAdmin || account.text("role") == "user")
    AssessmentChoice("选择账户", selected, accounts.map { it.text("id") to "${it.text("displayName")} · ${it.text("username")} · ${it.text("role")}" }) { id -> selected = id; accounts.find { it.text("id") == id }?.let { displayName = it.text("displayName"); role = it.text("role") } }
    account?.let { row -> Text("账户等级：${row.text("role")}"); if(canEdit) { OutlinedTextField(displayName, { displayName = it.take(64) }, Modifier.fillMaxWidth(), label = { Text("显示名称") }); Button({ val name = displayName.trim(); ask("保存此账户显示名称？") { repository.requestDurably("admin-account:$selected:profile", "PATCH", "/api/v1/admin/accounts/${Uri.encode(selected)}/profile", buildJsonObject { put("displayName", name) }) } }, enabled = !busy && displayName.isNotBlank() && displayName != row.text("displayName")) { Text("保存显示名称") } }
        if(superAdmin) { AssessmentChoice("账户等级", role, listOf("user" to "一般用户", "admin" to "普通管理员", "super_admin" to "超级管理员")) { role = it }; Button({ val id = selected; val desired = role; ask("调整此账户等级为 $desired？可能改变系统管理权限。") { repository.requestDurably("admin-account:$id:role", "PATCH", "/api/v1/admin/accounts/${Uri.encode(id)}/role", buildJsonObject { put("role", desired) }) } }, enabled = !busy && role != row.text("role")) { Text("保存账户等级") } }
    }
    Text("一次性注册邀请码", style = MaterialTheme.typography.titleLarge)
    Button({ ask("生成一个单次账户注册码？完整码只在本次响应显示，请及时保存。") { repository.requestDurably("admin-registration-code", "POST", "/api/v1/admin/account-invitations", buildJsonObject {}).also { code = it.text("code") }.let { JsonObject(it.filterKeys { key -> key != "code" }) } } }, enabled = !busy && code.isBlank()) { Text("生成注册邀请码") }
    if(code.isNotBlank()) { androidx.compose.foundation.text.selection.SelectionContainer { Text(code, style = MaterialTheme.typography.headlineSmall) }; TextButton({ code = "" }) { Text("已保存，隐藏邀请码") } }
    invitations.forEach { Text("${it.text("createdAt")} · ${if(it.text("usedAt").isBlank()) "未使用" else "已使用 ${it.text("usedAt")}"}") }
    if(superAdmin) AdminPasswordRecovery(repository, accounts, busy, ask)
}

@Composable
private fun AdminPasswordRecovery(repository: ClientRepository, accounts: List<JsonObject>, busy: Boolean, ask: AdminAsk) {
    var selected by remember { mutableStateOf("") }; var reason by remember { mutableStateOf("") }; var verified by remember { mutableStateOf(false) }; var issued by remember { mutableStateOf<JsonObject?>(null) }
    Text("人工核实后的密码恢复", style = MaterialTheme.typography.titleLarge); Text("先独立核实账户归属；未验证邮箱不能作恢复依据。系统不会自动发送代码。")
    AssessmentChoice("已核实账户", selected, accounts.map { it.text("id") to "${it.text("username")} · ${it.text("displayName")}" }) { selected = it }
    OutlinedTextField(reason, { reason = it.take(1000) }, Modifier.fillMaxWidth(), label = { Text("核实依据与原因（至少10字）") }); Row { Checkbox(verified, { verified = it }); Text("我已独立核实账户归属", Modifier.padding(top = 12.dp)) }
    Button({ val id = selected; val evidence = reason.trim(); val owner = repository.accountId; val epoch = repository.epoch; ask("签发一次性密码恢复代码？仅本次响应显示，请通过已核实渠道人工交付。") { val payload = buildJsonObject { put("reason", evidence); put("ownershipVerified", true) }; withContext(Dispatchers.IO) { repository.execute("POST", "/api/v1/admin/accounts/${Uri.encode(id)}/password-recovery", payload.toString().toRequestBody("application/json".toMediaType()), headers = mapOf("X-Password-Recovery" to "1"), expectedOwner = owner, expectedEpoch = epoch).use { response -> check(response.isSuccessful) { "恢复代码签发失败 HTTP ${response.code}" }; issued = Json.parseToJsonElement(response.body.string()).jsonObject.obj("data") } }; reason = ""; verified = false; buildJsonObject { put("message", "恢复代码已签发；不会自动发送") } } }, enabled = !busy && selected.isNotBlank() && reason.trim().length >= 10 && verified && issued == null) { Text("签发一次性恢复代码") }
    issued?.let { Text("有效至 ${it.text("expiresAt")}"); androidx.compose.foundation.text.selection.SelectionContainer { Text(it.text("token")) }; TextButton({ issued = null }) { Text("已交付，隐藏代码") } }
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

private val adminConfigSections = listOf("routingMode" to "模型路由方式", "unified" to "统一模型", "textEconomy" to "文本与要求提取", "visionEconomy" to "图片与 OCR", "review" to "预审与答辩", "mediaUnderstanding" to "Gemini 官方音视频理解", "mimoMediaUnderstanding" to "小米官方音视频理解", "processingStrategies" to "录音文件与演练处理策略", "rehearsalSpeech" to "答辩语音播放", "audioFileTranscription" to "文件音频转写", "realtimeAudioTranscription" to "Gateway 实时音频转写", "searchEnabled" to "联网搜索", "notes" to "配置备注")

@Composable
internal fun AdminAiSettings(repository: ClientRepository, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    AdminPolicyEditor(repository, "/api/v1/admin/resource-policy", "平台资源额度", refresh, busy, ask, failed)
    Text("存储额度仅统计当前应用桶，失败或结果未知的真实 AI 请求也计入当日。", style = MaterialTheme.typography.bodySmall)
    AdminPolicyEditor(repository, "/api/v1/admin/ai-execution-policy", "后台 AI 执行策略", refresh, busy, ask, failed)
    Text("每窗口上限控制暂停节奏，累计窗口不设固定上限。修改将在新窗口生效。", style = MaterialTheme.typography.bodySmall)
    AdminHeldRequests(repository, refresh, busy, ask, failed)
    var saved by remember { mutableStateOf<JsonObject?>(null) }; var changed by remember { mutableStateOf(JsonObject(emptyMap())) }; var draftVersion by remember { mutableStateOf<Int?>(null) }; var selected by remember { mutableStateOf("routingMode") }; var notice by remember { mutableStateOf("") }
    val schema = remember { NativeContracts.operations.first { it.method == "PUT" && it.path == "/api/v1/admin/ai-config" }.schema }; val properties = schema.obj("properties")
    LaunchedEffect(refresh) { try { saved = repository.networkJson("GET", "/api/v1/admin/ai-config") } catch(e: CancellationException) { throw e } catch(e: Exception) { saved = null; failed(e) } }
    AssessmentDraft(repository, "admin-ai-config", buildJsonObject { put("version", draftVersion?.let(::JsonPrimitive) ?: JsonNull); put("changed", adminPublicDraft(changed)) }, restore = { value -> draftVersion = value["version"]?.jsonPrimitive?.intOrNull; changed = value.obj("changed"); if(changed.isNotEmpty()) notice = "已恢复非密钥配置草稿；新密钥和令牌不会写入本机草稿，请重新填写。" }, failure = { notice = it.orEmpty() })
    Text("AI 模型接入与语音配置", style = MaterialTheme.typography.titleLarge)
    saved?.let { snapshot ->
        val version = snapshot.text("version").toIntOrNull() ?: 0; val config = adminEditableConfig(snapshot.obj("config")); val outdated = draftVersion != null && draftVersion != version
        Text("配置 v$version · ${if(snapshot.flag("enabled")) "AI 已启用" else "AI 未启用"}")
        Text("未编辑密钥不发送，旧密钥不会回显。切换供应商地址时须重新填写或明确清除密钥，后端拒绝将旧密钥转交新地址。")
        if(notice.isNotBlank()) Text(notice)
        AssessmentChoice("配置分区", selected, adminConfigSections.filter { it.first in properties }) { selected = it }
        properties[selected]?.jsonObject?.let { fieldSchema ->
            Text(adminConfigSections.find { it.first == selected }?.second.orEmpty(), style = MaterialTheme.typography.titleMedium)
            val current = changed[selected] ?: if(selected == "notes") snapshot["notes"]?.takeIf { it != JsonNull } else config[selected]
            if(snapshot.obj("config").obj(selected).flag("keyConfigured")) Text("此分区已有供应商密钥；留空表示保留。")
            if(snapshot.obj("config").obj(selected).flag("gatewayTokenConfigured")) Text("此 Gateway 已配置认证令牌；未编辑时保留。")
            SchemaField(selected, fieldSchema, current, required = false) { next ->
                if(draftVersion == null) draftVersion = version
                changed = if(next == null) JsonObject(changed - selected) else JsonObject(changed + (selected to next))
            }
            if(selected in setOf("mediaUnderstanding", "mimoMediaUnderstanding", "realtimeAudioTranscription") && current != null) TextButton({ if(draftVersion == null) draftVersion = version; val flag = when(selected) { "mediaUnderstanding" -> "clearMediaUnderstanding"; "mimoMediaUnderstanding" -> "clearMimoMediaUnderstanding"; else -> "clearRealtimeAudioTranscription" }; changed = JsonObject((changed - selected) + (flag to JsonPrimitive(true))) }) { Text("明确移除此可选分区（保存后生效）") }
        }
        if(outdated) Text("服务端配置版本已变化。草稿保留，请丢弃后重新编辑，避免覆盖他人配置。", color = MaterialTheme.colorScheme.error)
        Button({ val payload = adminAiPatch(version, changed); validate(schema, payload)?.let { notice = it } ?: ask("保存已编辑的配置分区？未编辑分区和密钥由后端保留。此操作不发起模型请求，配置变化可能使 AI 暂停。") { repository.requestDurably("admin-ai-config-save:$version", "PUT", "/api/v1/admin/ai-config", payload).also { changed = JsonObject(emptyMap()); draftVersion = null; notice = "配置已保存，密钥输入已清除。" } } }, enabled = !busy && !outdated && changed.isNotEmpty()) { Text("保存已编辑配置") }
        TextButton({ changed = JsonObject(emptyMap()); draftVersion = null; notice = "本机修改已丢弃，显示当前服务端配置。" }, enabled = !busy) { Text("丢弃本机配置修改") }
        Button({ ask("启用当前已保存的 AI 配置 v$version？此动作仅改变启用状态，后续业务请求可能产生模型费用。") { repository.requestDurably("admin-ai-enable:$version", "PUT", "/api/v1/admin/ai-config", buildJsonObject { put("expectedVersion", version); put("enabled", true) }) } }, enabled = !busy && changed.isEmpty() && !snapshot.flag("enabled") && version > 0) { Text("启用已保存 AI 配置") }
        TextButton({ ask("停用 AI？已保存的模型配置和凭据保留；不会提交当前表单修改。") { repository.requestDurably("admin-ai-disable:$version", "POST", "/api/v1/admin/ai-config/disable", buildJsonObject { put("expectedVersion", version); put("enabled", false) }) } }, enabled = !busy && snapshot.flag("enabled")) { Text("停用 AI") }
        AdminModelProbes(repository, busy || changed.isNotEmpty(), ask)
    }
}

@Composable
private fun AdminPolicyEditor(repository: ClientRepository, path: String, title: String, refresh: Int, busy: Boolean, ask: AdminAsk, failed: (Exception) -> Unit) {
    var open by remember(path) { mutableStateOf(false) }; var saved by remember(path) { mutableStateOf<JsonObject?>(null) }; var draft by remember(path) { mutableStateOf<JsonObject?>(null) }; var baseVersion by remember(path) { mutableStateOf<Int?>(null) }; var error by remember { mutableStateOf<String?>(null) }
    val schema = remember(path) { NativeContracts.operations.first { it.path == path && it.method == "PUT" }.schema }
    TextButton({ open = !open }) { Text(title) }
    LaunchedEffect(open, refresh) { if(open) try { saved = repository.networkJson("GET", path) } catch(e: CancellationException) { throw e } catch(e: Exception) { failed(e) } }
    AssessmentDraft(repository, "admin-policy:$path", buildJsonObject { put("version", baseVersion?.let(::JsonPrimitive) ?: JsonNull); put("draft", draft ?: JsonNull) }, restore = { row -> baseVersion = row["version"]?.jsonPrimitive?.intOrNull; draft = row["draft"] as? JsonObject }, failure = { error = it })
    if(open) saved?.let { current ->
        val version = current.text("version").toIntOrNull() ?: 0; val body = draft ?: JsonObject(current - "version")
        Text("$title · v$version", style = MaterialTheme.typography.titleMedium)
        schema.obj("properties").filterKeys { it != "expectedVersion" }.forEach { (key, field) -> SchemaField(adminLabel(key), field.jsonObject, body[key], required = true) { value -> if(baseVersion == null) baseVersion = version; draft = JsonObject(body.toMutableMap().apply { if(value == null) remove(key) else put(key, value) }) } }
        val conflict = baseVersion != null && baseVersion != version
        if(conflict) Text("策略版本已变化，请载入当前版本重新编辑。", color = MaterialTheme.colorScheme.error)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button({ val payload = JsonObject(body + ("expectedVersion" to JsonPrimitive(version))); validate(schema, payload)?.let { error = it } ?: ask("保存$title？额度和策略影响所有项目；历史记录与资源保留。") { repository.requestDurably("admin-policy:$path:$version", "PUT", path, payload).also { draft = null; baseVersion = null; error = null } } }, enabled = !busy && !conflict && draft != null) { Text("保存$title") }
        TextButton({ draft = null; baseVersion = null }, enabled = !busy) { Text("载入当前策略，丢弃本机编辑") }
    }
}

@Composable
private fun AdminModelProbes(repository: ClientRepository, busy: Boolean, ask: AdminAsk) {
    var purpose by remember { mutableStateOf("textEconomy") }
    Text("连接与能力诊断", style = MaterialTheme.typography.titleLarge)
    AssessmentChoice("测试用途", purpose, listOf("textEconomy" to "文本与要求提取", "visionEconomy" to "图片与 OCR", "review" to "预审与答辩")) { purpose = it }
    Button({ val selected = purpose; ask("测试已保存模型的连接与能力？此测试会发起真实模型请求，可能产生费用。") { repository.requestDurably("admin-model-probe:$selected", "POST", "/api/v1/admin/ai-config/probe", buildJsonObject { put("purpose", selected) }) } }, enabled = !busy) { Text("确认后测试模型（可能计费）") }
    TextButton({ ask("读取官方 Gemini 模型元数据？不上传媒体、不产生生成调用；结果不证明真实媒体质量。") { repository.requestDurably("admin-media-metadata-probe", "POST", "/api/v1/admin/ai-config/media-probe") } }, enabled = !busy) { Text("检查 Gemini 元数据") }
    TextButton({ ask("读取小米官方模型列表？不上传媒体，结果不证明真实识别效果。") { repository.requestDurably("admin-mimo-metadata-probe", "POST", "/api/v1/admin/ai-config/mimo-media-probe") } }, enabled = !busy) { Text("检查小米模型元数据") }
}

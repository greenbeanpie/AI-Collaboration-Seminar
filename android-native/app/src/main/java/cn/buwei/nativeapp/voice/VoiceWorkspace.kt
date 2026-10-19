package cn.buwei.nativeapp.voice

import android.Manifest
import android.content.Context
import android.speech.tts.TextToSpeech
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.Locale
import java.util.UUID

private class QuestionSpeech(context: Context) : AutoCloseable {
    private var engine: TextToSpeech? = null
    var ready by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    init {
        engine = TextToSpeech(context.applicationContext) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                val result = engine?.setLanguage(Locale.SIMPLIFIED_CHINESE)
                failed = result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED
                ready = !failed
            } else failed = true
        }
    }
    fun speak(text: String) { stop(); engine?.speak(text.take(4000), TextToSpeech.QUEUE_FLUSH, null, "native-rehearsal-question") }
    fun stop() { engine?.stop() }
    override fun close() { stop(); engine?.shutdown(); engine = null }
}

@Composable
fun VoiceWorkspace(repository: ClientRepository, projectId: String, rehearsalId: String) {
    val account by repository.account.collectAsState()
    val accountId = account?.get("id")?.jsonPrimitive?.contentOrNull
    val prefix = remember(projectId, rehearsalId) { repository.resolvePath("/projects/$projectId/rehearsals/$rehearsalId") }
    val controller = remember(repository, prefix, accountId) { VoiceSessionController(repository, prefix) }
    val voice by controller.state.collectAsState()
    val context = LocalContext.current
    val speech = remember(context, controller) { QuestionSpeech(context) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val scope = rememberCoroutineScope()
    var detail by remember(prefix, accountId) { mutableStateOf<JsonObject?>(null) }
    var readiness by remember(prefix, accountId) { mutableStateOf<JsonObject?>(null) }
    var error by remember(prefix, accountId) { mutableStateOf("") }
    var answer by remember(prefix, accountId) { mutableStateOf("") }
    var submitting by remember(prefix, accountId) { mutableStateOf(false) }
    var loading by remember(prefix, accountId) { mutableStateOf(false) }
    var unknown by remember(prefix, accountId) { mutableStateOf(false) }
    var answerKey by remember(prefix, accountId) { mutableStateOf(UUID.randomUUID().toString()) }
    var refresh by remember { mutableIntStateOf(0) }
    var lastTranscript by remember(controller) { mutableStateOf("") }
    val turns = (detail?.get("turns") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
    val latest = turns.maxByOrNull { it["sequence"]?.jsonPrimitive?.intOrNull ?: 0 }
    val sequence = latest?.get("sequence")?.jsonPrimitive?.intOrNull ?: 0
    val question = latest?.get("content")?.jsonPrimitive?.contentOrNull.orEmpty()
    val awaiting = latest?.get("kind")?.jsonPrimitive?.contentOrNull in listOf("question", "followup")
    val processing = detail?.get("processingStatus")?.jsonPrimitive?.contentOrNull in listOf("queued", "running", "waiting_input")
    val canAnswer = detail?.get("canOperate")?.jsonPrimitive?.booleanOrNull == true && detail?.get("status")?.jsonPrimitive?.contentOrNull == "active" && awaiting && !processing
    val ready = readiness?.get("ready")?.jsonPrimitive?.booleanOrNull == true && readiness?.get("mode")?.jsonPrimitive?.contentOrNull == "voice-with-text-fallback"
    val busy = voice.phase != "idle"
    val microphone = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && canAnswer && ready && !submitting) { speech.stop(); controller.start(sequence) }
        else if (!granted) error = "麦克风权限被拒绝，可继续文字回答。"
    }
    DisposableEffect(controller, lifecycle, speech) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) { controller.cancel(); speech.stop() } }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer); controller.close(); speech.close() }
    }
    LaunchedEffect(prefix, accountId, refresh) {
        loading = true; error = ""
        try {
            val generation = repository.epoch
            val result = repository.networkJson("GET", prefix)
            val config = repository.networkJson("GET", "$prefix/voice")
            if (repository.epoch == generation && repository.accountId == accountId) {
                detail = result; readiness = config
                val recorded = (result["turns"] as? JsonArray).orEmpty().any { val turn = it.jsonObject; turn["kind"]?.jsonPrimitive?.contentOrNull == "answer" && turn["content"]?.jsonPrimitive?.contentOrNull == answer.trim() }
                if (unknown && recorded) { unknown = false; answer = ""; answerKey = UUID.randomUUID().toString() }
            }
        } catch (failure: Exception) { error = failure.message ?: "无法读取答辩状态，可返回文字答辩。" }
        finally { loading = false }
    }
    LaunchedEffect(sequence) { controller.cancel(); speech.stop(); lastTranscript = voice.transcript }
    LaunchedEffect(voice.transcript) {
        if (voice.transcript.startsWith(lastTranscript)) {
            val added = voice.transcript.removePrefix(lastTranscript).trim()
            if (added.isNotBlank()) answer = listOf(answer, added).filter(String::isNotBlank).joinToString("\n").take(8000)
        }
        lastTranscript = voice.transcript
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("原生语音答辩", style = MaterialTheme.typography.headlineSmall)
        Text("实时转录 → 核对文字 → 手动提交。问题使用设备本地朗读；语音失败后可继续文字回答。")
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (error.isNotBlank()) Text(error, color = MaterialTheme.colorScheme.error)
        if (!ready) Text(readiness?.get("reason")?.jsonPrimitive?.contentOrNull ?: "当前未启用实时语音策略，可使用下方文字回答。")
        turns.forEach { turn ->
            ElevatedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                Text(when (turn["kind"]?.jsonPrimitive?.content) { "answer" -> "我的回答"; "summary" -> "AI 总结（供参考）"; else -> "AI 问题（供参考）" }, style = MaterialTheme.typography.labelMedium)
                Text(turn["content"]?.jsonPrimitive?.contentOrNull.orEmpty())
            } }
        }
        if (question.isNotBlank() && awaiting) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { speech.speak(question) }, enabled = speech.ready && !busy && !submitting) { Text("本地朗读问题") }
                OutlinedButton(onClick = { speech.stop() }) { Text("停止朗读") }
            }
            if (speech.failed) Text("设备中文语音不可用，请阅读问题后回答。")
        }
        if (busy) Text(when (voice.phase) { "connecting" -> "正在连接语音"; "recording" -> "正在录音"; else -> "等待最终字幕" })
        if (voice.transcript.isNotBlank()) Text("已确认字幕（供核对）：${voice.transcript}")
        if (voice.partial.isNotBlank()) Text("临时字幕（未写入回答）：${voice.partial}")
        if (voice.notice.isNotBlank()) Text(voice.notice)
        if (voice.phase == "recording") Button(onClick = { controller.stop() }) { Text("停止并完成转录") }
        else Button(onClick = { error = ""; microphone.launch(Manifest.permission.RECORD_AUDIO) }, enabled = canAnswer && ready && !busy && !submitting && !unknown && System.currentTimeMillis() >= voice.retryAfter) { Text("开始语音回答") }
        if (busy) OutlinedButton(onClick = { controller.cancel() }) { Text("取消并转文字") }
        OutlinedTextField(answer, { answer = it.take(8000) }, Modifier.fillMaxWidth(), label = { Text("核对和编辑回答（最多 8000 字）") }, minLines = 4, enabled = !busy && !submitting)
        if (unknown) Text("上次提交结果尚未确认。请刷新查看轮次和处理状态；不会自动再次发送。", color = MaterialTheme.colorScheme.error)
        Button(onClick = {
            submitting = true; speech.stop(); error = ""
            scope.launch {
                try {
                    val generation = repository.epoch
                    val current = repository.networkJson("GET", prefix)
                    check(repository.epoch == generation && repository.accountId == accountId) { "账户已变化" }
                    val currentTurns = (current["turns"] as? JsonArray).orEmpty().map { it.jsonObject }
                    check(currentTurns.maxOfOrNull { it["sequence"]!!.jsonPrimitive.int } == sequence && current["canOperate"]?.jsonPrimitive?.booleanOrNull == true && current["processingStatus"]?.jsonPrimitive?.contentOrNull !in listOf("queued", "running", "waiting_input")) { "答辩轮次或权限已变化，请刷新后核对" }
                    // The same key is retained if delivery becomes uncertain; never silently replay.
                    repository.networkJson("POST", "$prefix/answers", buildJsonObject { put("content", answer.trim()) }, answerKey)
                    answer = ""; unknown = false; answerKey = UUID.randomUUID().toString(); refresh++
                } catch (failure: Exception) { unknown = true; error = failure.message ?: "提交结果尚未确认" }
                finally { submitting = false }
            }
        }, enabled = canAnswer && answer.isNotBlank() && !busy && !submitting && !unknown) { Text(if (submitting) "正在提交" else "确认提交回答") }
        OutlinedButton(onClick = { refresh++ }, enabled = !busy && !submitting) { Text("刷新答辩状态") }
        if (processing) Text("AI 正在处理本轮回答，请稍后刷新。")
        Text("AI 内容供参考；麦克风在切换应用、退出页面或更换账户时停止。语音连接及回答提交只在点击后执行。")
    }
}

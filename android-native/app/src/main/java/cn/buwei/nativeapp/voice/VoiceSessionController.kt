package cn.buwei.nativeapp.voice

import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*
import okhttp3.*
import java.util.UUID

internal data class VoiceState(val phase: String = "idle", val partial: String = "", val transcript: String = "", val notice: String = "", val retryAfter: Long = 0)

/** Audio never enters offline queues. All reconnects and paid submissions require a user action. */
internal class VoiceSessionController(private val repository: ClientRepository, private val prefix: String) : AutoCloseable {
    private val owner = repository.accountId
    private val epoch = repository.epoch
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow(VoiceState())
    val state = mutable.asStateFlow()
    private var socket: WebSocket? = null
    private var capture: PcmCapture? = null
    private var audioJob: Job? = null
    private var timeout: Job? = null
    private var sessionId: String? = null
    @Volatile private var generation = 0L
    private var audioSequence = 0
    @Volatile private var heardAudio = false
    private val seen = mutableSetOf<Int>()
    init {
        scope.launch { while (isActive) { delay(250); if (!owned()) { release(); mutable.value = VoiceState(notice = "账户已变化，语音已停止"); break } } }
    }
    private fun owned() = owner != null && repository.accountId == owner && repository.epoch == epoch
    private fun update(block: (VoiceState) -> VoiceState) { mutable.value = block(mutable.value) }
    private fun deadline(token: Long, message: String, onlySilence: Boolean = false) {
        timeout?.cancel()
        timeout = scope.launch { delay(15_000); if (token == generation && (!onlySilence || !heardAudio)) fail(message) }
    }
    private fun release() {
        generation++
        timeout?.cancel(); timeout = null
        capture?.stop(); audioJob?.cancel(); audioJob = null
        capture?.close(); capture = null
        socket?.close(1000, "Voice session ended"); socket = null
        val previous = sessionId; sessionId = null
        if (previous != null && owned()) scope.launch {
            runCatching { repository.networkJson("POST", "$prefix/voice-sessions/$previous/close", buildJsonObject {}, UUID.randomUUID().toString()) }
        }
    }
    private fun fail(message: String) {
        release()
        update { it.copy(phase = "idle", partial = "", notice = "$message 可继续文字回答。已确认字幕已保留。", retryAfter = System.currentTimeMillis() + 60_000) }
    }
    fun cancel() { release(); update { it.copy(phase = "idle", partial = "", notice = "录音已取消，已确认字幕已保留") } }
    fun start(sequence: Int) {
        if (!owned() || mutable.value.phase != "idle" || System.currentTimeMillis() < mutable.value.retryAfter) return
        if (mutable.value.transcript.length >= 64000) { update { it.copy(notice = "本页字幕较长，请整理回答并重新进入后继续录音") }; return }
        release(); val token = generation; seen.clear(); audioSequence = 0; heardAudio = false
        update { it.copy(phase = "connecting", partial = "", notice = "正在连接；语音转录可能产生平台用量") }
        scope.launch {
            try {
                val microphone = PcmCapture(repository.context)
                if (token != generation || !owned()) { microphone.close(); return@launch }
                capture = microphone
                val result = repository.networkJson("POST", "$prefix/voice-sessions", buildJsonObject { put("sequence", sequence) }, UUID.randomUUID().toString())
                val id = result["sessionId"]!!.jsonPrimitive.content
                if (token != generation || !owned()) {
                    if (owned()) runCatching { repository.networkJson("POST", "$prefix/voice-sessions/$id/close", buildJsonObject {}, UUID.randomUUID().toString()) }
                    return@launch
                }
                sessionId = id
                val path = VoiceProtocol.streamPath(result["webSocketPath"]!!.jsonPrimitive.content, prefix, id)
                deadline(token, "语音连接超时。")
                socket = repository.socket(path, object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) { scope.launch { if (token == generation && owned()) event(token, webSocket, text, microphone) } }
                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { scope.launch { if (token == generation) fail("语音连接失败。") } }
                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { scope.launch { if (token == generation) fail("语音连接中断。") } }
                },owner,epoch)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) { if (token == generation) fail(failure.message ?: "无法连接语音服务。") }
        }
    }
    private fun event(token: Long, webSocket: WebSocket, text: String, microphone: PcmCapture) {
        try {
            check(text.length <= 256 * 1024)
            val event = Json.parseToJsonElement(text).jsonObject
            when (event["type"]?.jsonPrimitive?.content) {
                "ready" -> {
                    if (mutable.value.phase != "connecting") return
                    check(webSocket.send("{\"type\":\"start\"}"))
                    update { it.copy(phase = "recording", notice = "正在录音，停止后核对字幕再提交") }
                    deadline(token, "未检测到音频输入。", true)
                    audioJob = scope.launch {
                        try {
                            withTimeout(600_000) {
                                microphone.capture { samples, count ->
                                    if (token == generation && owned()) {
                                        for (index in 0 until count) if (kotlin.math.abs(samples[index].toInt()) > 100) { heardAudio = true; break }
                                        check(webSocket.queueSize() <= 160_000) { "音频发送阻塞" }
                                        val frame = buildJsonObject { put("type", "audio"); put("sequence", ++audioSequence); put("data", VoiceProtocol.base64(samples, count)) }
                                        check(webSocket.send(frame.toString())) { "音频发送失败" }
                                    }
                                }
                            }
                        } catch (timeout: TimeoutCancellationException) { if (token == generation) fail("已到十分钟录音上限。") }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (failure: Exception) { if (token == generation) fail(failure.message ?: "麦克风断开。") }
                    }
                }
                "partial" -> { val content = event["text"]!!.jsonPrimitive.content; check(content.length <= 8000); update { it.copy(partial = content) } }
                "final" -> {
                    val index = event["sequence"]!!.jsonPrimitive.int
                    if (!seen.add(index)) return
                    val content = event["text"]!!.jsonPrimitive.content.trim(); check(content.length <= 8000)
                    update { it.copy(partial = "", transcript = listOf(it.transcript, content).filter(String::isNotBlank).joinToString("\n")) }
                }
                "complete" -> { release(); update { it.copy(phase = "idle", partial = "", notice = "转录完成，请核对和编辑字幕后提交", retryAfter = 0) } }
                "error" -> fail(event["message"]?.jsonPrimitive?.content ?: "实时转录失败。")
                else -> fail("语音服务返回了不支持的消息。")
            }
        } catch (failure: Exception) { if (token == generation) fail(failure.message ?: "语音消息格式无效。") }
    }
    fun stop() {
        if (mutable.value.phase != "recording") return
        val token = generation
        update { it.copy(phase = "finalizing", notice = "等待最终字幕") }
        capture?.stop()
        scope.launch {
            audioJob?.join(); capture?.close(); capture = null
            if (token == generation && owned()) {
                if (socket?.send("{\"type\":\"stop\"}") != true) fail("停止音频发送失败。")
                else deadline(token, "等待最终字幕超过 15 秒。")
            }
        }
    }
    override fun close() {
        release()
        // Give the idempotent server-close request a bounded opportunity after composition disposal.
        scope.launch { delay(5_000); scope.cancel() }
    }
}

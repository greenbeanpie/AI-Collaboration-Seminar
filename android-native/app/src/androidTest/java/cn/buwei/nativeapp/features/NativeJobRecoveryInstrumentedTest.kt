package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Loopback only: no production model calls or automatic write retries. */
class NativeJobRecoveryInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var server:MockWebServer
    private lateinit var repository:ClientRepository
    private val user=UUID.randomUUID().toString()
    private val original=UUID.randomUUID().toString()
    private val successor=UUID.randomUUID().toString()
    private val writes=ConcurrentLinkedQueue<RecordedRequest>()
    private val newReads=AtomicInteger()
    private val resumed=AtomicReference<String?>(null)
    private val eligible=AtomicBoolean(true)
    private val failFirst=AtomicBoolean(false)
    private val effective=AtomicReference(original)
    private val retryComplete=AtomicBoolean(false)
    private fun response(raw:String)=MockResponse().setHeader("Content-Type","application/json").setBody("{\"data\":$raw}")
    private fun failed()=response("""{"jobId":"${effective.get()}","status":"failed","activity":{"code":"failed","canResume":${eligible.get()},"uncertain":true,"resumeReason":"固定材料仍有效"},"execution":null}""")
    @Before fun setup() {
        server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val path=request.path.orEmpty().substringBefore('?')
            if(path=="/api/v1/auth/native/exchange")return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie","ai_office_session=fixture")
            if(request.method=="POST") {
                writes.add(request)
                if(failFirst.getAndSet(false))return MockResponse().setResponseCode(503).setBody("""{"error":{"code":"UNAVAILABLE","message":"测试恢复暂不可用"}}""")
                retryComplete.set(true);return response("""{"jobId":"$successor"}""").setResponseCode(202)
            }
            if(path=="/api/v1/jobs/$successor") {newReads.incrementAndGet();return response("""{"jobId":"$successor","status":"succeeded","activity":{"canResume":false},"execution":null}""")}
            if(path=="/api/v1/jobs/$original")return failed()
            if(path=="/api/v1/jobs/${effective.get()}")return failed()
            return response("""{"items":[],"nextCursor":null}""")
        }};server.start()
        repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"job-recovery-${UUID.randomUUID()}-")
        runBlocking { repository.exchange("fixture","fixture") }
    }
    @After fun cleanup(){server.shutdown()}
    private fun waitFor(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
    private fun showJob(){compose.setContent{NativeTheme{Surface{Column{
        var input by remember{mutableStateOf("尚未发送的回答草稿")}
        OutlinedTextField(input,{input=it},label={Text("保留草稿")})
        NativeJobExecution(repository,original,onResumed={resumed.set(it)})
    }}}};waitFor("恢复失败执行")}
    private fun confirmResume(){compose.onNodeWithText("恢复失败执行").performClick();compose.onNodeWithText("恢复失败执行？").assertExists();compose.onNodeWithText("确认").performClick()}
    @Test fun confirmationRequiredThenTracksReturnedJobAndKeepsDraft() {
        showJob();assertTrue(writes.isEmpty())
        compose.onNodeWithText("恢复失败执行").performClick();assertTrue(writes.isEmpty());compose.onNodeWithText("返回").performClick();assertTrue(writes.isEmpty())
        confirmResume();waitFor("AI 执行 · succeeded")
        assertEquals(1,writes.size);assertEquals("/api/v1/jobs/$original/retry",writes.first().path)
        assertFalse(writes.first().getHeader("Idempotency-Key").isNullOrBlank());assertEquals(0L,writes.first().body.size)
        assertEquals(successor,resumed.get());assertTrue(newReads.get()>0)
        compose.onNodeWithText("尚未发送的回答草稿").assertExists()
    }
    @Test fun permissionRecheckedAfterDialogBeforeAnyWrite() {
        showJob();compose.onNodeWithText("恢复失败执行").performClick();eligible.set(false);compose.onNodeWithText("确认").performClick()
        waitFor("不会自动再次发送");assertTrue(writes.isEmpty());compose.onNodeWithText("恢复失败执行").assertDoesNotExist()
        compose.onNodeWithText("尚未发送的回答草稿").assertExists()
    }
    @Test fun failedPostRequiresAnotherConfirmationAndReusesDurableIntentKey() {
        failFirst.set(true);showJob();confirmResume();waitFor("测试恢复暂不可用")
        assertEquals(1,writes.size);compose.onNodeWithText("尚未发送的回答草稿").assertExists()
        compose.onNodeWithText("刷新执行状态").performClick();waitFor("恢复失败执行");assertEquals(1,writes.size)
        confirmResume();waitFor("AI 执行 · succeeded");assertEquals(2,writes.size)
        val requests=writes.toList();assertEquals(requests[0].getHeader("Idempotency-Key"),requests[1].getHeader("Idempotency-Key"))
    }
    @Test fun retriesEffectiveSuccessorReturnedByGetRatherThanOldAttempt() {
        val current=UUID.randomUUID().toString();effective.set(current);showJob();confirmResume();waitFor("AI 执行 · succeeded")
        assertEquals("/api/v1/jobs/$current/retry",writes.single().path)
    }
    @Test fun unansweredProjectQuestionRemainsRecoverableWithoutPendingJobAndKeepsComposer() {
        val project=UUID.randomUUID().toString();val question=UUID.randomUUID().toString();val delegate=server.dispatcher
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val path=request.path.orEmpty().substringBefore('?')
            if(path=="/api/v1/projects/$project/ai-chat")return response("""{"items":[{"id":"question-$question","questionId":"$question","role":"user","content":"已有失败问题","jobId":"$original","createdAt":"2026-10-19T10:00:00Z"}${if(retryComplete.get())",{\"id\":\"answer-$question\",\"questionId\":\"$question\",\"role\":\"assistant\",\"content\":\"恢复后的回答\",\"createdAt\":\"2026-10-19T10:01:00Z\"}"else ""}],"nextCursor":null,"pendingJobId":null}""")
            return delegate.dispatch(request)
        }}
        compose.setContent{NativeTheme{Surface{AiConversationScreen(repository,project)}}}
        waitFor("恢复失败执行");compose.onNodeWithText("询问项目 AI").performTextInput("下一条本机问题草稿");androidx.test.espresso.Espresso.closeSoftKeyboard()
        confirmResume();waitFor("恢复后的回答");assertEquals(1,writes.size)
        assertEquals("/api/v1/jobs/$original/retry",writes.single().path)
        compose.onNodeWithText("下一条本机问题草稿").assertExists()
    }
    @Test fun rehearsalRecoveryTracksReturnedJobWithoutResubmittingAnswerDraft() {
        val project=UUID.randomUUID().toString();val rehearsal=UUID.randomUUID().toString();val base="/api/v1/projects/$project";val delegate=server.dispatcher
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            return when(request.path.orEmpty().substringBefore('?')) {
                "/api/v1/capabilities"->response("""{"features":{"aiEnabled":true}}""")
                base->response("""{"myRole":"owner"}""")
                "$base/rehearsals"->response("""{"items":[{"rehearsalId":"$rehearsal","status":"active","scope":"all","createdAt":"2026-10-19"}],"nextCursor":null}""")
                "$base/rehearsals/$rehearsal"->response("""{"rehearsalId":"$rehearsal","canOperate":true,"status":"active","processingStatus":"failed","processingJobId":"$original","turns":[{"role":"assistant","kind":"question","sequence":1,"content":"说明固定成果的证据"}]}""")
                else->delegate.dispatch(request)
            }
        }}
        compose.setContent{NativeTheme{Surface{RehearsalWorkspace(repository,project,initialRehearsalId=rehearsal)}}}
        waitFor("恢复失败执行");compose.onNodeWithText("本轮真实回答").performScrollTo().performTextInput("保留演练回答草稿");androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.onNodeWithText("恢复失败执行").performScrollTo().performClick();assertTrue(writes.isEmpty());compose.onNodeWithText("确认").performClick()
        waitFor("AI 执行 · succeeded");assertEquals(1,writes.size);assertEquals("/api/v1/jobs/$original/retry",writes.single().path);assertTrue(newReads.get()>0)
        compose.onNodeWithText("保留演练回答草稿").assertExists()
    }
}

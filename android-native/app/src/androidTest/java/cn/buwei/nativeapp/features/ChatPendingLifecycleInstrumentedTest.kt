package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ChatPendingLifecycleInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var server:MockWebServer
    private lateinit var repository:ClientRepository
    private val project=UUID.randomUUID().toString();private val job=UUID.randomUUID().toString();private val user=UUID.randomUUID().toString()
    private val historyReads=AtomicInteger();private val jobReads=AtomicInteger();private val writes=AtomicInteger()
    private val completed=AtomicBoolean();private val denied=AtomicBoolean()
    private val lifecycleOwner=object:LifecycleOwner{override val lifecycle=LifecycleRegistry(this)}
    private fun response(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
    @Before fun setup(){
        server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
            val path=request.path.orEmpty().substringBefore('?')
            if(path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",buildJsonObject{put("id",user)})}).addHeader("Set-Cookie","ai_office_session=fixture")
            if(request.method!="GET"){writes.incrementAndGet();return MockResponse().setResponseCode(400)}
            if(path=="/api/v1/projects/$project/ai-chat"){
                historyReads.incrementAndGet()
                if(denied.get())return MockResponse().setResponseCode(403).setHeader("Content-Type","application/json").setBody("""{"error":{"message":"问答权限已撤销"}}""")
                return response(buildJsonObject{
                    put("items",buildJsonArray{
                        add(buildJsonObject{put("id","question");put("questionId","question");put("role","user");put("jobId",job);put("content","等待后台完成的问题\n\n"+"较长的已有对话。\n\n".repeat(35));put("createdAt","2026-10-19T00:00:00Z")})
                        if(completed.get())add(buildJsonObject{put("id","answer");put("questionId","question");put("role","assistant");put("content","完成后的新回答");put("createdAt","2026-10-19T00:01:00Z")})
                    });put("pendingJobId",if(completed.get())JsonNull else JsonPrimitive(job));put("nextCursor",JsonNull)
                })
            }
            if(path=="/api/v1/jobs/$job"){jobReads.incrementAndGet();return response(buildJsonObject{put("jobId",job);put("status","running");put("activity",buildJsonObject{});put("execution",JsonNull)})}
            return response(buildJsonObject{put("items",JsonArray(emptyList()));put("nextCursor",JsonNull)})
        }};server.start()
        repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"chat-lifecycle-${UUID.randomUUID()}-")
        runBlocking{repository.exchange("fixture","fixture")}
        compose.setContent{NativeTheme{CompositionLocalProvider(LocalLifecycleOwner provides lifecycleOwner){Surface(Modifier.height(300.dp).fillMaxWidth()){AiConversationScreen(repository,project)}}}}
        compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.STARTED}
        compose.waitUntil(10000){historyReads.get()>0&&compose.onAllNodes(hasScrollToIndexAction()).fetchSemanticsNodes().isNotEmpty()}
    }
    @After fun cleanup(){compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.DESTROYED};server.shutdown()}
    @Test fun pendingAnswerRefreshDoesNotDependOnKeepingItsMessageCardOnScreen(){
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("询问项目 AI"))
        completed.set(true)
        compose.waitUntil(10000){historyReads.get()>=2}
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("完成后的新回答"))
        compose.onNodeWithText("完成后的新回答").assertIsDisplayed();assertEquals(0,writes.get())
    }
    @Test fun pausedScreenStopsHistoryAndJobPollingAndResumesWhenStarted(){
        compose.waitUntil(10000){jobReads.get()>0}
        compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.CREATED}
        val history=historyReads.get();val jobs=jobReads.get()
        runBlocking{kotlinx.coroutines.delay(3500)}
        assertEquals(history,historyReads.get());assertEquals(jobs,jobReads.get())
        compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.STARTED}
        compose.waitUntil(10000){historyReads.get()>history};assertEquals(0,writes.get())
    }
    @Test fun revokedHistoryClearsServerMessagesDisablesSendAndPreservesUnsentDraft(){
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("询问项目 AI"))
        compose.onNodeWithText("询问项目 AI").performTextInput("仍保留我的本机草稿")
        androidx.test.espresso.Espresso.closeSoftKeyboard();denied.set(true)
        compose.waitUntil(10000){compose.onAllNodesWithText("问答权限已撤销").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithText("等待后台完成的问题",substring=true).assertDoesNotExist()
        compose.onNodeWithText("仍保留我的本机草稿").assertExists();compose.onNodeWithText("发送").performScrollTo().assertIsNotEnabled();assertEquals(0,writes.get())
    }
}

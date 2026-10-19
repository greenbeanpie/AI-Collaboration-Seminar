package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class InquiryReadBatchesInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var server:MockWebServer;private lateinit var repository:ClientRepository
    private val user=UUID.randomUUID().toString();private val project=UUID.randomUUID().toString();private val task=UUID.randomUUID().toString();private val thread=UUID.randomUUID().toString()
    private val ids=(1..201).map{UUID.randomUUID().toString()};private val unloaded=UUID.randomUUID().toString()
    private val writes=ConcurrentLinkedQueue<RecordedRequest>();private val failSecond=AtomicBoolean(false)
    private val holdFirst=AtomicBoolean(false);private val releaseFirst=CountDownLatch(1)
    private val path get()="/api/v1/projects/$project/tasks/$task/inquiries"
    private fun response(data:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
    @Before fun setup(){
        server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            if(request.path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",buildJsonObject{put("id",user)})}).addHeader("Set-Cookie","ai_office_session=fixture")
            if(request.method=="POST") {
                writes.add(request)
                if(writes.size==1&&holdFirst.get())releaseFirst.await(30,TimeUnit.SECONDS)
                if(writes.size==2&&failSecond.getAndSet(false))return MockResponse().setResponseCode(503).setBody("""{"error":{"code":"TEMPORARY_FAILURE","message":"本批结果待核对"}}""")
                return response(buildJsonObject{put("readCount",if(writes.size==1)5 else 0)})
            }
            if(request.path==path)return response(buildJsonObject{put("nextCursor","unloaded-page");put("items",JsonArray(listOf(buildJsonObject{
                put("inquiryId",thread);put("requesterName","提问者");put("recipientName","收件人");put("messages",JsonArray((ids+ids.take(5)).mapIndexed{index,id->buildJsonObject{put("messageId",id);put("authorName","成员");put("body","展示消息 ${index+1}");put("createdAt","2026-10-19")}}))
            })))})
            if(request.path?.contains("cursor=unloaded-page")==true)return response(buildJsonObject{put("items",JsonArray(listOf(buildJsonObject{put("inquiryId","other");put("messages",JsonArray(listOf(buildJsonObject{put("messageId",unloaded);put("body","后续加载的展示消息")})))})));put("nextCursor",JsonNull)})
            return response(buildJsonObject{put("items",JsonArray(emptyList()));put("nextCursor",JsonNull)})
        }};server.start()
        repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"inquiry-read-${UUID.randomUUID()}-")
        runBlocking{repository.exchange("fixture","fixture")}
        compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){TaskInquiriesScreen(repository,project,task)}}}}
        compose.waitUntil(10000){compose.onAllNodesWithText("将本页展示的消息标记已读").fetchSemanticsNodes().isNotEmpty()}
        compose.waitUntil(10000){runCatching{compose.onNodeWithText("将本页展示的消息标记已读").assertIsEnabled()}.isSuccess}
    }
    @After fun cleanup(){releaseFirst.countDown();server.shutdown()}
    private fun waitFor(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
    @Test fun displayedSnapshotOverTwoHundredIsBatchedAndReportsOnlyServerNewReadCount(){
        assertTrue(writes.isEmpty());compose.onNodeWithText("将本页展示的消息标记已读").performScrollTo().performClick()
        waitFor("已确认处理 201 / 201 条展示消息；后端确认新增已读 5 条。")
        val requests=writes.toList();assertEquals(2,requests.size);val batches=requests.map{assertEquals("$path/read",it.path);Json.parseToJsonElement(it.body.readUtf8()).jsonObject.twIds("messageIds")}
        assertEquals(listOf(200,1),batches.map(List<String>::size));assertEquals(ids,batches.flatten());assertFalse(batches.flatten().contains(unloaded))
    }
    @Test fun failedBatchStopsAndExplicitContinueRetriesOnlyRemainingSnapshot(){
        failSecond.set(true);compose.onNodeWithText("将本页展示的消息标记已读").performScrollTo().performClick();waitFor("已停止后续批次")
        assertEquals(2,writes.size);compose.onNodeWithText("已确认处理 200 / 201 条展示消息；后端确认新增已读 5 条。").assertExists()
        compose.onNodeWithText("继续标记剩余展示消息（1 条）").performScrollTo().performClick();waitFor("已确认处理 201 / 201 条展示消息；后端确认新增已读 5 条。")
        val requests=writes.toList();assertEquals(3,requests.size)
        val batches=requests.map{assertEquals("$path/read",it.path);Json.parseToJsonElement(it.body.readUtf8()).jsonObject.twIds("messageIds")}
        assertEquals(ids.take(200),batches[0]);assertEquals(ids.drop(200),batches[1]);assertEquals(batches[1],batches[2]);assertFalse(batches.flatten().contains(unloaded))
    }
    @Test fun laterPageDoesNotExpandRunningSnapshotOrUnlockReadAction(){
        holdFirst.set(true);compose.onNodeWithText("将本页展示的消息标记已读").performScrollTo().performClick()
        try{
            compose.waitUntil(10000){writes.isNotEmpty()};compose.onNodeWithText("加载更多问询").performScrollTo().performClick();waitFor("后续加载的展示消息")
            compose.onNodeWithText("将本页展示的消息标记已读").assertIsNotEnabled();assertEquals(1,writes.size)
        }finally{releaseFirst.countDown()}
        waitFor("已确认处理 201 / 201 条展示消息；后端确认新增已读 5 条。")
        assertEquals(2,writes.size);val sent=writes.flatMap{Json.parseToJsonElement(it.body.readUtf8()).jsonObject.twIds("messageIds")}
        assertEquals(ids,sent);assertFalse(sent.contains(unloaded))
    }
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class TaskProposalParityInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var server:MockWebServer
    private lateinit var repository:ClientRepository
    private val project=UUID.randomUUID().toString();private val proposalId=UUID.randomUUID().toString();private val user=UUID.randomUUID().toString();private val priorTask=UUID.randomUUID().toString()
    private val base get()="/api/v1/projects/$project"
    private val path get()="$base/collaboration/proposals/$proposalId"
    private val writes=ConcurrentLinkedQueue<RecordedRequest>();private val changed=AtomicInteger();private val conflictOnce=AtomicBoolean(false);private val denied=AtomicBoolean(false)
    private val historyReads=AtomicInteger()
    private val holdPatch=AtomicBoolean(false);private val releasePatch=CountDownLatch(1)
    private val initialPayload=Json.parseToJsonElement("""{"planningAction":"adjust","references":[{"resourceType":"source","quote":"固定证据"}],"tasks":[{"key":"first","title":"首项任务","detail":"首项说明","criteria":"引用证据","effortHours":1,"dependsOn":[]},{"key":"second","title":"次项任务","detail":"次项说明","criteria":"完成核对","effortHours":2,"dependsOn":["first"]}]}""").jsonObject
    private fun proposal(payload:JsonObject=initialPayload,revision:Int=4,status:String="pending")=buildJsonObject{put("proposalId",proposalId);put("kind","decompose");put("revision",revision);put("status",status);put("payload",payload);put("createdAt","2026-10-19")}
    private val current=AtomicReference(proposal())
    private fun response(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
    private fun rawResponse(raw:String)=response(Json.parseToJsonElement(raw))
    @Before fun setup(){
        server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val requestPath=request.path.orEmpty().substringBefore('?')
            if(requestPath=="/api/v1/auth/native/exchange")return rawResponse("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie","ai_office_session=fixture")
            if(request.method!="GET") {
                writes.add(request)
                val body=Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                if(request.method=="PATCH") {
                    if(holdPatch.get())releasePatch.await(30,TimeUnit.SECONDS)
                    if(conflictOnce.getAndSet(false)){current.set(proposal(revision=6,status="stale"));return MockResponse().setResponseCode(409).setBody("""{"error":{"code":"VERSION_CONFLICT","message":"方案已更新"}}""")}
                    current.set(proposal(body.obj("payload"),twRevision(current.get())+1));return response(current.get())
                }
                if(requestPath=="$path/apply"){current.set(proposal(current.get().obj("payload"),twRevision(current.get())+1,"applied"));return rawResponse("""{"applied":true,"followupJobId":null}""")}
                if(requestPath=="$base/collaboration/feedback"){current.set(proposal(current.get().obj("payload"),twRevision(current.get())+1,"stale"));return rawResponse("""{"feedbackId":"${UUID.randomUUID()}","queued":false}""")}
                return MockResponse().setResponseCode(400)
            }
            if(denied.get())return MockResponse().setResponseCode(403).setBody("""{"error":{"code":"PERMISSION_DENIED","message":"无权读取反馈"}}""")
            return when(requestPath){
                "$base/collaboration/proposals"->response(buildJsonObject{put("items",JsonArray(listOf(current.get())));put("nextCursor",JsonNull)})
                "$base/collaboration/feedback/current"->rawResponse("""{"version":3,"feedback":"当前新反馈","createdAt":"2026-10-19"}""")
                "$base/collaboration/feedback/history"->{historyReads.incrementAndGet();rawResponse("""{"items":[{"version":3,"feedback":"第一行反馈\n第二行反馈","createdAt":"2026-10-19","actorId":"$user"},{"version":2,"feedback":"","createdAt":"2026-10-18","actorId":"$user"}]}""")}
                else->if(requestPath.startsWith("/api/v1/jobs/"))rawResponse("""{"jobId":"${UUID.randomUUID()}","status":"succeeded","activity":{},"execution":null,"feedbackSnapshot":{"version":1,"feedback":"旧的冻结反馈\n保留冻结换行","createdAt":"2026-10-17"}}""")else rawResponse("""{"items":[],"nextCursor":null}""")
            }
        }};server.start()
        repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"proposal-parity-${UUID.randomUUID()}-")
        runBlocking{repository.exchange("fixture","fixture")}
    }
    @After fun cleanup(){server.shutdown()}
    private fun waitFor(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
    private fun tap(text:String){compose.onNodeWithText(text).performScrollTo().performClick()}
    private fun screen(content:@Composable ()->Unit){compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){content()}}}}}
    private fun showControls(){screen{TaskProposalControls(repository,base,current.get(),listOf(buildJsonObject{put("taskId",priorTask);put("title","既有前置任务")}),emptyList()){changed.incrementAndGet()}};tap("修正建议、部分应用或重新反馈")}
    private fun field(label:String,token:String)=compose.onNode(hasTestTag("reference-input:$label") and hasAnyAncestor(hasTestTag("proposal-row-$token")))
    @Test fun partialApplyRequiresConfirmationAndSendsExplicitEmptyCategories(){
        showControls();compose.onNodeWithTag("proposal-select-tasks:second").performScrollTo().performClick();tap("应用选中条目");assertTrue(writes.isEmpty());compose.onNodeWithText("取消").performClick();assertTrue(writes.isEmpty())
        tap("应用选中条目");compose.onNodeWithText("确认").performClick();waitFor("选中条目已应用");compose.waitUntil(10000){changed.get()>0}
        assertEquals(1,writes.size);val request=writes.single();assertEquals("$path/apply",request.path);val body=Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(listOf("first"),body.twIds("selectedTaskKeys"));assertEquals(JsonArray(emptyList()),body["selectedUpdateTaskIds"]);assertEquals(JsonArray(emptyList()),body["selectedAssignmentTaskIds"]);assertEquals(4,body["expectedRevision"]!!.jsonPrimitive.int)
        assertFalse(request.getHeader("Idempotency-Key").isNullOrBlank())
    }
    @Test fun staleRevisionEditsDependenciesAndMustSaveBeforeApply(){
        current.set(proposal(revision=4,status="stale"));showControls()
        field("任务名称","tasks:first").performTextReplacement("人工修订首项");field("前置任务标识（逗号分隔）","tasks:first").performScrollTo().performTextReplacement(priorTask)
        compose.onNodeWithText("修正理由或重新反馈").performScrollTo().performTextInput("核对前置任务与实际证据");androidx.test.espresso.Espresso.closeSoftKeyboard()
        compose.onNodeWithText("应用选中条目").assertIsNotEnabled();tap("保存方案修正");assertTrue(writes.isEmpty());compose.onNodeWithText("确认").performClick();waitFor("方案修正已保存")
        compose.waitUntil(10000){changed.get()>0};val request=writes.single();assertEquals("PATCH",request.method);val body=Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals(4,body["expectedRevision"]!!.jsonPrimitive.int);assertEquals(listOf(priorTask),body.obj("payload").twRows("tasks")[0].twIds("dependsOn"));assertEquals(initialPayload["references"],body.obj("payload")["references"])
        compose.onNodeWithText("应用选中条目").assertIsEnabled()
    }
    @Test fun conflictPreservesEditsAndSelectionUntilExplicitLatestRevisionReview(){
        conflictOnce.set(true);showControls();field("任务名称","tasks:first").performTextReplacement("冲突后保留名称")
        compose.onNodeWithTag("proposal-select-tasks:second").performScrollTo().performClick();compose.onNodeWithText("修正理由或重新反馈").performScrollTo().performTextInput("保留本机版本后人工复核");androidx.test.espresso.Espresso.closeSoftKeyboard()
        tap("保存方案修正");compose.onNodeWithText("确认").performClick();waitFor("已读取方案 r6")
        compose.onNodeWithText("冲突后保留名称").assertExists();compose.onNodeWithTag("proposal-select-tasks:second").assertIsOff();compose.onNodeWithText("保存方案修正").assertIsNotEnabled()
        tap("已核对最新方案，保留修改并继续");tap("保存方案修正");compose.onNodeWithText("确认").performClick();waitFor("方案修正已保存");assertEquals(2,writes.size)
        val body=Json.parseToJsonElement(writes.last().body.readUtf8()).jsonObject;assertEquals(6,body["expectedRevision"]!!.jsonPrimitive.int);assertEquals("冲突后保留名称",body.obj("payload").twRows("tasks")[0].twText("title"))
        compose.onNodeWithTag("proposal-select-tasks:second").assertIsOff()
    }
    @Test fun feedbackIsConfirmedAndReportsNotQueuedWithoutAutomaticModelWrite(){
        showControls();compose.onNodeWithText("修正理由或重新反馈").performScrollTo().performTextInput("请依据原始资料重新判断");androidx.test.espresso.Espresso.closeSoftKeyboard()
        tap("反馈并要求 AI 重新判断");assertTrue(writes.isEmpty());compose.onNodeWithText("取消").performClick();assertTrue(writes.isEmpty())
        tap("反馈并要求 AI 重新判断");compose.onNodeWithText("确认").performClick();waitFor("反馈已保存，未排队模型任务")
        assertEquals(1,writes.size);assertEquals("$base/collaboration/feedback",writes.single().path);val body=Json.parseToJsonElement(writes.single().body.readUtf8()).jsonObject
        assertEquals("proposal",body.twText("targetType"));assertEquals(proposalId,body.twText("targetId"));assertTrue(body.flag("requestAiRedo"))
    }
    @Test fun pendingSaveDisablesEditorSoServerResponseCannotOverwriteLaterTyping(){
        holdPatch.set(true);showControls();field("任务名称","tasks:first").performTextReplacement("等待保存的标题")
        compose.onNodeWithText("修正理由或重新反馈").performScrollTo().performTextInput("核对后等待服务器保存");androidx.test.espresso.Espresso.closeSoftKeyboard()
        tap("保存方案修正");compose.onNodeWithText("确认").performClick()
        try{compose.waitUntil(10000){writes.isNotEmpty()};field("任务名称","tasks:first").assertIsNotEnabled();compose.onNodeWithText("修正理由或重新反馈").assertIsNotEnabled();compose.onNodeWithTag("proposal-select-tasks:first").assertIsNotEnabled()}finally{releasePatch.countDown()}
        waitFor("方案修正已保存");field("任务名称","tasks:first").assertTextContains("等待保存的标题")
    }
    @Test fun historyPreservesLineBreaksAndClearedVersionsWhileJobShowsItsOwnFrozenVersion(){
        val job=UUID.randomUUID().toString();screen{TaskProjectFeedbackHistory(repository,base,0,listOf(buildJsonObject{put("userId",user);put("displayName","反馈负责人")}));NativeJobExecution(repository,job)}
        tap("持续反馈版本历史");waitFor("第一行反馈\n第二行反馈");compose.onNodeWithText("已清空持续反馈").assertExists();assertEquals(1,historyReads.get())
        waitFor("本次采用的持续反馈 · v1");tap("本次采用的持续反馈 · v1");compose.onNodeWithText("旧的冻结反馈\n保留冻结换行").assertExists();compose.onNodeWithText("当前新反馈").assertDoesNotExist();assertTrue(writes.isEmpty())
    }
    @Test fun deniedHistoryClearsPreviouslyReadableRecordsAndNeverCreatesReplacementData(){
        screen{TaskProjectFeedbackHistory(repository,base,0,emptyList())};tap("持续反馈版本历史");waitFor("第一行反馈\n第二行反馈")
        denied.set(true);tap("刷新反馈历史");waitFor("无权读取反馈");compose.onNodeWithText("第一行反馈\n第二行反馈").assertDoesNotExist();compose.onNodeWithText("尚无已保存的持续反馈版本").assertDoesNotExist();assertTrue(writes.isEmpty())
    }
    @Test fun projectMemberCanReadSuggestionsButGetsNoProposalMutationControls(){
        screen{TaskWorkspacePlanning(repository,base,buildJsonObject{put("items",JsonArray(emptyList()))},buildJsonObject{put("role","member");put("permissions",buildJsonObject{})},emptyList()) {}}
        waitFor("查看建议");tap("查看建议");compose.onNodeWithText("修正建议、部分应用或重新反馈").assertDoesNotExist();compose.onNodeWithText("请求 AI 建议").assertDoesNotExist();assertTrue(writes.isEmpty())
    }
}

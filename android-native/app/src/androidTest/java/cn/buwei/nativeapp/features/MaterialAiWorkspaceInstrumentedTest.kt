package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.closeSoftKeyboard
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/** Existing backend routes only, served on loopback; no model or production requests. */
class MaterialAiWorkspaceInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private val project="11111111-1111-4111-8111-111111111111"
 private val material="22222222-2222-4222-8222-222222222222"
 private val session="33333333-3333-4333-8333-333333333333"
 private val run="44444444-4444-4444-8444-444444444444"
 private val job="55555555-5555-4555-8555-555555555555"
 private val user="66666666-6666-4666-8666-666666666666"
 private val gets=ConcurrentLinkedQueue<String>()
 private val writes=ConcurrentLinkedQueue<Pair<String,JsonObject>>()
 private val adopted=AtomicReference<JsonObject?>(null)
 @Volatile private var created=false
 @Volatile private var conflict=false
 @Volatile private var missingCursor=false
 private fun objectOf(value:String)=Json.parseToJsonElement(value).jsonObject
 private val originalDoc get()=objectOf("""{"type":"doc","attrs":{"retain":"root"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Original body","marks":[{"type":"bold"}]}]},{"type":"citation","attrs":{"sourceVersionId":"fixed"}},{"type":"futureNode","opaque":{"keep":true}}]}""")
 private fun reply(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 private fun list(items:List<JsonObject> = emptyList())=buildJsonObject{put("items",JsonArray(items));put("nextCursor",JsonNull)}
 private fun target()=buildJsonObject{put("materialId",material);put("title","目标成果材料");put("revision",4);put("kind","document");put("canEdit",true)}
 @Before fun setup(){
  val context=InstrumentationRegistry.getInstrumentation().targetContext;server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val route=request.path.orEmpty().substringBefore('?');val base="/api/v1/projects/$project"
   val account=buildJsonObject{put("id",user);put("displayName","Loopback fixture");put("role","user")}
   if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",account)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
   if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",account)})
   if(request.method=="GET"){gets.add(route);return when(route){
    "/api/v1/capabilities"->reply(buildJsonObject{put("features",buildJsonObject{put("aiEnabled",true)})})
    "$base/agent-sessions"->if(missingCursor)reply(buildJsonObject{put("items",JsonArray(emptyList()))})else reply(list(if(!created)emptyList()else listOf(buildJsonObject{put("sessionId",session);put("capability","guide");put("title","旧摘要状态");put("latestJobId",JsonNull);put("latestRunStatus","succeeded")})))
    "$base/materials"->reply(list(listOf(target())))
    "$base/sources","$base/tasks"->reply(list())
    "$base/materials/$material"->reply(buildJsonObject{put("revision",if(conflict)5 else 4)})
    "$base/agent-sessions/$session"->reply(buildJsonObject{put("sessionId",session);put("capability","guide");put("status","active");put("turns",JsonArray(emptyList()));put("runs",buildJsonArray{add(buildJsonObject{put("runId",run);put("jobId",job);put("status","pending")})})})
    "/api/v1/jobs/$job"->reply(buildJsonObject{put("jobId",job);put("status","running");put("activity",buildJsonObject{put("code","running")});put("execution",buildJsonObject{put("generation",1);put("totalCalls",0)})})
    else->MockResponse().setResponseCode(404).setBody("Unexpected read $route")}}
   val body=objectOf(request.body.readUtf8());writes.add(route to body)
   if(route=="$base/agent-sessions"){created=true;return reply(buildJsonObject{put("sessionId",session);put("runId",run);put("jobId",job)})}
   if(route=="$base/agent-runs/$run/adopt"){adopted.set(body);return reply(buildJsonObject{put("materialVersionId",run);put("revision",5)})}
   return MockResponse().setResponseCode(404).setBody("Unexpected write $route")
  }};server.start();repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"material-ai-${UUID.randomUUID()}-");runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){server.shutdown()}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNode(hasText(text) and hasClickAction()).performScrollTo().performClick()}
 private fun showAdoption(){compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){AgentDraftAdoption(repository,project,run,"succeeded",buildJsonObject{put("doc",originalDoc)},listOf(target())){}}}}}
 private fun chooseTarget(){click("请选择（可留空）");click("目标成果材料")}
 @Test fun incompletePaginationFailsThroughTheNetworkReader(){missingCursor=true;runBlocking{val failure=runCatching{aiAllPages(repository,"/api/v1/projects/$project/agent-sessions?limit=100")}.exceptionOrNull();assertNotNull(failure);assertTrue(failure!!.message.orEmpty().contains("分页位置"))};assertTrue(writes.isEmpty())}
 @Test fun pendingDetailRunSurvivesCompletedListSummary(){compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){MaterialAiWorkspace(repository,project)}}};await("确认发起协作");compose.waitUntil{compose.onAllNodes(hasText("确认发起协作") and isEnabled()).fetchSemanticsNodes().isNotEmpty()};click("确认发起协作");compose.onNodeWithText("确认").performClick();await("提交本轮回答");compose.waitUntil(10000){gets.contains("/api/v1/jobs/$job")};compose.onNode(hasSetTextAction() and hasText("回答 AI 的问题")).performScrollTo().performTextInput("回答仍在等待上一轮完成");closeSoftKeyboard();compose.onNodeWithText("提交本轮回答").assertIsNotEnabled();assertEquals(1,writes.size);assertTrue(gets.contains("/api/v1/projects/$project/agent-sessions/$session"))}
 @Test fun reviewedUneditedRichDraftAdoptsOriginalDocWithoutPlainMarkdown(){showAdoption();await("核对并编辑草稿 Markdown");chooseTarget();compose.onNodeWithText("确认复核并采纳").assertIsNotEnabled();compose.onNode(isToggleable()).performScrollTo().performClick();click("确认复核并采纳");compose.onNodeWithText("确认采纳").performClick();compose.waitUntil(10000){adopted.get()!=null};val body=adopted.get()!!;assertEquals(originalDoc,body["doc"]);assertFalse(body.containsKey("markdown"));assertEquals(4,body["expectedRevision"]!!.jsonPrimitive.int);assertTrue(body.flag("reviewed"));assertEquals(material,body.text("materialId"))}
 @Test fun revisionConflictRetainsEditedTextAndRequiresReviewAgain(){conflict=true;showAdoption();await("核对并编辑草稿 Markdown");chooseTarget();compose.onNode(hasSetTextAction() and hasText("核对并编辑草稿 Markdown")).performScrollTo().performTextReplacement("Edited **body**");closeSoftKeyboard();compose.onNode(isToggleable()).performScrollTo().performClick();click("确认复核并采纳");compose.onNodeWithText("确认采纳").performClick();await("材料版本已变化，请刷新后重新核对再采纳；编辑仍保留，请先核对历史版本并重新复核。");compose.onNode(hasSetTextAction() and hasText("核对并编辑草稿 Markdown")).assertTextContains("Edited **body**");compose.onNode(isToggleable()).assertIsOff();compose.onNodeWithText("确认复核并采纳").assertIsNotEnabled();assertTrue(writes.isEmpty());assertNull(adopted.get())}
}

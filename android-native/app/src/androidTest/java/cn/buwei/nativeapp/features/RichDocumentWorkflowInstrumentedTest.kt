package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/** Real editor interactions, using an account-private loopback repository and unique data per test. */
class RichDocumentWorkflowInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var repository:ClientRepository
    private lateinit var server:MockWebServer
    private val project=UUID.randomUUID().toString()
    private val material=UUID.randomUUID().toString()
    private val account=UUID.randomUUID().toString()
    private val attachment=UUID.randomUUID().toString()
    private val currentVersion=UUID.randomUUID().toString()
    private val path get()="/api/v1/projects/$project/materials/$material"
    private val attempts=ConcurrentLinkedQueue<JsonObject>()
    private val saved=AtomicReference<JsonObject?>(null)
    @Volatile private var conflictOnFirstSave=false
    @Volatile private var serverRevision=1
    private fun objectOf(value:String)=Json.parseToJsonElement(value).jsonObject
    private val originalDoc get()=objectOf("""{"type":"doc","attrs":{"retain":"root-metadata"},"content":[{"type":"paragraph","attrs":{"retain":"paragraph-metadata"},"content":[{"type":"text","text":"Original evidence text","marks":[{"type":"bold"},{"type":"futureMark","attrs":{"keep":true}}],"opaque":{"preserve":1}}]},{"type":"citation","attrs":{"sourceVersionId":"fixed-source-version","locator":"page 3","quote":"Original quote"}},{"type":"futureNode","opaque":{"keep":[1,2,3]}}]}""")
    private fun fixture(revision:Int=1,doc:JsonObject=originalDoc)=buildJsonObject {
        put("materialId",material);put("title","Loopback rich workflow");put("kind","document");put("purpose","output");put("revision",revision);put("canEdit",true)
        put("currentVersion",buildJsonObject {
            put("versionId",currentVersion);put("revision",revision);put("doc",doc)
            put("markdown",if(revision==1)"Original evidence text"else"Server newer text")
            put("attachments",buildJsonArray{add(buildJsonObject{put("fileId",attachment);put("name","Evidence.pdf")})})
        })
    }
    private fun reply(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
    @Before fun setup(){
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val route=request.path.orEmpty().substringBefore('?')
            val user=buildJsonObject{put("id",account);put("displayName","Rich workflow fixture");put("role","user")}
            if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
            if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",user)})
            if(request.method=="GET"&&route==path)return reply(fixture(serverRevision))
            if(request.method=="POST"&&route=="/api/v1/projects/$project/offline-sync") {
                val envelope=objectOf(request.body.readUtf8())
                if(envelope.text("method")!="PUT"||envelope.text("tail")!="materials/$material")return MockResponse().setResponseCode(400).setBody("Unexpected offline mutation")
                val body=envelope["body"]!!.jsonObject;attempts.add(body)
                val expected=body["expectedRevision"]!!.jsonPrimitive.int
                if(conflictOnFirstSave&&expected==1){serverRevision=2;return MockResponse().setResponseCode(409).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"VERSION_CONFLICT","message":"材料已更新"}}""")}
                if(expected!=serverRevision)return MockResponse().setResponseCode(409).setBody("""{"error":{"code":"VERSION_CONFLICT","message":"仍需核对新版本"}}""")
                saved.set(body);serverRevision++;return reply(buildJsonObject{put("revision",serverRevision);put("materialId",material);put("versionId",UUID.randomUUID().toString())})
            }
            return MockResponse().setResponseCode(404).setBody("Unexpected local route: ${request.method} $route")
        }}
        server.start();repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"rich-workflow-${UUID.randomUUID()}-")
        runBlocking{repository.exchange("fixture-code","fixture-verifier")}
    }
    @After fun teardown(){server.shutdown()}
    private fun awaitText(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
    private fun click(text:String){awaitText(text);compose.onNode(hasText(text) and hasClickAction()).performScrollTo().performClick()}
    private fun showEditor(withNavigation:Boolean=false){
        compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()) {
            var present by remember{mutableStateOf(true)};var visit by remember{mutableIntStateOf(0)}
            Column(Modifier.fillMaxSize()){
                if(withNavigation)TextButton(onClick={present=!present;visit++}){Text(if(present)"切换到另一页面"else"返回材料页")}
                Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                    if(present)key(visit){NativeRichMaterialEditor(repository,path,fixture())}else Text("另一页面")
                }
            }
        }}}
    }
    private fun editOriginal(value:String){compose.onNode(hasSetTextAction() and hasText("Original evidence text")).performScrollTo().performTextReplacement(value);closeSoftKeyboard()}
    private fun assertUnchangedMetadata(document:JsonObject){
        assertEquals(originalDoc["attrs"],document["attrs"])
        val before=richChildren(originalDoc);val after=richChildren(document)
        assertEquals(before[0]["attrs"],after[0]["attrs"])
        val originalText=richChildren(before[0]).single();val updatedText=richChildren(after[0]).single()
        assertEquals(originalText["marks"],updatedText["marks"]);assertEquals(originalText["opaque"],updatedText["opaque"])
        assertEquals(before[1],after[1]);assertEquals(before[2],after[2])
    }
    @Test fun temporaryLocalSaveSurvivesLeavingAndRecreatingEditor(){
        showEditor(withNavigation=true);click("编辑正文");editOriginal("Local draft survives leaving")
        click("暂存编辑并返回");awaitText("编辑已保存在当前账户的本机草稿中")
        val persisted=runBlocking{NativeDraftStore(repository).read("material:$path")}
        assertNotNull(persisted);assertTrue(richPlainText(persisted!!.obj("doc")).contains("Local draft survives leaving"));assertEquals(1,persisted["revision"]!!.jsonPrimitive.int)
        compose.onNodeWithText("切换到另一页面").performClick();awaitText("另一页面");compose.onNodeWithText("返回材料页").performClick();awaitText("找到本机材料草稿")
        compose.onNodeWithText("编辑正文").assertIsNotEnabled();click("恢复本机编辑")
        compose.onNode(hasSetTextAction() and hasText("Local draft survives leaving")).assertExists()
        click("保存新版本");awaitText("已保存新版本");compose.waitUntil(10000){saved.get()!=null}
        assertEquals(1,saved.get()!!["expectedRevision"]!!.jsonPrimitive.int);assertUnchangedMetadata(saved.get()!!.obj("doc"))
        assertNull(runBlocking{NativeDraftStore(repository).read("material:$path")})
    }
    @Test fun conflictKeepsEditedTextUntilExplicitReviewAndSavesAgainstNewRevision(){
        conflictOnFirstSave=true;showEditor();click("编辑正文");editOriginal("Human edited evidence stays intact")
        click("保存新版本");awaitText("服务端版本已变化");awaitText("Server newer text")
        compose.onNode(hasSetTextAction() and hasText("Human edited evidence stays intact")).assertExists()
        compose.onNodeWithText("保存新版本").assertIsNotEnabled();assertEquals(1,attempts.size);assertNull(saved.get())
        val preserved=runBlocking{NativeDraftStore(repository).read("material:$path")}
        assertTrue(richPlainText(preserved!!.obj("doc")).contains("Human edited evidence stays intact"));assertEquals(1,preserved["revision"]!!.jsonPrimitive.int)
        click("已核对，保留本机编辑继续");awaitText("编辑版本 2");click("保存新版本")
        // A failed durable operation must be explicitly superseded by the production editor;
        // this test must not discard queue entries to manufacture a successful workflow.
        compose.waitUntil(15000){saved.get()!=null}
        assertEquals(listOf(1,2),attempts.map{it["expectedRevision"]!!.jsonPrimitive.int})
        val body=saved.get()!!;assertTrue(richPlainText(body.obj("doc")).contains("Human edited evidence stays intact"));assertUnchangedMetadata(body.obj("doc"));assertEquals(JsonArray(listOf(JsonPrimitive(attachment))),body["attachmentIds"])
        assertTrue(runBlocking{repository.pending()}.isEmpty())
    }
    @Test fun actualTableInsertionAndRowActionPreserveUnknownNodesMarksAndAttachments(){
        showEditor();click("编辑正文");click("插入内容块")
        compose.onNodeWithText("3 × 3 表格").performClick();click("添加表格行");click("保存新版本")
        compose.waitUntil(15000){saved.get()!=null};val body=saved.get()!!;val document=body.obj("doc")
        assertUnchangedMetadata(document);val table=richChildren(document).last();assertEquals("table",table.text("type"));assertEquals(4,richChildren(table).size);richChildren(table).forEach{assertEquals(3,richChildren(it).size)}
        assertEquals(JsonArray(listOf(JsonPrimitive(attachment))),body["attachmentIds"]);assertFalse(body.containsKey("markdown"))
        assertEquals(1,attempts.size)
    }
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.NativeDestination
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class DataReadAccessInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var repository:ClientRepository
 private lateinit var server:MockWebServer
 private val project=UUID.randomUUID().toString();private val resource=UUID.randomUUID().toString();private val version=UUID.randomUUID().toString()
 @Volatile private var failAt=""
 @Volatile private var status=403
 private fun response(body:String)=MockResponse().setHeader("Content-Type","application/json").setBody("{\"data\":$body}")
 @Before fun setup(){
  val user=UUID.randomUUID().toString()
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val path=request.requestUrl!!.encodedPath
   if(path=="/api/v1/auth/native/exchange")return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie","ai_office_session=fixture")
   val area=when{
    path.contains("/resource-index/") && path.endsWith("/section")->"section"
    path.contains("/resource-index/")->"index"
    path.endsWith("/resource-library")->"list"
    path.contains("/resource-library/")->"resource"
    path.endsWith("/processing")->"processing"
    path.contains("/versions/")->"sourceVersion"
    path.contains("/materials/")->"material"
    path.contains("/sources/")->"source"
    else->"other"
   }
   if(area==failAt)return MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"FORBIDDEN","message":"Access unavailable"}}""")
   return when(area){
    "index"->response("""{"indexStatus":"ready","coverage":"complete","items":[{"sectionId":"$version","heading":"Restricted section"}]}""")
    "section"->response("""{"text":"Secret original body","fragments":[]}""")
    "list"->response("""{"items":[{"title":"Previously readable row"}],"nextCursor":"next"}""")
    "resource"->response("""{"resourceId":"$resource","title":"Private resource title","purpose":"output"}""")
    "material"->response("""{"materialId":"$resource","revision":1,"currentVersion":{"versionId":"$version","revision":1,"markdown":"Previously readable material","attachments":[]}}""")
    "source"->response("""{"sourceId":"$resource","kind":"paste","currentVersionId":"$version"}""")
    "processing"->response("""{"textStatus":"ready","requirementsStatus":"ready","summaryStatus":"ready","summaryRevision":0}""")
    "sourceVersion"->response("""{"sourceVersionId":"$version","revision":1,"status":"ready","charCount":12345}""")
    else->response("""{"items":[],"nextCursor":null}""")
   }
  }};server.start();repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"access-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){server.shutdown()}
 private fun await(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){compose.onNodeWithText(text).performScrollTo().performClick()}
 @Test fun deniedNextPageClearsEarlierRowsAndCursorAndAllowsExplicitRecovery(){
  compose.setContent{NativeTheme{Surface{Column{TaskWorkspacePage(repository,"/api/v1/projects/$project/resource-library"){rows->rows.forEach{Text(it.twText("title"))}}}}}}
  await("Previously readable row");failAt="list";compose.onNodeWithText("加载更多").performClick()
  await("重试读取");compose.onNodeWithText("Previously readable row").assertDoesNotExist();compose.onNodeWithText("加载更多").assertDoesNotExist()
  failAt="";compose.onNodeWithText("重试读取").performClick();await("Previously readable row")
 }
 @Test fun transientServerFailureRetainsRowsWithExplicitStaleNotice(){
  compose.setContent{NativeTheme{Surface{Column{TaskWorkspacePage(repository,"/api/v1/projects/$project/resource-library"){rows->rows.forEach{Text(it.twText("title"))}}}}}}
  await("Previously readable row");failAt="list";status=500;compose.onNodeWithText("加载更多").performClick();await("重试读取")
  compose.onNodeWithText("Previously readable row").assertExists()
  compose.onNode(hasText("当前显示上次读取内容",substring=true)).assertExists()
 }
 @Test fun deniedResourceRefreshDisposesPreviouslyReadableMaterialAndActions(){
  compose.setContent{NativeTheme{Surface{DataWorkspace(repository,project,NativeDestination("data",project,resource,"material"))}}}
  await("Previously readable material");failAt="resource";click("刷新当前资料")
  compose.waitUntil(10000){compose.onAllNodesWithText("Private resource title").fetchSemanticsNodes().isEmpty()}
  compose.onNodeWithText("Previously readable material").assertDoesNotExist();compose.onNodeWithText("AI 补位与成果采纳").assertDoesNotExist()
 }
 @Test fun deniedMaterialReadClearsCanonicalBodyWhileResourceMetadataRemainsAuthorized(){
  compose.setContent{NativeTheme{Surface{DataWorkspace(repository,project,NativeDestination("data",project,resource,"material"))}}}
  await("Previously readable material");failAt="material";status=404;click("刷新当前资料")
  compose.waitUntil(10000){compose.onAllNodesWithText("Previously readable material").fetchSemanticsNodes().isEmpty()}
  compose.onNodeWithText("Private resource title").assertExists();compose.onNodeWithText("历史版本与比较").assertDoesNotExist()
 }
 @Test fun deniedSourceVersionClearsPriorVersionAndItsProcessingControls(){
  compose.setContent{NativeTheme{Surface{DataWorkspace(repository,project,NativeDestination("data",project,resource,"source"))}}}
  await("原文版本 1 · 已完成 · 无固定页数 · 12345 字符");failAt="sourceVersion";click("刷新当前资料")
  compose.waitUntil(10000){compose.onAllNodesWithText("原文版本 1 · 已完成 · 无固定页数 · 12345 字符").fetchSemanticsNodes().isEmpty()}
  compose.onNodeWithText("来源类型：粘贴文本").assertDoesNotExist()
 }
 @Test fun deniedIndexRefreshClearsPriorDirectoryAndOpenedOriginal(){
  compose.setContent{NativeTheme{Surface{Column(Modifier.verticalScroll(rememberScrollState())){DataWorkspaceReference(repository,project,"source",version,initiallyOpen=true)}}}}
  await("Restricted section");click("Restricted section");await("Secret original body")
  failAt="index";click("刷新目录状态")
  compose.waitUntil(10000){compose.onAllNodesWithText("Secret original body").fetchSemanticsNodes().isEmpty()}
  compose.onNodeWithText("Restricted section").assertDoesNotExist()
 }

}

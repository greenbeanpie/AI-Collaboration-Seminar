package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.style.TextDecoration
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeDestination
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.io.File
import android.graphics.Bitmap
import java.util.concurrent.atomic.AtomicReference

/** Exercise the dedicated data page, rather than only the generic JSON renderer. */
class DataDocumentParityInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private val project=UUID.randomUUID().toString()
 private val material=UUID.randomUUID().toString()
 private val current=UUID.randomUUID().toString()
 private val historic=UUID.randomUUID().toString()
 private val base get()="/api/v1/projects/$project"
 @Volatile private var formatComparison=false
 private val destination=AtomicReference<String?>(null)
 private fun doc(text:String)=Json.parseToJsonElement("""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"$text","marks":[{"type":"underline"}]}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"$text table"}]}]}]}]},{"type":"paragraph","content":[{"type":"text","text":"Account","marks":[{"type":"link","attrs":{"href":"/app/profile"}}]}]}]}""").jsonObject
 private fun version(id:String,revision:Int,text:String)=buildJsonObject {put("versionId",id);put("revision",revision);put("doc",if(formatComparison){val document=doc("Same readable document");if(revision==2)Json.parseToJsonElement(document.toString().replace("\"underline\"","\"bold\""))else document}else doc(text));put("markdown",if(formatComparison)"same lossy export"else"lossy markdown $revision");put("attachments",buildJsonArray{})}
 private fun response(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 @Before fun setup(){
  val account=UUID.randomUUID().toString()
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val path=request.requestUrl!!.encodedPath
   val user=buildJsonObject{put("id",account);put("role","user")}
   return when(path){
    "/api/v1/auth/native/exchange"->response(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
    "/api/v1/auth/session"->response(buildJsonObject{put("user",user)})
    "$base/resource-library/material/$material"->response(buildJsonObject{put("resourceId",material);put("title","Fixture material");put("purpose","output")})
    "$base/materials/$material"->response(buildJsonObject{put("materialId",material);put("revision",2);put("currentVersion",version(current,2,"Current canonical"))})
    "$base/materials/$material/versions"->response(buildJsonObject{put("items",buildJsonArray{if(formatComparison)add(version(current,2,"Current canonical"));add(version(historic,1,"Historic canonical"))});put("nextCursor",JsonNull)})
    "$base/materials/$material/versions/$current"->response(version(current,2,"Current canonical"))
    "$base/materials/$material/versions/$historic"->response(version(historic,1,"Historic canonical"))
    "$base/comments"->response(buildJsonObject{put("items",buildJsonArray{});put("nextCursor",JsonNull)})
    else->MockResponse().setResponseCode(404).setBody("Unexpected loopback request $path")
   }
  }};server.start()
  repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"data-doc-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture-code","fixture-verifier")}
 }
 @After fun teardown(){server.shutdown()}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun capture(name:String){
  // Some emulator graphics drivers crash the shell screenshot connection; capture is explicit.
  if(InstrumentationRegistry.getArguments().getString("captureCanonical")!="true")return
  val context=InstrumentationRegistry.getInstrumentation().targetContext
  val bitmap=requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
  try{File(context.getExternalFilesDir(null),"data-parity-$name.png").outputStream().use{check(bitmap.compress(Bitmap.CompressFormat.PNG,100,it))}}finally{bitmap.recycle()}
 }
 private fun clickLink(){val node=compose.onNodeWithText("Account（/app/profile）");node.performScrollTo();val layouts=mutableListOf<TextLayoutResult>();node.performSemanticsAction(SemanticsActions.GetTextLayoutResult){assertTrue(it(layouts))};node.performTouchInput{click(layouts.single().getBoundingBox(0).center)};compose.runOnIdle{assertEquals("/app/profile",destination.get())}}
 @Test fun currentMaterialUsesCanonicalTableAndMarksAndNativeLink(){
  compose.setContent{NativeTheme{Surface{CompositionLocalProvider(LocalNativeContentNavigation provides {destination.set(it)}){DataWorkspace(repository,project,NativeDestination("data",project,material,"material"))}}}}
  await("Current canonical")
  val text=compose.onNodeWithText("Current canonical").fetchSemanticsNode().config[SemanticsProperties.Text].single()
  assertTrue(text.spanStyles.any{it.item.textDecoration==TextDecoration.Underline})
  compose.onNodeWithText("Current canonical table").performScrollTo().assertIsDisplayed();capture("current")
  compose.onNodeWithText("lossy markdown 2").assertDoesNotExist();clickLink()
 }
 @Test fun historicVersionUsesItsOwnCanonicalDocumentAndNativeLink(){
  compose.setContent{NativeTheme{Surface{CompositionLocalProvider(LocalNativeContentNavigation provides {destination.set(it)}){Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceVersions(repository,project,buildJsonObject{put("materialId",material)})}}}}}
  compose.onNodeWithText("历史版本与比较").performClick();await("Historic canonical")
  compose.onNodeWithText("Historic canonical table").performScrollTo().assertIsDisplayed();capture("historic")
  compose.onNodeWithText("Current canonical").assertDoesNotExist();compose.onNodeWithText("lossy markdown 1").assertDoesNotExist();clickLink()
 }
 @Test fun historicComparisonAnnouncesRichFormattingChangesWhenMarkdownMatches(){
  formatComparison=true
  compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceVersions(repository,project,buildJsonObject{put("materialId",material)})}}}}
  compose.onNodeWithText("历史版本与比较").performClick();await("两个版本可读正文相同；富文档结构或格式有变化。")
  compose.onNodeWithText("两个版本可读正文相同；富文档结构或格式有变化。").performScrollTo().assertIsDisplayed()
  compose.onNodeWithText("两个版本正文相同").assertDoesNotExist()
 }
 @Test fun missingCanonicalDocumentRetainsLegacyMarkdown(){
  compose.setContent{NativeTheme{Surface{DataWorkspaceVersionContent(buildJsonObject{put("markdown","Legacy readable body")})}}}
  compose.onNodeWithText("Legacy readable body").assertIsDisplayed()
 }
 @Test fun validEmptyCanonicalDocumentDoesNotResurrectOldMarkdown(){
  compose.setContent{NativeTheme{Surface{DataWorkspaceVersionContent(buildJsonObject{put("doc",buildJsonObject{put("type","doc");put("content",buildJsonArray{})});put("markdown","Obsolete deleted text")})}}}
  compose.onNodeWithText("Obsolete deleted text").assertDoesNotExist()
 }
}

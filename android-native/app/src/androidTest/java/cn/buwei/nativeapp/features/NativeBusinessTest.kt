package cn.buwei.nativeapp.features

import android.content.Context
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.closeSoftKeyboard
import cn.buwei.nativeapp.data.ClientRepository
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
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.ConcurrentLinkedQueue

/** Deterministic loopback fixtures; these tests never send requests to production. */
class NativeBusinessTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var context:Context
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private val project="11111111-1111-4111-8111-111111111111"
 private val task="22222222-2222-4222-8222-222222222222"
 private val material="33333333-3333-4333-8333-333333333333"
 private val draftId="44444444-4444-4444-8444-444444444444"
 private val userId="55555555-5555-4555-8555-555555555555"
 private val user get()=buildJsonObject{put("id",userId);put("username","native-fixture");put("displayName","Native fixture");put("isAdmin",false);put("role","user")}
 private val received=AtomicReference<JsonObject?>(null)
 private val observedRequests=ConcurrentLinkedQueue<String>()
 private var payload=buildJsonObject{put("name","Fixture project");put("aiCollaborationEnabled",false)}
 private var preview=false
 @Volatile private var sent=false
 @Volatile private var jobDone=false
 private fun envelope(data:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data);put("requestId","native-test")}.toString())
 private fun emptyList()=buildJsonObject{put("items",JsonArray(kotlin.collections.emptyList()));put("nextCursor",JsonNull)}
 private fun projectFixture()=buildJsonObject{put("id",project);put("name","Fixture project");put("description","Local test data");put("status","active");put("revision",1);put("myRole","owner");put("permissions",buildJsonObject{listOf("teamManage","taskManage","resourceManage","scoreInitiate","scoreCorrect").forEach{put(it,true)}})}
 private fun taskFixture()=buildJsonObject{put("taskId",task);put("title","Fixture task");put("detail","Task detail fixture");put("status","todo");put("revision",1);put("criteria","fixture criteria");put("dependsOnTaskIds",JsonArray(kotlin.collections.emptyList()))}
 private fun richDoc()=Json.parseToJsonElement("""{"type":"doc","attrs":{"retain":"root"},"content":[{"type":"paragraph","attrs":{"retain":"block"},"content":[{"type":"text","text":"body before","marks":[{"type":"bold"}]}]},{"type":"citation","attrs":{"sourceVersionId":"fixed-version","locator":"p3"}},{"type":"futureNode","payload":{"keep":true}}]}""").jsonObject
 private fun materialFixture()=buildJsonObject{put("materialId",material);put("title","Fixture material");put("kind","document");put("revision",1);put("canEdit",true);put("currentVersion",buildJsonObject{put("versionId","fixed-version");put("doc",richDoc());put("markdown","body before");put("attachments",JsonArray(kotlin.collections.emptyList()))})}
 private fun draftFixture()=buildJsonObject{put("id",draftId);put("revision",if(preview)2 else 1);put("status","active");put("payload",payload);put("previewState",if(preview)"ready"else"idle");put("preview",if(preview)buildJsonObject{put("mode","manual");put("tasks",JsonArray(kotlin.collections.emptyList()))}else JsonNull)}

 @Before fun setup(){
  context=InstrumentationRegistry.getInstrumentation().targetContext
  server=MockWebServer()
  server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val route=request.path.orEmpty().substringBefore('?');val method=request.method.orEmpty()
   observedRequests.add("$method $route")
   if(route=="/api/v1/auth/native/exchange")return envelope(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly; SameSite=Strict")
   if(route=="/api/v1/auth/session")return envelope(buildJsonObject{put("user",user)})
   if(method=="GET"&&route=="/api/v1/projects")return envelope(buildJsonObject{put("items",buildJsonArray{add(projectFixture())});put("nextCursor",JsonNull)})
   if(method=="GET"&&route=="/api/v1/projects/$project")return envelope(projectFixture())
   if(method=="GET"&&route=="/api/v1/projects/$project/tasks")return envelope(buildJsonObject{put("items",buildJsonArray{add(taskFixture())});put("nextCursor",JsonNull)})
   if(method=="GET"&&route=="/api/v1/projects/$project/tasks/$task")return envelope(taskFixture())
   if(method=="GET"&&route=="/api/v1/projects/$project/materials")return envelope(buildJsonObject{put("items",buildJsonArray{add(materialFixture())});put("nextCursor",JsonNull)})
   if(method=="GET"&&route=="/api/v1/projects/$project/materials/$material")return envelope(materialFixture())
   if(method=="POST"&&route=="/api/v1/projects/$project/offline-sync"){
    received.set(Json.parseToJsonElement(request.body.readUtf8()).jsonObject)
    return envelope(JsonObject(materialFixture()+("revision" to JsonPrimitive(2))))
   }
   if(method=="GET"&&route in listOf("/api/v1/creation-drafts","/api/v1/project-templates"))return envelope(emptyList())
   if(method=="POST"&&route=="/api/v1/creation-drafts"){payload=Json.parseToJsonElement(request.body.readUtf8()).jsonObject;return envelope(draftFixture())}
   if(method=="GET"&&route=="/api/v1/creation-drafts/$draftId")return envelope(draftFixture())
   if(method=="POST"&&route=="/api/v1/creation-drafts/$draftId/preview"){preview=true;return envelope(draftFixture())}
   if(method=="POST"&&route=="/api/v1/creation-drafts/$draftId/commit")return envelope(buildJsonObject{put("projectId",project);put("invitations",JsonArray(kotlin.collections.emptyList()))})
   if(route=="/api/v1/projects/$project/ai-chat"){
    if(method=="POST"){sent=true;return envelope(buildJsonObject{put("questionId",task);put("jobId",draftId)})}
    if(method=="DELETE"){sent=false;jobDone=false;return envelope(buildJsonObject{put("cleared",true)})}
    return envelope(buildJsonObject{put("items",buildJsonArray{if(sent){add(buildJsonObject{put("id","q1");put("questionId",task);put("role","user");put("content","Explain fixture");put("createdAt","2026-10-19T00:00:00Z");put("jobId",draftId)});if(jobDone)add(buildJsonObject{put("id","a1");put("questionId",task);put("role","assistant");put("content","## Fixture answer\nNative response");put("createdAt","2026-10-19T00:00:01Z");put("jobId",draftId)})}});put("nextCursor",JsonNull);put("pendingJobId",if(sent&&!jobDone)JsonPrimitive(draftId)else JsonNull)})
   }
   if(route=="/api/v1/jobs/$draftId"){jobDone=true;return envelope(buildJsonObject{put("jobId",draftId);put("status","succeeded");put("activity",buildJsonObject{put("code","executing_tool");put("progress",buildJsonObject{put("completed",3);put("unit","tool_call")})});put("execution",buildJsonObject{put("totalCalls",1);put("state","completed");put("generation",1)})})}
   if(route.endsWith("/operations"))return envelope(emptyList())
   return MockResponse().setResponseCode(404).setBody("Unexpected fixture route: $method $route")
  }}
  server.start()
  repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"ui-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture-code","fixture-verifier")}
 }
 @After fun teardown(){server.shutdown()}
 private fun awaitText(text:String){try{compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}catch(e:Throwable){runCatching{screenshot("failure-${text.hashCode()}")};throw AssertionError("Expected text: $text\nRequests: ${observedRequests.joinToString()}\n${compose.onRoot().printToString()}",e)}}
 private fun screenshot(name:String){val image=compose.onRoot().captureToImage().asAndroidBitmap();val directory=File(context.getExternalFilesDir(null),"native-ui-fixtures").apply{mkdirs()};val target=File(directory,"$name.png");target.outputStream().use{image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};assertTrue(target.length()>0)}

 @Test fun projectListOpensSelectedProject(){
  assertEquals(listOf("projectId","taskId"),pathParameterNames("/api/v1/projects/{projectId}/tasks/{taskId}"))
  val selected=AtomicReference<String?>(null)
  compose.setContent{cn.buwei.nativeapp.NativeTheme{Surface(Modifier.fillMaxSize()){FeatureScreen(repository,"projects",null,{selected.set(it)},{})}}}
  awaitText("Fixture project");compose.onNodeWithText("打开项目").performScrollTo().performClick()
  compose.waitUntil{selected.get()==project};screenshot("projects")
 }
 @Test fun taskListLoadsNativeDetail(){
  compose.setContent{cn.buwei.nativeapp.NativeTheme{Surface(Modifier.fillMaxSize()){FeatureScreen(repository,"tasks",project,{},{})}}}
  awaitText("Fixture task");compose.onNodeWithText("查看详情").performScrollTo().performClick()
  awaitText("任务内容：Task detail fixture");screenshot("task-detail")
 }
 @Test fun richEditorSavesTextAndRetainsReferencesAndMarks(){
  compose.setContent{cn.buwei.nativeapp.NativeTheme{Surface(Modifier.fillMaxSize()){FeatureScreen(repository,"data",project,{},{})}}}
  compose.onNodeWithText("成果材料").performScrollTo().performClick();awaitText("Fixture material")
  compose.onNodeWithText("查看详情").performScrollTo().performClick();awaitText("编辑正文")
  compose.onNodeWithText("编辑正文").performScrollTo().performClick();compose.onNode(hasText("body before") and hasSetTextAction()).performScrollTo().performTextReplacement("body after");closeSoftKeyboard()
  screenshot("rich-editor");compose.onNodeWithText("保存新版本").performScrollTo().performClick()
  compose.waitUntil(15000){received.get()!=null}
  val save=received.get()!!.obj("body");assertEquals(richDoc().toString().replace("body before","body after"),save.obj("doc").toString());assertFalse(save.containsKey("markdown"));assertEquals(1,save["expectedRevision"]!!.jsonPrimitive.int)
  awaitText("已保存新版本")
 }
 @Test fun creationDraftPreviewsThenCommitsOnlyAfterConfirmation(){
  val selected=AtomicReference<String?>(null)
  compose.setContent{cn.buwei.nativeapp.NativeTheme{Surface(Modifier.fillMaxSize()){ProjectCreationScreen(repository){selected.set(it)}}}}
  compose.onNodeWithText("名称 *").performScrollTo().performTextInput("Fixture project");closeSoftKeyboard()
  compose.onNodeWithText("保存创建草稿").performScrollTo().performClick();compose.onNodeWithText("确认").performClick()
  awaitText("生成手动预览");compose.onNodeWithText("生成手动预览").performScrollTo().performClick();compose.onNodeWithText("确认").performClick()
  awaitText("确认预览并创建项目");compose.onNodeWithText("确认预览并创建项目").performScrollTo().performClick();compose.onNodeWithText("确认").performClick()
  awaitText("项目已创建");screenshot("creation-committed");compose.onNodeWithText("进入项目").performScrollTo().performClick();compose.waitUntil{selected.get()==project}
 }
 @Test fun conversationSendsPollsAndDisplaysNativeAnswer(){
  compose.setContent{cn.buwei.nativeapp.NativeTheme{Surface(Modifier.fillMaxSize()){AiConversationScreen(repository,project)}}}
  compose.onNodeWithText("询问项目 AI").performTextInput("Explain fixture");closeSoftKeyboard();compose.onNodeWithText("发送").performClick()
  awaitText("Fixture answer");compose.onNodeWithText("Native response").performScrollTo().assertIsDisplayed();screenshot("ai-conversation")
 }
}

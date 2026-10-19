package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import cn.buwei.nativeapp.data.requestDurably
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.platform.app.InstrumentationRegistry
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
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

class MaterialDiscussionInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private val project=UUID.randomUUID().toString()
 private val material=UUID.randomUUID().toString()
 private val account=UUID.randomUUID().toString()
 @Volatile private var activeAccount=""
 private val alternate=UUID.randomUUID().toString()
 private val comment=UUID.randomUUID().toString()
 private val path get()="/api/v1/projects/$project/comments"
 private val draftKey get()="material-comment:$account:$project:$material"
 private val writes=ConcurrentLinkedQueue<JsonObject>()
 private val queries=ConcurrentLinkedQueue<String>()
 private val reads=AtomicInteger()
 @Volatile private var denyRead=false
 @Volatile private var denyWrite=false
 @Volatile private var failWrite=false
 @Volatile private var paginate=false
 @Volatile private var repeatCursor=false
 private fun record(id:String,text:String)=buildJsonObject{put("commentId",id);put("targetType","material");put("targetId",material);put("authorId",account);put("authorName","Member");put("body",text);put("createdAt","2026-10-19T12:00:00Z")}
 private fun reply(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 private fun failure(status:Int)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"FIXTURE_DENIED","message":"Fixture access failure $status"}}""")
 @Before fun setup(){
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val url=request.requestUrl!!;val route=url.encodedPath
   val user=buildJsonObject{put("id",activeAccount.ifBlank{account});put("role","user")}
   if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
   if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",user)})
   if(route==path&&request.method=="GET"){
    queries.add(request.path!!);reads.incrementAndGet();if(denyRead)return failure(403)
    val next=url.queryParameter("cursor");val target=url.queryParameter("targetId")
    return reply(buildJsonObject{put("items",buildJsonArray{if(target==material)add(record(if(next==null)comment else "second-comment",if(next==null)"First material discussion"else"Later material discussion"))});put("nextCursor",if(paginate&&(next==null||repeatCursor))JsonPrimitive("cursor with +/?")else JsonNull)})
   }
   if(route=="/api/v1/projects/$project/offline-sync"&&request.method=="POST"){
    val envelope=Json.parseToJsonElement(request.body.readUtf8()).jsonObject
    if(envelope.twText("tail")!="comments"||envelope.twText("method")!="POST")return failure(400)
    val body=envelope.obj("body");writes.add(body)
    if(denyWrite)return failure(403);if(failWrite)return failure(500)
    return reply(record(UUID.randomUUID().toString(),body.twText("body")))
   }
   return failure(404)
  }};server.start()
  repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"material-comments-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture","verifier")}
 }
 @After fun teardown(){server.shutdown()}
 private fun show(switchable:Boolean=false){compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){
  var present by remember{mutableStateOf(true)};var target by remember{mutableStateOf(material)}
  if(switchable){TextButton({present=!present}){Text(if(present)"Leave discussion"else"Return discussion")};TextButton({target=if(target==material)alternate else material}){Text("Switch material")}}
  if(present)MaterialDiscussionWorkspace(repository,project,target)
 }}}}}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNodeWithText(text).performScrollTo().performClick()}
 private fun enter(value:String){await("First material discussion");compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement(value);closeSoftKeyboard()}
 @Test fun existingCommentsReadAndWriteUseMaterialTargetAndClearSuccessfulDraft(){
  show();enter("  A new material comment  ")
  assertTrue(repository.secrets.get(draftKey)!!.contains("A new material comment"))
  click("发送材料评论");await("材料评论已发送。")
  assertEquals(1,writes.size);assertEquals("material",writes.single().twText("targetType"));assertEquals(material,writes.single().twText("targetId"));assertEquals("A new material comment",writes.single().twText("body"))
  assertNull(repository.secrets.get(draftKey));compose.onNodeWithText("A new material comment").performScrollTo().assertIsDisplayed()
  assertTrue(queries.all{it.contains("targetType=material")&&it.contains("targetId=$material")})
 }
 @Test fun localDraftSurvivesLeavingAndDoesNotBleedIntoOtherMaterial(){
  show(true);enter("Private unsent material draft");click("Leave discussion");click("Return discussion");await("已恢复本机材料讨论草稿，尚未发送。")
  compose.onNode(hasSetTextAction()).assertTextContains("Private unsent material draft")
  click("Switch material");compose.waitUntil(10000){queries.any{it.contains("targetId=$alternate")}}
  assertEquals("",compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text);compose.onNodeWithText("Private unsent material draft").assertDoesNotExist()
  click("Switch material");await("已恢复本机材料讨论草稿，尚未发送。");compose.onNode(hasSetTextAction()).assertTextContains("Private unsent material draft");assertTrue(writes.isEmpty())
 }
 @Test fun subsequentPageUsesEncodedServerCursorAndRetainsBothPages(){
  paginate=true;show();await("First material discussion");click("加载更多材料评论");await("Later material discussion")
  assertTrue(queries.last().contains("cursor=cursor%20with%20%2B%2F%3F"));compose.onNodeWithText("First material discussion").assertExists();compose.onNodeWithText("加载更多材料评论").assertDoesNotExist()
 }
 @Test fun repeatedPaginationCursorStopsWithoutAppendingDuplicateRecords(){
  paginate=true;repeatCursor=true;show();await("First material discussion");click("加载更多材料评论");await("讨论分页未前进，请刷新重新读取")
  compose.onNodeWithText("Later material discussion").assertDoesNotExist();compose.onNodeWithText("First material discussion").assertExists()
 }
 @Test fun deniedRefreshClearsServerRecordsDisablesSendAndPreservesLocalDraft(){
  show();enter("Preserve this draft after revocation");denyRead=true;click("刷新材料讨论");await("当前无法访问这份材料的讨论；已清除服务端记录，未发送草稿保留。")
  compose.onNodeWithText("First material discussion").assertDoesNotExist();compose.onNodeWithText("发送材料评论").assertIsNotEnabled();compose.onNode(hasSetTextAction()).assertTextContains("Preserve this draft after revocation");assertTrue(writes.isEmpty());assertTrue(repository.secrets.get(draftKey)!!.contains("Preserve this draft"))
 }
 @Test fun failedSendRetainsDraftAndExistingOperationWithoutAutomaticSecondWrite(){
  failWrite=true;show();enter("Keep failed material comment");click("发送材料评论");await("发送结果尚未确认；已保留同步记录和草稿，请在同步中心核对，避免重复发送。")
  assertEquals(1,writes.size);assertTrue(repository.secrets.get(draftKey)!!.contains("Keep failed material comment"));assertTrue(runBlocking{repository.pending()}.isNotEmpty())
  compose.onNodeWithText("发送材料评论").assertIsNotEnabled();click("刷新材料讨论");await("此评论已保存为待同步记录，请在同步中心核对；不会再次创建。");assertEquals(1,writes.size)
 }
 @Test fun accountChangeCannotRestoreAnotherAccountsDraft(){
  show();enter("Only first account draft")
  activeAccount=UUID.randomUUID().toString();runBlocking{repository.exchange("second-account","verifier")}
  compose.waitUntil(10000){compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().singleOrNull()?.config?.get(SemanticsProperties.EditableText)?.text==""}
  compose.onNodeWithText("Only first account draft").assertDoesNotExist();assertTrue(repository.secrets.get(draftKey)!!.contains("Only first account draft"));assertNull(repository.secrets.get("material-comment:$activeAccount:$project:$material"));assertTrue(writes.isEmpty())
 }
 @Test fun queuedCommentKeepsDraftAndDoesNotClaimSentOrCreateAnotherWrite(){
  denyWrite=true
  runBlocking{runCatching{repository.requestDurably("fixture-blocked-comment","POST",path,buildJsonObject{put("targetType","material");put("targetId",alternate);put("body","Earlier blocked comment")})}}
  assertEquals(1,writes.size);denyWrite=false
  show();enter("Queued material comment");click("发送材料评论");await("此评论已保存为待同步记录，尚未确认发送成功；请在同步中心核对。")
  assertEquals(1,writes.size);assertTrue(repository.secrets.get(draftKey)!!.contains("Queued material comment"));compose.onNodeWithText("材料评论已发送。").assertDoesNotExist();compose.onNodeWithText("发送材料评论").assertIsNotEnabled()
  assertEquals(2,runBlocking{repository.pending()}.size)
 }
 @Test fun inputAcceptsFourThousandCharactersAndRejectsLongerReplacement(){
  show();enter("x".repeat(4000));compose.onNode(hasSetTextAction()).assertTextContains("x".repeat(4000));assertTrue(repository.secrets.get(draftKey)!!.contains("x".repeat(4000)))
  compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement("y".repeat(4001));closeSoftKeyboard();compose.onNode(hasSetTextAction()).assertTextContains("x".repeat(4000));assertTrue(writes.isEmpty())
 }
}

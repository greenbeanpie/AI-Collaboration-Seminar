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

class TaskDiscussionInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private val project=UUID.randomUUID().toString()
 private val task=UUID.randomUUID().toString()
 private val account=UUID.randomUUID().toString()
 @Volatile private var activeAccount=""
 private val alternate=UUID.randomUUID().toString()
 private val comment=UUID.randomUUID().toString()
 private val path get()="/api/v1/projects/$project/comments"
 private val draftKey get()="task-comment:$account:$project:$task"
 private val writes=ConcurrentLinkedQueue<JsonObject>()
 private val queries=ConcurrentLinkedQueue<String>()
 private val reads=AtomicInteger()
 @Volatile private var denyRead=false
 @Volatile private var denyWrite=false
 @Volatile private var failWrite=false
 @Volatile private var paginate=false
 @Volatile private var repeatCursor=false
 private fun record(id:String,text:String)=buildJsonObject{put("commentId",id);put("targetType","task");put("targetId",task);put("authorId",account);put("authorName","Member");put("body",text);put("createdAt","2026-10-19T12:00:00Z")}
 private fun reply(value:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 private fun failure(status:Int)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"FIXTURE_DENIED","message":"Fixture access failure $status"}}""")
 @Before fun setup(){
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val url=request.requestUrl!!;val route=url.encodedPath
   val user=buildJsonObject{put("id",activeAccount.ifBlank{account});put("role","user")}
   if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
   if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",user)})
   if(request.method=="GET"){
    if(route=="/api/v1/projects/$project/members/me")return reply(buildJsonObject{put("userId",account);put("role","member");put("permissions",buildJsonObject{})})
    if(route=="/api/v1/projects/$project/tasks/graph")return reply(buildJsonObject{put("graphRevision",1);put("items",buildJsonArray{})})
    if(route=="/api/v1/projects/$project/members")return reply(buildJsonObject{put("items",buildJsonArray{});put("nextCursor",JsonNull)})
    if(route=="/api/v1/projects/$project/tasks/$task")return reply(buildJsonObject{put("taskId",task);put("revision",1);put("title","Task discussion fixture");put("detail","Task details");put("criteria","Verify comments");put("status","todo");put("lifecycleState","open");put("effortHours",1)})
   }
   if(route==path&&request.method=="GET"){
    queries.add(request.path!!);reads.incrementAndGet();if(denyRead)return failure(403)
    val next=url.queryParameter("cursor");val target=url.queryParameter("targetId")
    return reply(buildJsonObject{put("items",buildJsonArray{if(target==task)add(record(if(next==null)comment else "second-comment",if(next==null)"First task discussion"else"Later task discussion"))});put("nextCursor",if(paginate&&(next==null||repeatCursor))JsonPrimitive("cursor with +/?")else JsonNull)})
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
  repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"task-comments-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture","verifier")}
 }
 @After fun teardown(){server.shutdown()}
 private fun show(switchable:Boolean=false){compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){
  var present by remember{mutableStateOf(true)};var target by remember{mutableStateOf(task)};var kind by remember{mutableStateOf("task")}
  if(switchable){TextButton({present=!present}){Text(if(present)"Leave discussion"else"Return discussion")};TextButton({target=if(target==task)alternate else task}){Text("Switch task")};TextButton({kind=if(kind=="task")"material"else"task"}){Text("Switch discussion type")}}
  if(present){if(kind=="task")TaskDiscussionWorkspace(repository,project,target)else MaterialDiscussionWorkspace(repository,project,target)}
 }}}}}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNodeWithText(text).performScrollTo().performClick()}
 private fun enter(value:String){await("First task discussion");compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement(value);closeSoftKeyboard()}
 @Test fun existingCommentsReadAndWriteUseTaskTargetAndClearSuccessfulDraft(){
  compose.setContent{NativeTheme{Surface{TaskWorkspace(repository,project,task,"comments")}}};enter("  A new task comment  ")
  assertTrue(repository.secrets.get(draftKey)!!.contains("A new task comment"))
  click("发表评论");await("任务评论已发送。")
  assertEquals(1,writes.size);assertEquals("task",writes.single().twText("targetType"));assertEquals(task,writes.single().twText("targetId"));assertEquals("A new task comment",writes.single().twText("body"))
  assertNull(repository.secrets.get(draftKey));compose.onNodeWithText("A new task comment").performScrollTo().assertIsDisplayed()
  assertTrue(queries.all{it.contains("targetType=task")&&it.contains("targetId=$task")})
 }
 @Test fun sendingFocusedCommentClearsFocusBeforeDisablingEditor(){
  show();await("First task discussion")
  compose.onNode(hasSetTextAction()).performScrollTo().performTextInput("Send while focused")
  click("发表评论");await("任务评论已发送。")
  compose.onNode(hasSetTextAction()).assertIsNotFocused();assertEquals(1,writes.size);assertNull(repository.secrets.get(draftKey))
 }
 @Test fun localDraftSurvivesLeavingAndDoesNotBleedIntoOtherTask(){
  show(true);enter("Private unsent task draft");click("Leave discussion");click("Return discussion");await("已恢复本机任务讨论草稿，尚未发送。")
  compose.onNode(hasSetTextAction()).assertTextContains("Private unsent task draft")
  click("Switch task");compose.waitUntil(10000){queries.any{it.contains("targetId=$alternate")}}
  assertEquals("",compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text);compose.onNodeWithText("Private unsent task draft").assertDoesNotExist()
  click("Switch task");await("已恢复本机任务讨论草稿，尚未发送。");compose.onNode(hasSetTextAction()).assertTextContains("Private unsent task draft");assertTrue(writes.isEmpty())
 }
 @Test fun subsequentPageUsesEncodedServerCursorAndRetainsBothPages(){
  paginate=true;show();await("First task discussion");click("加载更多任务评论");await("Later task discussion")
  assertTrue(queries.last().contains("cursor=cursor%20with%20%2B%2F%3F"));compose.onNodeWithText("First task discussion").assertExists();compose.onNodeWithText("加载更多任务评论").assertDoesNotExist()
 }
 @Test fun repeatedPaginationCursorStopsWithoutAppendingDuplicateRecords(){
  paginate=true;repeatCursor=true;show();await("First task discussion");click("加载更多任务评论");await("讨论分页未前进，请刷新重新读取")
  compose.onNodeWithText("Later task discussion").assertDoesNotExist();compose.onNodeWithText("First task discussion").assertExists()
 }
 @Test fun deniedRefreshClearsServerRecordsDisablesSendAndPreservesLocalDraft(){
  show();enter("Preserve this draft after revocation");denyRead=true;click("刷新任务讨论");await("当前无法访问这项任务的讨论；已清除服务端记录，未发送草稿保留。")
  compose.onNodeWithText("First task discussion").assertDoesNotExist();compose.onNodeWithText("发表评论").assertIsNotEnabled();compose.onNode(hasSetTextAction()).assertTextContains("Preserve this draft after revocation");assertTrue(writes.isEmpty());assertTrue(repository.secrets.get(draftKey)!!.contains("Preserve this draft"))
 }
 @Test fun failedSendRetainsDraftAndExistingOperationWithoutAutomaticSecondWrite(){
  failWrite=true;show();enter("Keep failed task comment");click("发表评论");await("发送结果尚未确认；已保留同步记录和草稿，请在同步中心核对，避免重复发送。")
  assertEquals(1,writes.size);assertTrue(repository.secrets.get(draftKey)!!.contains("Keep failed task comment"));assertTrue(runBlocking{repository.pending()}.isNotEmpty())
  compose.onNodeWithText("发表评论").assertIsNotEnabled();click("刷新任务讨论");await("此评论已保存为待同步记录，请在同步中心核对；不会再次创建。");assertEquals(1,writes.size)
 }
 @Test fun taskAndMaterialDraftsWithSameRecordIdRemainSeparate(){
  show(true);enter("Only task discussion draft");click("Switch discussion type")
  compose.waitUntil(10000){queries.any{it.contains("targetType=material")}}
  assertEquals("",compose.onNode(hasSetTextAction()).fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
  compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement("Only material discussion draft");closeSoftKeyboard()
  assertTrue(repository.secrets.get("material-comment:$account:$project:$task")!!.contains("Only material discussion draft"))
  click("Switch discussion type");await("已恢复本机任务讨论草稿，尚未发送。")
  compose.onNode(hasSetTextAction()).assertTextContains("Only task discussion draft");assertTrue(repository.secrets.get(draftKey)!!.contains("Only task discussion draft"));assertTrue(writes.isEmpty())
 }
 @Test fun accountChangeCannotRestoreAnotherAccountsDraft(){
  show();enter("Only first account draft")
  activeAccount=UUID.randomUUID().toString();runBlocking{repository.exchange("second-account","verifier")}
  compose.waitUntil(10000){compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().singleOrNull()?.config?.get(SemanticsProperties.EditableText)?.text==""}
  compose.onNodeWithText("Only first account draft").assertDoesNotExist();assertTrue(repository.secrets.get(draftKey)!!.contains("Only first account draft"));assertNull(repository.secrets.get("task-comment:$activeAccount:$project:$task"));assertTrue(writes.isEmpty())
 }
 @Test fun queuedCommentKeepsDraftAndDoesNotClaimSentOrCreateAnotherWrite(){
  denyWrite=true
  runBlocking{runCatching{repository.requestDurably("fixture-blocked-comment","POST",path,buildJsonObject{put("targetType","task");put("targetId",alternate);put("body","Earlier blocked comment")})}}
  assertEquals(1,writes.size);denyWrite=false
  show();enter("Queued task comment");click("发表评论");await("此评论已保存为待同步记录，尚未确认发送成功；请在同步中心核对。")
  assertEquals(1,writes.size);assertTrue(repository.secrets.get(draftKey)!!.contains("Queued task comment"));compose.onNodeWithText("任务评论已发送。").assertDoesNotExist();compose.onNodeWithText("发表评论").assertIsNotEnabled()
  assertEquals(2,runBlocking{repository.pending()}.size)
 }
 @Test fun inputAcceptsFourThousandCharactersAndRejectsLongerReplacement(){
  show();enter("x".repeat(4000));compose.onNode(hasSetTextAction()).assertTextContains("x".repeat(4000));assertTrue(repository.secrets.get(draftKey)!!.contains("x".repeat(4000)))
  compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement("y".repeat(4001));closeSoftKeyboard();compose.onNode(hasSetTextAction()).assertTextContains("x".repeat(4000));assertTrue(writes.isEmpty())
 }
}

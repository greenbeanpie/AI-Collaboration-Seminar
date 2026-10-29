package cn.buwei.nativeapp.features

import android.content.Context
import androidx.compose.material3.Surface
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import android.view.inputmethod.InputMethodManager
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/** Local fixtures reproduce the real project task and team API envelopes. No production traffic. */
class TaskWorkspaceTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var repository:ClientRepository
 private lateinit var server:MockWebServer
 private lateinit var context:Context
 private val project="11111111-1111-4111-8111-111111111111"
 private val task="22222222-2222-4222-8222-222222222222"
 private val user="33333333-3333-4333-8333-333333333333"
 private val other="44444444-4444-4444-8444-444444444444"
 private val submission="55555555-5555-4555-8555-555555555555"
 private val calls=ConcurrentLinkedQueue<Pair<String,JsonObject>>()
 private val keys=ConcurrentLinkedQueue<String>()
 private val queryPaths=ConcurrentLinkedQueue<String>()
 @Volatile private var revision=7
 @Volatile private var assignee:String?=null
 @Volatile private var role="owner"
 @Volatile private var failWrite=false
 private val received=AtomicReference<JsonObject?>(null)
 private fun obj(source:String)=Json.parseToJsonElement(source).jsonObject
 private fun reply(data:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
 private fun rows(items:List<JsonObject> = emptyList())=buildJsonObject{put("items",JsonArray(items));put("nextCursor",JsonNull)}
 private fun permissions()=buildJsonObject{teamPermissionLabels.forEach{put(it.first,role=="owner")}}
 private fun member(id:String=user,name:String="本机成员",memberRole:String=role)=buildJsonObject{put("userId",id);put("displayName",name);put("username",if(id==user)"local-user"else"other-user");put("role",memberRole);put("permissionsRevision",4);put("permissions",permissions())}
 private fun taskRow()=buildJsonObject{put("taskId",task);put("title","整理研究成果");put("detail","原生任务说明");put("criteria","引用固定版本证据");put("effortHours",2.5);put("status",if(assignee==null)"todo"else"doing");put("lifecycleState",if(assignee==null)"open"else"in_progress");put("revision",revision);put("assigneeId",assignee?.let{JsonPrimitive(it)}?:JsonNull);put("currentSubmissionId",submission);put("dependsOnTaskIds",JsonArray(emptyList()));put("unfinishedDependencyIds",JsonArray(emptyList()));put("dueDate",JsonNull)}
 private fun submissionRow()=buildJsonObject{put("submissionId",submission);put("taskId",task);put("round",1);put("revision",3);put("body","固定证据成果");put("criteria","本轮标准");put("materialVersionIds",JsonArray(emptyList()));put("materialVersions",JsonArray(emptyList()));put("createdAt","2026-10-19T00:00:00Z")}
 @Before fun setup(){
 context=InstrumentationRegistry.getInstrumentation().targetContext
 server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
 val route=request.path.orEmpty().substringBefore('?');val method=request.method.orEmpty();if(method=="GET")queryPaths.add(request.path.orEmpty())
 val account=buildJsonObject{put("id",user);put("displayName","本机成员");put("username","local-user");put("role","user")}
 if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",account)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
 if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",account)})
 val base="/api/v1/projects/$project"
 if(method=="GET"){return when(route){"$base/members/me"->reply(member());"$base/members"->reply(rows(listOf(member(),member(other,"其他成员","member"))));"$base/tasks/graph"->reply(buildJsonObject{put("items",JsonArray(listOf(taskRow())));put("graphRevision",11);put("canRegenerate",true);put("totals",buildJsonObject{put("total",1);put("done",0)})});"$base/tasks/focus"->reply(rows());"$base/tasks"->reply(rows(listOf(taskRow())));"$base/tasks/$task"->reply(taskRow());"$base/tasks/$task/submissions"->reply(rows(listOf(submissionRow())));"$base/tasks/$task/files","$base/invitation-requests","$base/invitations","$base/username-invitations"->reply(rows());"/api/v1/invitations/inbox"->reply(buildJsonObject{put("items",JsonArray(emptyList()));put("nextOffset",JsonNull)});else->MockResponse().setResponseCode(404).setBody("Unexpected read $route")}}
 val body=if(request.body.size>0)obj(request.body.readUtf8())else JsonObject(emptyMap());calls.add(route to body);request.getHeader("Idempotency-Key")?.let{keys.add(it)};received.set(body)
 if(failWrite)return MockResponse().setResponseCode(409).setBody("""{"error":{"code":"REVISION_CONFLICT","message":"版本冲突，本机编辑保留"}}""")
 if(route=="$base/offline-sync"){val tail=body.twText("tail");val operation=body["body"]!!.jsonObject;received.set(operation);if(tail.endsWith("claim")){assignee=user;revision++};if(tail.endsWith("submissions"))return reply(submissionRow());return reply(taskRow())}
 if(route=="/api/v1/invitations/preview")return reply(buildJsonObject{put("projectId",project);put("projectName","本机邀请项目");put("description","加入前可见的项目说明")})
 if(route=="/api/v1/invitations/accept")return reply(buildJsonObject{put("projectId",project)})
 if(route.endsWith("/decide"))return reply(submissionRow())
 if(route.endsWith("/permissions"))return reply(member(other,"其他成员","member"))
 if(route.endsWith("/dependencies"))return reply(buildJsonObject{put("graphRevision",12)})
 return reply(buildJsonObject{put("ok",true)})
 }};server.start();repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"task-team-${UUID.randomUUID()}-");runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){server.shutdown()}
 private fun showTasks(){compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){TaskWorkspace(repository,project)}}}}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNode(hasText(text) and hasClickAction()).performScrollTo().performClick()}
 private fun closeSoftKeyboard(){
  // API 37 can transfer window focus to the IME; Espresso's root-focus gate
  // then fails before it can dismiss the keyboard. Use the resumed activity token.
  InstrumentationRegistry.getInstrumentation().runOnMainSync {
   ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).forEach{activity->
    activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(activity.window.decorView.windowToken,0)
   }
  }
  compose.waitForIdle()
 }
 private fun screenshot(name:String){val image=compose.onRoot().captureToImage().asAndroidBitmap();val file=File(context.getExternalFilesDir(null),"task-team-fixtures/$name.png");file.parentFile!!.mkdirs();file.outputStream().use{image.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}}
 @Test fun claimUsesCurrentTaskRevisionAndRefreshesAssignee(){showTasks();click("查看与处理");click("领取任务");compose.waitUntil(10000){received.get()?.get("expectedRevision")?.jsonPrimitive?.int==7};assertEquals("tasks/$task/claim",calls.last().second.twText("tail"));compose.waitUntil{revision==8};screenshot("task-claim")}
 @Test fun filtersUseCompleteGraphWithoutDroppingAncestorContext(){showTasks();click("任务状态：全部");click("待验收");await("当前筛选下没有任务");compose.onNodeWithText("只看分配给我的任务").assertExists();assertTrue(queryPaths.any{it.endsWith("/tasks/graph")});assertTrue(queryPaths.none{it.contains("status=submitted")})}
 @Test fun hierarchyKeepsSearchContextAndNavigatesRelations(){
  val parent=buildJsonObject{put("taskId","parent");put("title","项目报告");put("status","doing");put("lifecycleState","in_progress")}
  val child=buildJsonObject{put("taskId","child");put("title","核对数据");put("parentTaskId","parent");put("status","doing");put("lifecycleState","in_progress")}
  val selected=AtomicReference<String?>(null)
  compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){TaskHierarchyList(repository,twBase(project),listOf(parent,child),null,"核对","",false,emptyList(),{selected.set(it)}){}}}}
  await("父任务上下文 · 不符合当前筛选");compose.onNodeWithText("子任务：已完成 0 / 1").assertExists();compose.onAllNodes(hasText("查看与处理") and hasClickAction())[1].performScrollTo().performClick();assertEquals("child",selected.get());screenshot("task-hierarchy-search")
 }
 @Test fun focusShowsFiveThenAllAndKeepsServerReasons(){
  val focus=buildJsonObject{put("items",JsonArray((1..6).map{n->buildJsonObject{put("taskId","focus$n");put("title","重点任务$n");put("assigneeId",user);put("focusReasons",JsonArray(listOf(JsonPrimitive("即将到期"))));put("pinned",false)}}))}
  compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){TaskFocusSection(repository,twBase(project),focus,{}){}}}}
  compose.onNodeWithText("重点任务6").assertDoesNotExist();click("查看全部 6 项");compose.onNodeWithText("重点任务6").assertExists();assertEquals(6,compose.onAllNodesWithText("即将到期").fetchSemanticsNodes().size);screenshot("task-focus")
 }

 @Test fun submissionUsesTaskRevisionAndBoundFileVersions(){assignee=user;showTasks();click("查看与处理");await("提交本轮成果");compose.onNode(hasSetTextAction() and hasText("成果说明（已加密保存在当前账户的本机草稿）")).performScrollTo().performTextInput("逐项引用验收证据");closeSoftKeyboard();click("提交本轮成果");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){received.get()?.twText("body")=="逐项引用验收证据"};assertEquals(7,received.get()!!["expectedRevision"]!!.jsonPrimitive.int);assertEquals(JsonArray(emptyList()),received.get()!!["materialVersionIds"]);assertTrue(calls.any{it.second.twText("tail")=="tasks/$task/submissions"})}
 @Test fun decisionUsesSubmissionRevisionNotTaskRevision(){showTasks();click("查看与处理");await("验收理由");compose.onNode(hasSetTextAction() and hasText("验收理由")).performScrollTo().performTextInput("逐项证据已核对");closeSoftKeyboard();click("提交人工验收");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){calls.any{it.first.endsWith("/decide")}};val call=calls.first{it.first.endsWith("/decide")};assertTrue(call.first.endsWith("/collaboration/submissions/$submission/decide"));assertEquals(3,call.second["expectedRevision"]!!.jsonPrimitive.int);assertEquals("accept",call.second.twText("decision"));screenshot("task-review")}
 @Test fun memberWithoutPermissionCannotSeeTaskCreationOrMemberRemoval(){role="member";showTasks();await("整理研究成果");compose.onNodeWithText("新建任务").assertDoesNotExist();assertTrue(calls.isEmpty())}
 @Test fun permissionEditorUsesMemberPermissionRevisionAndFullFlags(){compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){TeamWorkspace(repository,project)}}};click("调整项目权限");click("保存成员权限");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){calls.any{it.first.endsWith("/permissions")}};val call=calls.first{it.first.endsWith("/permissions")};assertTrue(call.first.endsWith("/members/$other/permissions"));assertEquals(4,call.second["expectedRevision"]!!.jsonPrimitive.int);assertEquals(teamPermissionLabels.map{it.first}.toSet(),call.second["permissions"]!!.jsonObject.keys);screenshot("team-permissions")}
 @Test fun inviteRequiresPreviewThenExplicitJoin(){val joined=AtomicReference<String?>(null);compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){TeamWorkspaceJoin(repository){joined.set(it)}}}};compose.onNode(hasSetTextAction() and hasText("邀请码")).performTextInput("test-invitation-code");closeSoftKeyboard();click("预览邀请项目");await("本机邀请项目");assertNull(joined.get());assertTrue(calls.none{it.first.endsWith("/accept")});click("确认加入项目");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){joined.get()==project};assertEquals("test-invitation-code",calls.first{it.first.endsWith("/accept")}.second.twText("code"))}
 @Test fun ambiguousWriteRetainsDurableIntentAndDoesNotAutomaticallyRetry(){failWrite=true;compose.setContent{NativeTheme{Column(Modifier.verticalScroll(rememberScrollState())){TaskWorkspaceAction(repository,"保存前置依赖","/api/v1/projects/$project/tasks/$task/dependencies",buildJsonObject{put("expectedGraphRevision",11);put("dependsOnTaskIds",JsonArray(emptyList()))},"PUT")}}};click("保存前置依赖");await("版本冲突，本机编辑保留；填写内容已保留，请核对服务端记录后再重试。");assertEquals(1,calls.size);click("保存前置依赖");compose.waitUntil(10000){calls.size==2};assertEquals(1,keys.toSet().size);assertEquals(11,calls.first().second["expectedGraphRevision"]!!.jsonPrimitive.int)}
}

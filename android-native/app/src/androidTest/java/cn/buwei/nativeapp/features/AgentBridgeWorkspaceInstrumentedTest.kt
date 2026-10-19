package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

class AgentBridgeWorkspaceInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 @Test fun resultRequiresExplicitHumanReviewAndPinsRevisionBeforeAdoption(){
  val server=MockWebServer();val owner=UUID.randomUUID().toString();val project=UUID.randomUUID().toString();val taskId=UUID.randomUUID().toString();val handoffId=UUID.randomUUID().toString();val writes=ConcurrentLinkedQueue<Pair<String,JsonObject>>()
  val task=buildJsonObject{put("taskId",taskId);put("title","Bridge fixture task");put("revision",3);put("assigneeId",owner)}
  val handoff=buildJsonObject{put("handoffId",handoffId);put("taskRevision",3);put("state","ready_for_review");put("stale",false);put("adoptedSubmissionId",JsonNull);put("result",buildJsonObject{put("summary","Fixture result ready to inspect");put("artifacts",JsonArray(emptyList()))})}
  fun reply(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
  server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{val path=request.path.orEmpty()
   if(path.endsWith("/auth/native/exchange"))return reply(buildJsonObject{put("user",buildJsonObject{put("id",owner);put("displayName","Fixture");put("isAdmin",false);put("role","user")})}).addHeader("Set-Cookie","ai_office_session=fixture")
   if(request.method!="GET"){val body=Json.parseToJsonElement(request.body.readUtf8()).jsonObject;writes.add(path to body);return reply(buildJsonObject{put("submissionId",UUID.randomUUID().toString())})}
   if(path.endsWith("/tasks/$taskId"))return reply(task)
   if(path.endsWith("/agent-eligibility"))return reply(buildJsonObject{put("status","ready");put("taskRevision",3);put("eligible",true);put("sourceHash","fixture")})
   if(path.endsWith("/devices"))return reply(buildJsonObject{put("items",JsonArray(emptyList()))})
   if(path.endsWith("/handoffs/$handoffId"))return reply(handoff)
   if(path.endsWith("/handoffs"))return reply(buildJsonObject{put("items",buildJsonArray{add(handoff)})})
   return MockResponse().setResponseCode(404)
  }};server.start()
  val repository=ClientRepository(ApplicationProvider.getApplicationContext(),server.url("/").toString().trimEnd('/'),"bridge-${UUID.randomUUID()}-")
  try{runBlocking{repository.exchange("fixture","fixture")}
   compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){TaskBridgeWorkspace(repository,project,taskId)}}}}
   compose.waitUntil(15000){compose.onAllNodesWithText("Fixture result ready to inspect").fetchSemanticsNodes().isNotEmpty()}
   assertTrue(writes.isEmpty());compose.onNodeWithText("采纳并提交验收").performScrollTo().assertIsNotEnabled()
   compose.onAllNodes(isToggleable()).filterToOne(isEnabled()).performScrollTo().performClick()
   compose.onNodeWithText("采纳并提交验收").performScrollTo().performClick();assertTrue(writes.isEmpty());compose.onNodeWithText("确认").performClick()
   compose.waitUntil(15000){writes.isNotEmpty()};val write=writes.single();assertEquals("$bridgeBase/handoffs/$handoffId/adopt-and-submit",write.first);assertTrue(write.second["reviewed"]!!.jsonPrimitive.boolean);assertEquals(3,write.second["expectedTaskRevision"]!!.jsonPrimitive.int)
  }finally{server.shutdown()}
 }
}

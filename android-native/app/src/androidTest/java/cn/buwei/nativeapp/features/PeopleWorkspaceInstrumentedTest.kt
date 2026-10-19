package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.closeSoftKeyboard
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
import java.util.concurrent.atomic.AtomicInteger

class PeopleWorkspaceInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 @Test fun exactSearchLoadsOnlyPublicFieldsAndRevocationClearsDisplayedProfile(){
  val server=MockWebServer();val owner=UUID.randomUUID().toString();val seen=ConcurrentLinkedQueue<String>();val reads=AtomicInteger()
  fun reply(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
  server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{seen.add(request.path.orEmpty());return when(request.path){
   "/api/v1/auth/native/exchange"->reply(buildJsonObject{put("user",buildJsonObject{put("id",owner);put("displayName","Fixture");put("isAdmin",false);put("role","user")})}).addHeader("Set-Cookie","ai_office_session=fixture")
   "/api/v1/profiles/search?username=Exact_User"->reply(buildJsonObject{put("items",buildJsonArray{add(buildJsonObject{put("username","Exact_User");put("displayName","Public fixture")})});put("nextCursor",JsonNull)})
   "/api/v1/profiles/Exact_User"->if(reads.incrementAndGet()==1)reply(buildJsonObject{put("profile",buildJsonObject{put("username","Exact_User");put("displayName","Public fixture");put("bio","Public biography");put("major","Visible major");put("email","Never render private metadata");put("weeklyAvailableHours",13)})})else reply(buildJsonObject{put("profile",JsonNull)})
   else->MockResponse().setResponseCode(404)
  }}};server.start();val repository=ClientRepository(ApplicationProvider.getApplicationContext(),server.url("/").toString().trimEnd('/'),"people-${UUID.randomUUID()}-")
  try{runBlocking{repository.exchange("fixture","fixture")};compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){PeopleWorkspace(repository)}}}
   compose.onNodeWithText("完整用户名").performTextInput("Exact_User");closeSoftKeyboard();compose.onNodeWithText("查找").performClick();compose.waitUntil(15000){compose.onAllNodesWithText("查看公开资料").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("查看公开资料").performScrollTo().performClick();compose.waitUntil(15000){compose.onAllNodesWithText("Public biography").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("Never render private metadata").assertDoesNotExist();compose.onNodeWithText("Visible major").performScrollTo().assertIsDisplayed();assertTrue(seen.contains("/api/v1/profiles/search?username=Exact_User"));assertFalse(seen.any{it.contains("?q=")})
   compose.onNodeWithText("刷新公开资料").performScrollTo().performClick();compose.waitUntil(15000){compose.onAllNodesWithText("未找到可查看的账号").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("Public biography").assertDoesNotExist();assertEquals(2,reads.get())
  }finally{server.shutdown()}
 }
}

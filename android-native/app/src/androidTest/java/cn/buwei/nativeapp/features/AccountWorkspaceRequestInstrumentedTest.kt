package cn.buwei.nativeapp.features

import androidx.test.core.app.ApplicationProvider
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class AccountWorkspaceRequestInstrumentedTest {
 @Test fun sensitiveSettingsUseGuardHeaderAndNeverEnterOfflineQueue()=runBlocking {
  val server=MockWebServer();server.start();val user=UUID.randomUUID().toString()
  fun response(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
  server.enqueue(response(buildJsonObject{put("user",buildJsonObject{put("id",user);put("displayName","Before");put("isAdmin",false);put("role","user")})}).addHeader("Set-Cookie","ai_office_session=fixture"))
  val repository=ClientRepository(ApplicationProvider.getApplicationContext(),server.url("/").toString().trimEnd('/'),"account-${UUID.randomUUID()}-")
  try{repository.exchange("test","test");server.takeRequest();server.enqueue(response(buildJsonObject{put("user",buildJsonObject{put("id",user);put("displayName","After")})}))
   val result=accountWorkspaceRequest(repository,"PATCH","/api/v1/auth/profile",buildJsonObject{put("displayName","After")})
   assertEquals("After",result.obj("user").text("displayName"));val request=server.takeRequest();assertEquals("1",request.getHeader("X-Account-Settings"));assertEquals("PATCH",request.method);assertEquals("/api/v1/auth/profile",request.path);assertTrue(repository.pending().isEmpty())
  }finally{server.shutdown()}
 }
 @Test fun oldAccountEpochCannotSendSettingsRequest()=runBlocking {
  val server=MockWebServer();server.start();val repository=ClientRepository(ApplicationProvider.getApplicationContext(),server.url("/").toString().trimEnd('/'),"account-${UUID.randomUUID()}-")
  try{try{accountWorkspaceRequest(repository,"POST","/api/v1/auth/password",buildJsonObject{put("currentPassword","test-only");put("newPassword","test-only-strong-password")},UUID.randomUUID().toString(),repository.epoch);fail("Old owner must fail before transport")}catch(_:IllegalStateException){};assertEquals(0,server.requestCount);assertTrue(repository.pending().isEmpty())}finally{server.shutdown()}
 }
}

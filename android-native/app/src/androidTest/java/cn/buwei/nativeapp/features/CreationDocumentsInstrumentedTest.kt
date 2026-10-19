package cn.buwei.nativeapp.features

import androidx.test.core.app.ApplicationProvider
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Loopback only: verifies draft upload route family, exact part bytes and imported text. */
class CreationDocumentsInstrumentedTest {
 @Test fun uploadsAndImportsTextOnlyThroughPrivateDraftRoutes()=runBlocking {
  val server=MockWebServer();server.start()
  val draftId=UUID.randomUUID().toString();val user=UUID.randomUUID().toString()
  fun reply(data:JsonObject)=MockResponse().setBody(buildJsonObject{put("data",data)}.toString()).setHeader("Content-Type","application/json")
  fun draft(revision:Int)=buildJsonObject{put("id",draftId);put("revision",revision);put("status","active")}
  server.enqueue(reply(buildJsonObject{put("user",buildJsonObject{put("id",user);put("displayName","Fixture");put("isAdmin",false);put("role","user")})}).addHeader("Set-Cookie","ai_office_session=fixture"))
  val context=ApplicationProvider.getApplicationContext<android.content.Context>();val repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"creation-${UUID.randomUUID()}-")
  repository.exchange("test","test");server.takeRequest()
  val file=File(context.filesDir,"creation-files/$user/${UUID.randomUUID()}-notes.txt").apply{parentFile!!.mkdirs();writeText("A private draft document.")}
  try {
   server.enqueue(reply(buildJsonObject{put("status","uploading");put("partBytes",8388608);put("parts",JsonArray(emptyList()))}))
   server.enqueue(reply(buildJsonObject{put("ok",true)}));server.enqueue(reply(draft(2)));server.enqueue(reply(buildJsonObject{put("accepted",1)}));server.enqueue(reply(draft(3)))
   val result=CreationDocuments.upload(repository,draft(1),file){}
   assertEquals(3,result["revision"]!!.jsonPrimitive.int)
   val begin=server.takeRequest();assertTrue(begin.path!!.startsWith("/api/v1/creation-drafts/$draftId/files/"));assertTrue(begin.path!!.endsWith("/multipart"));assertEquals("notes.txt",Json.parseToJsonElement(begin.body.readUtf8()).jsonObject.text("name"))
   val part=server.takeRequest();assertTrue(part.path!!.endsWith("/multipart/1"));assertEquals(file.readText(),part.body.readUtf8());assertEquals(file.length().toString(),part.getHeader("Content-Length"))
   assertTrue(server.takeRequest().path!!.endsWith("/multipart/complete"))
   val imported=server.takeRequest();assertTrue(imported.path!!.endsWith("/imports"));val body=Json.parseToJsonElement(imported.body.readUtf8()).jsonObject;assertEquals(2,body["expectedRevision"]!!.jsonPrimitive.int);assertEquals(file.readText(),body["blocks"]!!.jsonArray.single().jsonObject.text("text"));assertEquals(JsonNull,body["blocks"]!!.jsonArray.single().jsonObject["pageNumber"])
   assertTrue(server.takeRequest().path!!.endsWith("/imports/complete"));assertTrue(repository.pending().isEmpty())
  }finally{file.delete();server.shutdown()}
 }
}

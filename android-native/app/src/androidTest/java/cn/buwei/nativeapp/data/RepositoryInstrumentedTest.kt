package cn.buwei.nativeapp.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class RepositoryInstrumentedTest {
    private val user="""{"id":"11111111-1111-4111-8111-111111111111","displayName":"测试账户","isAdmin":false,"role":"user"}"""
    private fun response(body:String,status:Int=200)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody(body)
    private suspend fun login(server:MockWebServer):ClientRepository {
        server.enqueue(response("""{"data":{"user":$user}}""").setHeader("Set-Cookie","ai_office_session=test-only; Path=/; HttpOnly"))
        val repository=ClientRepository(ApplicationProvider.getApplicationContext(),server.url("/").toString().trimEnd('/'),"test-${UUID.randomUUID()}-")
        repository.exchange("test-code","test-verifier")
        return repository
    }
    @Test fun cachedReadSurvivesTransportFailureButNotAuthorizationFailure()=runBlocking {
        val server=MockWebServer();server.start()
        val repository=login(server)
        val path="/projects/22222222-2222-4222-8222-222222222222"
        server.enqueue(response("""{"data":{"name":"已保存项目","revision":3}}"""))
        assertEquals("已保存项目",repository.get(path)["name"]!!.jsonPrimitive.content)
        server.enqueue(response("""{"error":{"code":"FORBIDDEN","message":"权限已撤销"}}""",403))
        server.enqueue(response("""{"error":{"code":"FORBIDDEN","message":"权限已撤销"}}""",403))
        try {repository.get(path);fail("HTTP403 must not return cached content")}catch(e:ApiException){assertEquals(403,e.status)}
        server.shutdown()
        try {repository.get(path);fail("revoked snapshot must be inaccessible")}catch(e:java.io.IOException){assertTrue(e.message!!.contains("网络"))}
    }
    @Test fun offlineSafeWriteIsDurableBeforeAcknowledgment()=runBlocking {
        val server=MockWebServer();server.start();val repository=login(server);server.shutdown()
        val result=repository.request("PATCH","/projects/project-1/tasks/task-1",buildJsonObject{put("expectedRevision",3);put("title","本机修改")},"stable-intent")
        assertTrue(result["queued"]!!.jsonPrimitive.boolean)
        val rows=repository.pending();assertEquals(1,rows.size);assertEquals("stable-intent",rows[0].id);assertEquals("pending",rows[0].state)
        assertTrue(rows[0].body.contains("本机修改"))
    }
    @Test fun conflictBlocksLaterProjectWritesWithoutLosingNewIntent()=runBlocking {
        val server=MockWebServer();server.start()
        try {
            val repository=login(server)
            server.enqueue(response("""{"data":{"user":$user}}"""))
            server.enqueue(response("""{"error":{"code":"REVISION_CONFLICT","message":"版本冲突"}}""",409))
            val path="/projects/project-1/tasks/task-1"
            try {repository.request("PATCH",path,buildJsonObject{put("expectedRevision",1)},"first");fail("expected conflict")}catch(e:ApiException){assertEquals(409,e.status)}
            server.enqueue(response("""{"data":{"user":$user}}"""))
            val result=repository.request("PATCH",path,buildJsonObject{put("expectedRevision",2)},"second")
            assertTrue(result["queued"]!!.jsonPrimitive.boolean)
            assertEquals(listOf("conflict","pending"),repository.pending().map{it.state})
            assertEquals(4,server.requestCount)
        } finally {server.shutdown()}
    }
    @Test fun unsafeAiWriteNeverEntersOfflineQueue()=runBlocking {
        val server=MockWebServer();server.start();val repository=login(server);server.shutdown()
        try {repository.request("POST","/projects/project-1/ai-chat/messages",buildJsonObject{put("text","test")});fail("offline AI must fail")}catch(_:java.io.IOException){}
        assertTrue(repository.pending().isEmpty())
    }
}

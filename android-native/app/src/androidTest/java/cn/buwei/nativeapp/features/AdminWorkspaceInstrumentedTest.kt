package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

class AdminWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var server: MockWebServer; private lateinit var repository: ClientRepository
    private val project = "11111111-1111-4111-8111-111111111111"; private val user = "22222222-2222-4222-8222-222222222222"
    private val observed = ConcurrentLinkedQueue<RecordedRequest>()
    private var role = "super_admin"; private var retryFails = true
    private fun response(value: String, status: Int = 200) = MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody("{\"data\":$value}")
    private fun login() = runBlocking { repository.exchange("fixture", "fixture") }
    @Before fun setup() {
        server = MockWebServer(); server.dispatcher = object: Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            observed.add(request); val path = request.path.orEmpty().substringBefore('?'); val base = "/api/v1/projects/$project"
            if(path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user","role":"$role","isAdmin":${role != "user"}}}""").addHeader("Set-Cookie", "ai_office_session=fixture; HttpOnly")
            if(path == "/api/v1/admin/ai-retries" && request.method == "POST") { if(retryFails) { retryFails = false; return response("{}", 500) }; return response("""{"replayed":true}""") }
            if(path == "/api/v1/auth/session") return response("""{"user":{"id":"$user","role":"$role","isAdmin":${role != "user"}}}""")
            if(request.method == "PATCH") return response("""{"revision":8}""")
            return when(path) {
                base -> response("""{"name":"原项目","description":"原说明","revision":7,"myRole":"owner","status":"active","deadlineDate":"2026-12-01T12:30:00+08:00","deadlinePrecision":"datetime"}""")
                "$base/goal" -> response("""{"title":"固定目标","detail":"目标说明","revision":3}""")
                "$base/collaboration/settings" -> response("""{"aiCollaborationEnabled":true,"assignmentMode":"manual","evaluationMode":"manual","planningMode":"manual","progressionMode":"manual","revision":4}""")
                else -> response("""{"items":[],"nextCursor":null}""")
            }
        } }; server.start(); val context = InstrumentationRegistry.getInstrumentation().targetContext
        repository = ClientRepository(context, server.url("/").toString().trimEnd('/'), "admin-fixture-${UUID.randomUUID()}-"); login()
    }
    @After fun cleanup() { server.shutdown() }
    @Test fun ordinaryAccountDoesNotRequestOrRenderAdminControls() {
        role = "user"; login(); val initial = observed.size
        compose.setContent { NativeTheme { AdminWorkspace(repository, "accounts") } }
        compose.onNodeWithText("需要系统管理员权限").assertIsDisplayed(); compose.waitForIdle()
        assertEquals(initial, observed.size)
    }
    @Test fun administratorCannotOpenSuperAdminModelSettings() {
        role = "admin"; login(); val initial = observed.size
        compose.setContent { NativeTheme { AdminWorkspace(repository, "ai-settings") } }
        compose.onNodeWithText("模型与全局策略仅供超级管理员管理。").assertIsDisplayed(); compose.waitForIdle()
        assertEquals(initial, observed.size)
    }
    @Test fun explicitRetryAfterFailureReusesBothBodyAndHeaderIdentityAcrossRepositoryReload() = runBlocking {
        try { adminQueueRetries(repository); fail("expected fixture failure") } catch(_: cn.buwei.nativeapp.data.ApiException) {}
        repository.restore()
        adminQueueRetries(repository)
        val writes = observed.filter { it.path == "/api/v1/admin/ai-retries" && it.method == "POST" }
        assertEquals(2, writes.size); assertEquals(writes[0].body.readUtf8(), writes[1].body.readUtf8()); assertEquals(writes[0].getHeader("Idempotency-Key"), writes[1].getHeader("Idempotency-Key"))
    }
}

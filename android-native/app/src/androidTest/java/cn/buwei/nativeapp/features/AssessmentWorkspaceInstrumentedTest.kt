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

/** Only loopback fixtures. AI writes must be explicit and confirmed, never triggered by composition. */
class AssessmentWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var server: MockWebServer; private lateinit var repository: ClientRepository
    private val project = "11111111-1111-4111-8111-111111111111"
    private val user = "22222222-2222-4222-8222-222222222222"
    private val writes = ConcurrentLinkedQueue<RecordedRequest>()
    private val base get() = "/api/v1/projects/$project"
    private fun response(raw: String) = MockResponse().setHeader("Content-Type", "application/json").setBody("{\"data\":$raw}")
    @Before fun setup() {
        server = MockWebServer(); server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty().substringBefore('?')
            if (path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user","displayName":"测试用户"}}""").addHeader("Set-Cookie", "ai_office_session=fixture; HttpOnly")
            if (request.method != "GET") { writes.add(request); return response("""{"jobId":"fixture-job","rehearsalId":"fixture-rehearsal"}""") }
            return when (path) {
                "/api/v1/capabilities" -> response("""{"features":{"aiEnabled":true}}""")
                base -> response("""{"myRole":"owner","permissions":{"scoreInitiate":true,"scoreCorrect":true}}""")
                "$base/goal" -> response("""{"title":"调查目标","revision":3}""")
                "$base/standards" -> response("""{"items":[{"standardsVersionId":"standard-1","title":"当前标准","version":2,"revision":1,"requirements":[],"rubric":{"weights":[{"key":"evidence","label":"调查证据","weight":100}]}}]}""")
                "$base/members" -> response("""{"items":[{"userId":"$user","displayName":"测试用户"}],"nextCursor":null}""")
                "/api/v1/jobs/fixture-job" -> response("""{"status":"succeeded","execution":{},"activity":{}}""")
                else -> response("""{"items":[],"nextCursor":null}""")
            }
        } }; server.start()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        repository = ClientRepository(context, server.url("/").toString().trimEnd('/'), "assessment-fixture-${UUID.randomUUID()}-")
        runBlocking { repository.exchange("fixture-code", "fixture-verifier") }
    }
    @After fun cleanup() { server.shutdown() }
    private fun waitFor(text: String) { compose.waitUntil(10000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    @Test fun standardGenerationWaitsForExplicitConfirmationAndCancelDoesNotWrite() {
        compose.setContent { NativeTheme { Surface(Modifier.fillMaxSize()) { AssessmentWorkspace(repository, project) } } }
        waitFor("AI 生成标准草稿"); assertTrue(writes.isEmpty())
        compose.onNodeWithText("AI 生成标准草稿").performScrollTo().performClick()
        compose.onNodeWithText("确认操作").assertIsDisplayed(); assertTrue(writes.isEmpty())
        compose.onNodeWithText("取消").performClick(); assertTrue(writes.isEmpty())
        compose.onNodeWithText("AI 生成标准草稿").performScrollTo().performClick(); compose.onNodeWithText("确认").performClick()
        compose.waitUntil(10000) { writes.isNotEmpty() }
        val request = writes.first(); assertEquals("$base/standards/generate", request.path); assertFalse(request.getHeader("Idempotency-Key").isNullOrBlank()); assertEquals("{}", request.body.readUtf8())
    }
    @Test fun rehearsalCreationUsesFixedContractAndDoesNotRunOnOpen() {
        compose.setContent { NativeTheme { Surface(Modifier.fillMaxSize()) { RehearsalWorkspace(repository, project) } } }
        waitFor("开始新演练"); compose.waitUntil(10000) { runCatching { compose.onNodeWithText("开始新演练").assertIsEnabled() }.isSuccess }; assertTrue(writes.isEmpty())
        compose.onNodeWithText("开始新演练").performScrollTo().performClick(); compose.onNodeWithText("确认演练操作").assertIsDisplayed(); assertTrue(writes.isEmpty()); compose.onNodeWithText("确认").performClick()
        compose.waitUntil(10000) { writes.isNotEmpty() }; val request = writes.first(); assertEquals("$base/rehearsals", request.path)
        val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("all", body.text("scope")); assertEquals(JsonNull, body["memberId"]); assertEquals(0, body["materialVersionIds"]!!.jsonArray.size); assertFalse(request.getHeader("Idempotency-Key").isNullOrBlank())
    }
    @Test fun paginationDetectsCyclesRatherThanTruncatingOrLoopingForever() = runBlocking {
        server.dispatcher = object : Dispatcher() { override fun dispatch(request: RecordedRequest) = response("""{"items":[{"title":"一条记录"}],"nextCursor":"repeated"}""") }
        try { assessmentPages(repository, "$base/materials"); fail("repeated cursor must fail") } catch (e: IllegalStateException) { assertTrue(e.message.orEmpty().contains("游标")) }
    }
}

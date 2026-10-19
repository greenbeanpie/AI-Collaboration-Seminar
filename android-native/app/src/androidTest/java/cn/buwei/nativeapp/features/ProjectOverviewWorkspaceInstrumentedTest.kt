package cn.buwei.nativeapp.features

import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

class ProjectOverviewWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun memberOverviewReadsAuthorizedSummaryAndNavigatesWithoutAdminInvitationRequests() {
        val server = MockWebServer(); val calls = ConcurrentLinkedQueue<String>(); val navigated = ConcurrentLinkedQueue<String>(); val project = "11111111-1111-4111-8111-111111111111"; val user = "22222222-2222-4222-8222-222222222222"
        fun response(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody("{\"data\":$value}")
        server.dispatcher = object: Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            if(request.path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie", "ai_office_session=fixture")
            calls.add("${request.method} ${request.path}"); val path = request.path.orEmpty().substringBefore('?')
            return when {
                path.endsWith("/goal") -> response("""{"title":"真实项目主目标","detail":"基于已有正文","revision":3}""")
                path.endsWith("/tasks/graph") -> response("""{"items":[{"taskId":"my-task","title":"我负责的下一步","assigneeId":"$user","status":"doing","createdAt":"2026-10-19","revision":1}],"memberIds":["$user"]}""")
                path.endsWith("/events") -> response("""{"items":[{"eventId":"event-1","type":"material.saved","actorType":"user","payload":{"revision":2},"occurredAt":"2026-10-19T00:00:00Z"}],"nextCursor":null}""")
                path.endsWith("/resource-library") -> response("""{"items":[{"title":"最近保存的成果","purpose":"output","updatedAt":"2026-10-19"}],"nextCursor":null}""")
                path.endsWith("/sources") || path.endsWith("/requirement-sets") -> response("""{"items":[],"nextCursor":null}""")
                else -> response("""{"name":"授权成员项目","myRole":"member","permissions":{"teamManage":false},"deadlineDate":null,"deadlinePrecision":"unknown","status":"active"}""")
            }
        } }; server.start()
        try {
            val repo = ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext, server.url("/").toString().trimEnd('/'), "overview-${UUID.randomUUID()}-"); runBlocking { repo.exchange("fixture", "fixture") }
            compose.setContent { NativeTheme { Surface { ProjectOverviewWorkspace(repo, project) { navigated.add(it) } } } }
            compose.waitUntil(10000) { compose.onAllNodesWithText("真实项目主目标").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("查看任务").performScrollTo().performClick(); assertEquals("tasks", navigated.first())
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("最近保存的成果")); compose.onNodeWithText("最近保存的成果").assertExists()
            compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("查看全部活动")); compose.onNodeWithText("查看全部活动").performClick(); assertTrue(navigated.contains("ledger"))
            assertTrue(calls.none { it.contains("invitation-requests") }); assertTrue(calls.all { it.startsWith("GET ") })
        } finally { server.shutdown() }
    }
}

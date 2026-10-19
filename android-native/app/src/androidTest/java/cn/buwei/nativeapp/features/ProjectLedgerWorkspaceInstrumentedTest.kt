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

class ProjectLedgerWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun cursorBackNavigationAndExactTypeFilterUseRealEventsContract() {
        val server = MockWebServer(); val calls = ConcurrentLinkedQueue<RecordedRequest>(); val project = "11111111-1111-4111-8111-111111111111"; val user = "22222222-2222-4222-8222-222222222222"
        fun response(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody("{\"data\":$value}")
        server.dispatcher = object: Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            if(request.path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie", "ai_office_session=fixture")
            calls.add(request); val second = request.requestUrl?.queryParameter("cursor") == "older"; val payload = if(second) """{"revision":4,"summary":"可读活动详情"}""" else """{"from":"todo","to":"done","summary":"可读活动详情"}"""
            return response("""{"items":[{"eventId":"${if(second) "second-event" else "first-event"}","type":"${if(second) "material.saved" else "task.status_changed"}","actorType":"user","payload":$payload,"occurredAt":"2026-10-19T00:00:00Z"}],"nextCursor":${if(second) "null" else "\"older\""}}""")
        } }; server.start()
        try {
            val repo = ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext, server.url("/").toString().trimEnd('/'), "ledger-${UUID.randomUUID()}-"); runBlocking { repo.exchange("fixture", "fixture") }
            compose.setContent { NativeTheme { Surface { ProjectLedgerWorkspace(repo, project) } } }
            compose.waitUntil(10000) { compose.onAllNodesWithText("待开始 → 已完成").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("查看活动详情").performScrollTo().performClick(); compose.onNodeWithText("可读活动详情").assertExists()
            compose.onNodeWithText("下一页").performScrollTo().performClick(); compose.waitUntil(10000) { compose.onAllNodesWithText("成员已保存材料，版本 r4。").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("上一页").performScrollTo().performClick(); compose.waitUntil(10000) { compose.onAllNodesWithText("待开始 → 已完成").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("事件类型：全部活动").performScrollTo().performClick(); compose.onNode(hasText("更新任务状态") and hasClickAction()).performClick()
            compose.waitUntil(10000) { calls.any { it.requestUrl?.queryParameter("type") == "task.status_changed" } }
            assertTrue(calls.any { it.requestUrl?.queryParameter("cursor") == "older" }); assertTrue(calls.all { it.method == "GET" }); assertTrue(calls.none { it.requestUrl?.queryParameter("actor") != null })
        } finally { server.shutdown() }
    }
}

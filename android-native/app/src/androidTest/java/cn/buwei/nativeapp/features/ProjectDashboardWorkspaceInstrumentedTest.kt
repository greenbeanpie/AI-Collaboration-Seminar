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

class ProjectDashboardWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var server: MockWebServer; private lateinit var repository: ClientRepository
    private var multiProjectPage = false
    private val gets = ConcurrentLinkedQueue<RecordedRequest>(); private val navigation = ConcurrentLinkedQueue<String>()
    private val project = "11111111-1111-4111-8111-111111111111"; private val second = "33333333-3333-4333-8333-333333333333"; private val user = "22222222-2222-4222-8222-222222222222"
    private fun response(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody("{\"data\":$value}")
    @Before fun setup() {
        server = MockWebServer(); server.dispatcher = object: Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            if(request.path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie", "ai_office_session=fixture")
            gets.add(request); val path = request.requestUrl!!.encodedPath
            if(path == "/api/v1/projects") { if(multiProjectPage) return response("""{"items":[{"id":"$project","name":"第一项目","status":"active","myRole":"owner"},{"id":"$second","name":"第二项目","status":"active","myRole":"member"}],"nextCursor":null}"""); val next = request.requestUrl!!.queryParameter("cursor") != null; val archived = request.requestUrl!!.queryParameter("status") == "archived"; return response("""{"items":[{"id":"${if(next) second else project}","name":"${if(next) "第二项目" else if(archived) "归档项目" else "第一项目"}","description":"真实模拟数据","status":"${if(archived) "archived" else "active"}","myRole":"owner","deadlineDate":null,"deadlinePrecision":"unknown"}],"nextCursor":${if(next || archived) "null" else "\"page-two\""}}""") }
            if(path.endsWith("/tasks/graph")) { val done = path.contains(second); return response("""{"items":[{"taskId":"${if(done) "done-task" else "ready-task"}","title":"${if(done) "完成任务" else "可响应任务"}","status":"${if(done) "done" else "todo"}","revision":1,"assigneeId":"$user","lifecycleState":"${if(done) "accepted" else "open"}","dependsOnTaskIds":[],"unfinishedDependencyIds":[],"dueDate":null,"duePrecision":"unknown"}],"memberIds":["$user"]}""") }
            return response("""{"ai":{"user":{"used":1,"limit":20}},"storage":{"user":{"used":100,"limit":2000}}}""")
        } }; server.start(); repository = ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext, server.url("/").toString().trimEnd('/'), "dashboard-${UUID.randomUUID()}-"); runBlocking { repository.exchange("fixture", "fixture") }
    }
    @After fun cleanup() { server.shutdown() }
    private fun waitFor(value: String) { compose.waitUntil(10000) { compose.onAllNodesWithText(value).fetchSemanticsNodes().isNotEmpty() } }
    @Test fun paginationDoesNotPresentIncompleteProjectSubsetAsCompleteTotals() {
        compose.setContent { NativeTheme { Surface { ProjectDashboardWorkspace(repository, { navigation.add("project:$it") }, { navigation.add(it) }) } } }
        waitFor("第一项目"); compose.onNodeWithText("加载全部项目及任务图后显示完整统计。").performScrollTo().assertExists()
        compose.onNodeWithText("加载更多项目").performScrollTo().performClick(); waitFor("第二项目")
        compose.waitUntil(10000) { compose.onAllNodesWithText("进行中 1 个项目 · 任务完成 1 / 2").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(gets.any { it.requestUrl?.queryParameter("cursor") == "page-two" }); assertTrue(gets.all { it.method == "GET" })
        compose.onAllNodesWithText("进入项目")[0].performScrollTo().performClick(); assertTrue(navigation.first().startsWith("project:"))
        compose.onNodeWithText("新建项目").performScrollTo().performClick(); compose.onNodeWithText("加入团队").performScrollTo().performClick(); assertTrue(navigation.contains("create-project")); assertTrue(navigation.contains("join"))
    }
    @Test fun parallelGraphsFromSamePageRetainEveryProjectSummary() {
        multiProjectPage = true
        compose.setContent { NativeTheme { Surface { ProjectDashboardWorkspace(repository, {}, {}) } } }
        compose.waitUntil(10000) { compose.onAllNodesWithText("进行中 1 个项目 · 任务完成 1 / 2").fetchSemanticsNodes().isNotEmpty() }
        assertTrue(gets.any { it.requestUrl?.encodedPath?.contains(project) == true && it.requestUrl?.encodedPath?.endsWith("/tasks/graph") == true })
        assertTrue(gets.any { it.requestUrl?.encodedPath?.contains(second) == true && it.requestUrl?.encodedPath?.endsWith("/tasks/graph") == true })
    }
    @Test fun archiveAndSearchUseOnlySupportedBackendQueryParameters() {
        compose.setContent { NativeTheme { Surface { ProjectDashboardWorkspace(repository, {}, {}) } } }
        waitFor("第一项目"); compose.onNodeWithText("搜索项目名称或说明").performScrollTo().performTextInput("研究")
        androidx.test.espresso.Espresso.closeSoftKeyboard(); compose.onNodeWithText("搜索").performScrollTo().performClick()
        compose.waitUntil(10000) { gets.any { it.requestUrl?.queryParameter("q") == "研究" } }
        compose.onNodeWithText("项目筛选：全部当前项目").performScrollTo().performClick(); compose.onNodeWithText("已归档项目").performClick(); waitFor("归档项目")
        assertTrue(gets.any { it.requestUrl?.queryParameter("status") == "archived" }); assertTrue(gets.none { it.requestUrl?.queryParameter("status") == "done" })
    }
}

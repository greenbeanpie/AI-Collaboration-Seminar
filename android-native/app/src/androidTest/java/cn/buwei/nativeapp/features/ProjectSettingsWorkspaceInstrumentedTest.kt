package cn.buwei.nativeapp.features

import androidx.compose.material3.Surface
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
import java.util.concurrent.atomic.AtomicReference

class ProjectSettingsWorkspaceInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    @Test fun projectSaveRequiresConfirmationAndPreservesUneditedDeadline() {
        val server = MockWebServer(); val written = AtomicReference<RecordedRequest?>(null)
        val project = "11111111-1111-4111-8111-111111111111"; val user = "22222222-2222-4222-8222-222222222222"
        fun response(value: String) = MockResponse().setHeader("Content-Type", "application/json").setBody("{\"data\":$value}")
        server.dispatcher = object: Dispatcher() { override fun dispatch(request: RecordedRequest): MockResponse {
            if(request.path == "/api/v1/auth/native/exchange") return response("""{"user":{"id":"$user"}}""").addHeader("Set-Cookie", "ai_office_session=fixture")
            if(request.method == "PATCH") { written.set(request); return response("""{"revision":8}""") }
            return when { request.path?.endsWith("/goal") == true -> response("""{"title":"主目标","detail":"说明","revision":3}"""); request.path?.endsWith("/settings") == true -> response("""{"aiCollaborationEnabled":true,"assignmentMode":"manual","evaluationMode":"manual","revision":2}"""); else -> response("""{"name":"原项目","description":"原说明","myRole":"owner","revision":7,"deadlineDate":"2026-12-01T12:30:00+08:00","deadlinePrecision":"datetime","status":"active"}""") }
        } }; server.start()
        try {
            val repository = ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext, server.url("/").toString().trimEnd('/'), "project-settings-${UUID.randomUUID()}-"); runBlocking { repository.exchange("fixture", "fixture") }
            compose.setContent { NativeTheme { Surface { ProjectSettingsWorkspace(repository, project) } } }
            compose.waitUntil(10000) { compose.onAllNodesWithText("原项目").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText("项目名称").performTextReplacement("修改后的项目"); androidx.test.espresso.Espresso.closeSoftKeyboard()
            compose.onNodeWithText("保存项目设置").performScrollTo().performClick(); assertNull(written.get())
            compose.onNodeWithText("确认").performClick(); compose.waitUntil(10000) { written.get() != null }
            val body = Json.parseToJsonElement(written.get()!!.body.readUtf8()).jsonObject
            assertEquals(setOf("name", "expectedRevision"), body.keys); assertEquals(7, body["expectedRevision"]!!.jsonPrimitive.int)
        } finally { server.shutdown() }
    }
}

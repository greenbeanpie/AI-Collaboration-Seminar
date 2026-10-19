package cn.buwei.nativeapp.media

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
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class ExportWorkspaceInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    private lateinit var server:MockWebServer
    private lateinit var repository:ClientRepository
    private val reads=AtomicInteger()
    @Volatile private var firstFails=false
    private fun response(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
    @Before fun setup(){
        val user=buildJsonObject{put("id",UUID.randomUUID().toString());put("username","export-fixture");put("displayName","Export fixture");put("role","user");put("isAdmin",false)}
        server=MockWebServer()
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
            if(request.path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly; SameSite=Strict")
            if(request.path=="/api/v1/projects/fixture/export-bundle"&&request.method=="GET"){
                val count=reads.incrementAndGet()
                if(firstFails&&count==1)return MockResponse().setResponseCode(503).setHeader("Content-Type","application/json").setBody("""{"error":{"message":"fixture temporary error"}}""")
                return response(buildJsonObject{put("generatedAt","snapshot-$count");put("markdown",(1..1005).joinToString("\n"){"完整导出第 $it 行"})})
            }
            return MockResponse().setResponseCode(404)
        }}
        server.start();repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"export-${UUID.randomUUID()}-")
        runBlocking{repository.exchange("fixture-code","fixture-verifier")}
    }
    @After fun teardown(){server.shutdown()}
    @Test fun previewCanReachBeyondOneThousandLinesAndRefreshReadsNewSnapshot(){
        compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){ExportWorkspace(repository,"fixture")}}}
        compose.waitUntil(15000){compose.onAllNodesWithText("预览生成于：snapshot-1").fetchSemanticsNodes().isNotEmpty()}
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("完整导出第 1005 行"));compose.onNodeWithText("完整导出第 1005 行").assertIsDisplayed()
        compose.onNodeWithText("刷新数据").performClick()
        compose.waitUntil(15000){compose.onAllNodesWithText("预览生成于：snapshot-2").fetchSemanticsNodes().isNotEmpty()};assertEquals(2,reads.get())
    }
    @Test fun initialReadFailureHasExplicitRecoveryWithoutAutomaticRetry(){
        firstFails=true
        compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){ExportWorkspace(repository,"fixture")}}}
        compose.waitUntil(15000){compose.onAllNodesWithText("fixture temporary error",substring=true).fetchSemanticsNodes().isNotEmpty()}
        compose.runOnIdle{assertEquals(1,reads.get())};compose.onNodeWithText("刷新数据").performClick()
        compose.waitUntil(15000){compose.onAllNodesWithText("预览生成于：snapshot-2").fetchSemanticsNodes().isNotEmpty()};assertEquals(2,reads.get())
    }
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.*
import androidx.lifecycle.compose.LocalLifecycleOwner
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
import java.util.concurrent.atomic.AtomicInteger

class ProcessingParityInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var repository:ClientRepository;private lateinit var server:MockWebServer
 private val project=UUID.randomUUID().toString();private val sourceId=UUID.randomUUID().toString();private val version=UUID.randomUUID().toString();private val file=UUID.randomUUID().toString();private val job=UUID.randomUUID().toString()
 private val base get()="/api/v1/projects/$project"
 private val fileReads=AtomicInteger();private val sourceReads=AtomicInteger();private val writes=ConcurrentLinkedQueue<Pair<String,JsonObject>>()
 @Volatile private var active=false;@Volatile private var alwaysActive=false;@Volatile private var phaseFailed=false;@Volatile private var deny=0;@Volatile private var media=false;@Volatile private var resume=false;@Volatile private var paused=false
 private val lifecycleOwner=object:LifecycleOwner{override val lifecycle=LifecycleRegistry(this)}
 private fun response(value:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 private fun source()=buildJsonObject{put("sourceId",sourceId);put("fileId",file);put("currentVersionId",version);put("lifecycleVersion",7)}
 private fun fileState()=buildJsonObject{
  put("lifecycleVersion",7);put("canProcess",true);put("jobId",JsonNull);put("jobStatus",if(paused)"waiting_input"else if(alwaysActive||active&&fileReads.get()==1)"running"else"succeeded")
  put("textStatus","ready");put("summaryStatus",if(phaseFailed)"failed"else"ready");put("requirementsStatus","ready");put("needsImages",0)
 }
 private fun sourceState()=buildJsonObject{
  put("textStatus","ready");put("requirementsStatus","ready");put("summaryStatus","ready");put("summaryRevision",4)
  put("summary",buildJsonObject{put("title","Frozen summary");put("summary","Previously readable summary");put("keyPoints",buildJsonArray{});put("caveats",buildJsonArray{});put("citations",buildJsonArray{})})
  if(media)put("media",buildJsonObject{
   put("stage","processing");put("completedWindows",1);if(resume)put("jobId",job)
   put("audio",buildJsonObject{put("phase","waiting_config");put("qualityScore",0.42);put("reasons",buildJsonArray{add("Quality reason preserved")});put("transcriptAvailable",true);put("canResumeFallback",resume)})
   put("summary",buildJsonObject{put("complete",false);put("title","Partial media title");put("summary","Partial media body");put("keyPoints",buildJsonArray{add("Media key point")});put("conclusions",buildJsonArray{add("Media conclusion")});put("actionItems",buildJsonArray{add("Media action")});put("caveats",buildJsonArray{add("Uncovered range")});put("timestamps",buildJsonArray{})})
  })
 }
 @Before fun setup(){
  val user=UUID.randomUUID().toString()
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val path=request.requestUrl!!.encodedPath
   if(path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",buildJsonObject{put("id",user)})}).addHeader("Set-Cookie","ai_office_session=fixture")
   if(request.method=="GET"&&path=="$base/sources/$sourceId")return response(source())
   if(request.method=="GET"&&path.endsWith("/processing")){
    if(path.contains("/files/"))fileReads.incrementAndGet()else sourceReads.incrementAndGet()
    if(deny!=0)return MockResponse().setResponseCode(deny).setHeader("Content-Type","application/json").setBody("""{"error":{"message":"Fixture processing read failed"}}""")
    return response(if(path.contains("/files/"))fileState()else sourceState())
   }
   if(request.method=="POST"){
    val body=Json.parseToJsonElement(request.body.readUtf8()).jsonObject;writes.add(path to body);phaseFailed=false
    return response(if(path.endsWith("/media-resume"))buildJsonObject{put("jobId",job);put("status","queued")}else fileState())
   }
   if(path=="/api/v1/jobs/$job")return response(buildJsonObject{put("jobId",job);put("status","waiting_input");put("activity",buildJsonObject{});put("execution",buildJsonObject{put("state","paused")})})
   return MockResponse().setResponseCode(404)
  }};server.start();repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"processing-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){server.shutdown()}
 private fun await(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){compose.onNodeWithText(text).performScrollTo().performClick()}
 private fun showFile(customLifecycle:Boolean=false){
  compose.setContent{NativeTheme{Surface{CompositionLocalProvider(LocalLifecycleOwner provides if(customLifecycle)lifecycleOwner else LocalLifecycleOwner.current){Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceFileProcessing(repository,project,file,"fixture.pdf")}}}}}
  if(customLifecycle)compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.STARTED}
  click("正文提取与文件处理")
 }
 private fun showSource(){compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceSourceProcessing(repository,project,source(),buildJsonObject{put("sourceVersionId",version)}){}}}}}}
 @Test fun existingRunningFileRefreshesWithoutAnyWriteOrVisibleJobCard(){
  active=true;showFile();compose.waitUntil(10000){fileReads.get()>=2}
  await("正文：已完成 · 总结：已完成 · 要求：已完成");assertTrue(writes.isEmpty())
 }
 @Test fun independentFailedSummarySendsExplicitRetryWithFrozenFileLifecycle(){
  phaseFailed=true;showFile();await("正文：已完成 · 总结：处理失败 · 要求：已完成");click("启动或继续文件处理");compose.onNodeWithText("确认").performClick()
  compose.waitUntil(10000){writes.size==1};assertEquals("$base/files/$file/processing",writes.single().first);assertTrue(writes.single().second["retry"]!!.jsonPrimitive.boolean);assertEquals(7,writes.single().second["expectedLifecycleVersion"]!!.jsonPrimitive.int)
 }
 @Test fun pausedFileCannotSubmitAnotherProcessingIntent(){
  paused=true;showFile();await("任务已暂停或等待补充，请在执行卡片或正文处理记录中继续。")
  compose.onNodeWithText("启动或继续文件处理").assertIsNotEnabled();assertTrue(writes.isEmpty())
 }
 @Test fun audioQualityAndIncompleteSummaryRemainVisibleWithoutResumePermission(){
  media=true;showSource();await("转录质量评分：0.42 · 通过门槛 0.85");compose.onNodeWithText("Quality reason preserved").assertExists()
  compose.onNodeWithText("机器转录已私有保存，可继续处理。").assertExists();compose.onNodeWithText("继续 Gemini 音频回退").assertIsNotEnabled()
  compose.onNodeWithText("部分摘要，尚未完整覆盖，请结合原文件核对。").assertExists();compose.onNodeWithText("生成或重试文件总结").assertDoesNotExist()
  listOf("Media key point","Media conclusion","Media action","Uncovered range").forEach{compose.onNode(hasText(it,substring=true)).assertExists()};assertTrue(writes.isEmpty())
 }
 @Test fun eligibleAudioResumeRequiresConfirmationAndUsesExistingJob(){
  media=true;resume=true;showSource();await("继续 Gemini 音频回退");click("继续 Gemini 音频回退");assertTrue(writes.isEmpty());compose.onNodeWithText("确认").performClick()
  compose.waitUntil(10000){writes.size==1};assertEquals("$base/sources/$sourceId/versions/$version/processing/media-resume",writes.single().first);assertEquals(job,writes.single().second.twText("jobId"))
 }
 @Test fun deniedRefreshClearsPriorSummaryAndItsWriteControls(){
  showSource();await("Previously readable summary");deny=403;click("刷新正文与总结状态")
  compose.waitUntil(10000){compose.onAllNodesWithText("Previously readable summary").fetchSemanticsNodes().isEmpty()};compose.onNodeWithText("只提取正文").assertDoesNotExist();assertTrue(writes.isEmpty())
 }
 @Test fun transientFailureKeepsPreviousSummaryWithExplicitStaleStatus(){
  showSource();await("Previously readable summary");deny=500;click("刷新正文与总结状态")
  compose.waitUntil(10000){compose.onAllNodes(hasText("当前显示上次读取状态",substring=true)).fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("Previously readable summary").assertExists();assertTrue(writes.isEmpty())
 }
 @Test fun backgroundStopsProcessingPollingAndForegroundReadsFreshState(){
  alwaysActive=true;showFile(true);compose.waitUntil(10000){fileReads.get()>=2}
  compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.CREATED};val count=fileReads.get();Thread.sleep(3000);assertEquals(count,fileReads.get())
  compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.STARTED};compose.waitUntil(10000){fileReads.get()>count};assertTrue(writes.isEmpty())
  compose.runOnIdle{lifecycleOwner.lifecycle.currentState=Lifecycle.State.DESTROYED}
 }
}

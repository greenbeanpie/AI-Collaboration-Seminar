package cn.buwei.nativeapp.media

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.mobile.RecordingStore
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Loopback-only recording API and local manifests; no microphone, camera or model is invoked. */
class NativeRecordingParityInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var repository:ClientRepository;private lateinit var server:MockWebServer
 private val account=UUID.randomUUID().toString();private val colleague=UUID.randomUUID().toString()
 private val project=UUID.randomUUID().toString();private val material=UUID.randomUUID().toString();private val session=UUID.randomUUID().toString();private val file=UUID.randomUUID().toString()
 private val source=UUID.randomUUID().toString();private val version=UUID.randomUUID().toString();private val base get()="/api/v1/projects/$project/recording-sessions"
 private val otherSession=UUID.randomUUID().toString()
 private val releaseDelayed=CountDownLatch(1);private val delayedReadStarted=AtomicBoolean();private val delayedReadFinished=AtomicBoolean();private val firstSessionReads=AtomicInteger()
 @Volatile private var multipleSessions=false;@Volatile private var delayOldPoll=false;@Volatile private var processingRunning=false;@Volatile private var processingReady=false;@Volatile private var secondPageUpdated=false;@Volatile private var thirdPageExists=false
 private val uploadSession=UUID.randomUUID().toString()
 private val fileCreates=AtomicInteger();private val uploadedParts=ConcurrentHashMap<Int,Int>();private val partAttempts=ConcurrentHashMap<Int,Int>()
 @Volatile private var uploadComplete=false;@Volatile private var rejectPartTwo=false;@Volatile private var registeredSegmentId:String?=null
 private val writes=ConcurrentLinkedQueue<Pair<String,JsonObject>>();private val reads=ConcurrentLinkedQueue<String>();private val destination=AtomicReference<String?>(null)
 @Volatile private var failedRead=0;@Volatile private var failCreate=false;@Volatile private var failedRetry=0;@Volatile private var availableSegment=false
 private fun response(value:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",value)}.toString())
 private fun error(status:Int)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody("""{"error":{"message":"Recording fixture $status","code":"FIXTURE"}}""")
 private fun sessionRow()=buildJsonObject{put("sessionId",session);put("clientSessionId",session);put("materialId",material);put("title","Meeting fixture");put("kind","audio");put("status","complete");put("processingStatus",if(processingReady)"ready"else if(processingRunning)"running"else"failed");put("summaryRevision",3)}
 private fun detailRow(second:Boolean)=JsonObject(sessionRow()+buildJsonObject{
  put("summaryMarkdown","Recording summary fixture");put("interruptions",buildJsonArray{add(buildJsonObject{put("startMs",1000);put("endMs",3000);put("reason","User pause fixture")})})
  put("segments",buildJsonArray{add(buildJsonObject{put("sequence",if(second)2 else 1);put("fileId",file);put("sourceId",source);put("sourceVersionId",version);put("startMs",if(second)3000 else 0);put("endMs",if(second)5000 else 1000);put("status",if(availableSegment)"ready"else"unavailable");put("error",if(second)if(secondPageUpdated)"Second page updated fixture"else"Second page original fixture"else"Segment error fixture")})})
  put("nextCursor",if(second)if(thirdPageExists)JsonPrimitive("2")else JsonNull else JsonPrimitive("1"))
 })
 @Before fun setup(){
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val url=request.requestUrl!!;val path=url.encodedPath
   if(path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",buildJsonObject{put("id",account);put("role","user")})}).addHeader("Set-Cookie","ai_office_session=fixture")
   if(path=="/api/v1/auth/session")return response(buildJsonObject{put("user",buildJsonObject{put("id",account);put("role","user")})})
   val uploadBase="/api/v1/projects/$project/files/$file/uploads"
   if(path.startsWith("$uploadBase/$uploadSession/parts/")&&request.method=="PUT"){
    val number=path.substringAfterLast('/').toInt();partAttempts.compute(number){_,count->(count?:0)+1}
    if(number==2&&rejectPartTwo)return error(503)
    uploadedParts[number]=request.body.readByteArray().size
    return response(buildJsonObject{put("partNumber",number)})
   }
   if(request.method=="GET"){
    reads.add(request.path!!)
    if(path=="$uploadBase/$uploadSession")return response(buildJsonObject{put("status",if(uploadComplete)"complete"else"uploading");put("parts",buildJsonArray{uploadedParts.entries.sortedBy{it.key}.forEach{(number,size)->add(buildJsonObject{put("partNumber",number);put("sizeBytes",size)})}})})
    if(path=="/api/v1/projects/$project/members")return response(buildJsonObject{put("items",buildJsonArray{add(buildJsonObject{put("userId",if(url.queryParameter("cursor")==null)account else colleague);put("displayName",if(url.queryParameter("cursor")==null)"Self fixture"else"Colleague fixture")})});put("nextCursor",if(url.queryParameter("cursor")==null)JsonPrimitive("member-next")else JsonNull)})
    if(path=="/api/v1/projects/$project/files")return response(buildJsonObject{put("items",buildJsonArray{add(buildJsonObject{put("fileId",file);put("name","meeting-original.mp3");put("status","available");put("deletedAt",JsonNull);put("archivedAt",JsonNull)})});put("nextCursor",JsonNull)})
    if(path==base){if(failedRead!=0)return error(failedRead);return response(buildJsonObject{put("items",buildJsonArray{add(sessionRow());if(multipleSessions)add(JsonObject(sessionRow()+("sessionId" to JsonPrimitive(otherSession))+("title" to JsonPrimitive("Other meeting fixture"))))});put("nextCursor",JsonNull)})}
    if(path=="$base/$session"){
     if(failedRead!=0)return error(failedRead)
     val count=firstSessionReads.incrementAndGet()
     if(delayOldPoll&&count>=2&&delayedReadStarted.compareAndSet(false,true)){releaseDelayed.await(10,TimeUnit.SECONDS);delayedReadFinished.set(true)}
     return response(detailRow(url.queryParameter("cursor")!=null))
    }
    if(path=="$base/$otherSession")return response(JsonObject(detailRow(false)+("sessionId" to JsonPrimitive(otherSession))+("title" to JsonPrimitive("Other meeting fixture"))+("summaryMarkdown" to JsonPrimitive("Other recording summary fixture"))))
   }
   if(request.method in listOf("POST","PUT")){
    val body=if(request.body.size>0)Json.parseToJsonElement(request.body.readUtf8()).jsonObject else buildJsonObject{}
    writes.add(path to body)
    if(path=="/api/v1/projects/$project/files"){fileCreates.incrementAndGet();return response(buildJsonObject{put("fileId",file)})}
    if(path==uploadBase)return response(buildJsonObject{put("sessionId",uploadSession);put("partBytes",4)})
    if(path=="$uploadBase/$uploadSession/complete"){uploadComplete=true;return response(buildJsonObject{put("fileId",file)})}
    if(path=="$base/$session/segments/1"){
     val incoming=body["fileId"]!!.jsonPrimitive.content
     if(registeredSegmentId!=null&&registeredSegmentId!=incoming)return error(409)
     registeredSegmentId=incoming
    }
    if(path==base){if(failCreate)return error(503);return response(sessionRow())}
    if(path=="$base/$session/retry"){if(failedRetry!=0)return error(failedRetry);return response(sessionRow())}
    if(path=="$base/$session/complete"||path.startsWith("$base/$session/segments/"))return response(sessionRow())
   }
   return error(404)
  }};server.start();repository=ClientRepository(InstrumentationRegistry.getInstrumentation().targetContext,server.url("/").toString().trimEnd('/'),"recording-parity-${UUID.randomUUID()}-")
  runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){releaseDelayed.countDown();server.shutdown()}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNodeWithText(text).performScrollTo().performClick()}
 private fun store():RecordingStore{
  val context=repository.context;return RecordingStore(context,File(context.dataDir,"recordings").path,account,UUID.randomUUID().toString()).also{it.create(JSONObject().put("id",it.directory.name).put("accountId",account).put("projectId",project).put("kind","audio"));val piece=File(it.directory,"segment-1.m4a");piece.writeText("fixture bytes");it.complete(piece,0,1000);it.state("stopped",1000)}
 }
 private fun showDetail(){compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){NativeRecordingDetail(repository,project,material){destination.set(it)}}}}};await("Recording summary fixture")}
 @Test fun observedPauseEnablesResumeWithoutServiceInstanceBooleanChanging(){
  val snapshot=AtomicReference("""{"state":"recording"}""");val actions=ConcurrentLinkedQueue<String>()
  compose.setContent{NativeTheme{val value by observeNativeRecordingSnapshot{snapshot.get()};NativeRecordingControls(value?.let{JSONObject(it).optString("state")=="paused"}==true){actions.add(it);snapshot.set(JSONObject().put("state",if(it=="pause")"paused"else"recording").toString())} }}
  compose.onNodeWithText("继续").assertIsNotEnabled();compose.onNodeWithText("暂停").performClick()
  compose.waitUntil(15000){compose.onAllNodes(hasText("继续") and isEnabled()).fetchSemanticsNodes().isNotEmpty()}
  compose.onNodeWithText("继续").performClick();compose.waitUntil(15000){actions.contains("resume")};assertEquals(listOf("pause","resume"),actions.toList())
 }
 @Test fun metadataSurvivesReloadAndFreezesBeforeAnUncertainCreateResponse(){
  val draft=store();draft.metadata("Chosen meeting title",listOf(colleague,account));failCreate=true
  runBlocking{assertTrue(runCatching{uploadNativeRecording(repository,project,draft,{},uploadFile={_,_,_->file})}.isFailure)}
  val first=writes.single().second;assertEquals("Chosen meeting title",first["title"]!!.jsonPrimitive.content)
  val restored=RecordingStore(repository.context,File(repository.context.dataDir,"recordings").path,account,draft.directory.name)
  assertTrue(runCatching{restored.metadata("Another title",listOf(account))}.isFailure);assertTrue(restored.view().has("uploadMetadata"))
  failCreate=false;val passed=AtomicReference<List<String>>()
  runBlocking{uploadNativeRecording(repository,project,restored,{},uploadFile={_,purpose,people->assertEquals("reference",purpose);passed.set(people);file})}
  assertEquals(first,writes.filter{it.first==base}.last().second);assertEquals(listOf(account,colleague).sorted(),passed.get().sorted());assertEquals("uploaded",restored.view().getString("state"))
  assertEquals(material,restored.view().getString("materialId"));assertTrue(reads.none{it.contains("/jobs")})
 }
 @Test fun legacyDraftWithCloudFileIdKeepsOldUploadIdentityAndOriginalSegments(){
  val original=store();val legacy=original.view();legacy.remove("metadataVersion");legacy.getJSONArray("segments").getJSONObject(0).put("fileId",file)
  File(original.directory,"manifest.json").writeText(legacy.toString())
  val restored=RecordingStore(repository.context,File(repository.context.dataDir,"recordings").path,account,original.directory.name)
  assertTrue(restored.view().getBoolean("legacyMetadataPreserved"));assertTrue(runCatching{restored.metadata("Changed new title",listOf(colleague))}.isFailure)
  runBlocking{uploadNativeRecording(repository,project,restored,{},uploadFile={_,_,_->throw AssertionError("Known legacy cloud file must not be replaced")})}
  val sent=writes.first{it.first==base}.second
  assertEquals("会议录制 ${legacy.getString("createdAt")}",sent["title"]!!.jsonPrimitive.content);assertEquals(listOf(account),(sent["contributorIds"]as JsonArray).map{it.jsonPrimitive.content})
  assertTrue(File(restored.directory,"segment-1.m4a").isFile);assertEquals(file,writes.single{it.first.endsWith("/segments/1")}.second["fileId"]!!.jsonPrimitive.content)
 }
 private fun restoreLegacyWithoutSegmentFileId(original:RecordingStore):RecordingStore{
  val legacy=original.view();legacy.remove("metadataVersion");legacy.getJSONArray("segments").getJSONObject(0).remove("fileId")
  File(original.directory,"manifest.json").writeText(legacy.toString())
  return RecordingStore(repository.context,File(repository.context.dataDir,"recordings").path,account,original.directory.name)
 }
 @Test fun legacyCompletedPlainTransferManifestReusesRegisteredFileWithoutCreatingAnotherId(){
  val draft=store();val piece=File(draft.directory,"segment-1.m4a")
  runBlocking{assertEquals(file,AttachmentTransfer(repository).upload(project,piece){})}
  assertTrue(uploadComplete);registeredSegmentId=file
  val before=partAttempts.toMap();val restored=restoreLegacyWithoutSegmentFileId(draft)
  runBlocking{uploadNativeRecording(repository,project,restored,{})}
  assertEquals(1,fileCreates.get());assertEquals(before,partAttempts.toMap());assertEquals(file,registeredSegmentId)
  assertEquals(1,writes.count{it.first.endsWith("/uploads/$uploadSession/complete")});assertTrue(piece.isFile)
  assertEquals(file,restored.view().getJSONArray("segments").getJSONObject(0).getString("fileId"))
 }
 @Test fun legacyInterruptedPlainMultipartTransferResumesExistingPartsBeforeRegisteringSegment(){
  val draft=store();val piece=File(draft.directory,"segment-1.m4a");rejectPartTwo=true
  runBlocking{assertTrue(runCatching{AttachmentTransfer(repository).upload(project,piece){}}.isFailure)}
  assertFalse(uploadComplete);assertEquals(1,uploadedParts.size);assertEquals(1,fileCreates.get())
  rejectPartTwo=false;val restored=restoreLegacyWithoutSegmentFileId(draft)
  runBlocking{uploadNativeRecording(repository,project,restored,{})}
  assertTrue(uploadComplete);assertEquals(1,fileCreates.get());assertEquals(1,partAttempts[1]);assertEquals(2,partAttempts[2]);assertEquals(file,registeredSegmentId)
  assertEquals(piece.length().toInt(),uploadedParts.values.sum());assertEquals("uploaded",restored.view().getString("state"));assertTrue(piece.isFile)
 }
 @Test fun metadataEditorLoadsAllMemberPagesAndPersistsSelectedContributors(){
  val draft=store()
  compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){RecordingMetadataEditor(repository,project,draft,false,{}, {})}}}}
  await("Colleague fixture");compose.onNode(hasSetTextAction()).performScrollTo().performTextReplacement("Team meeting chosen");closeSoftKeyboard()
  compose.onAllNodes(isToggleable()).get(1).performScrollTo().performClick()
  assertEquals("Team meeting chosen",draft.view().getString("title"));assertEquals(2,draft.view().getJSONArray("contributorIds").length());assertTrue(reads.any{it.contains("cursor=member-next")})
 }
 @Test fun cloudDetailPaginatesSegmentsAndNavigatesToFixedSourceVersion(){
  showDetail();click("查看第 1 段固定来源与处理结果");assertTrue(destination.get()!!.contains("resourceId=$source"));assertTrue(destination.get()!!.contains("sourceVersionId=$version"))
  click("加载更多会议片段");await("第 2 段");assertTrue(reads.any{it.contains("cursor=1")});compose.onNodeWithText("加载更多会议片段").assertDoesNotExist();compose.onAllNodesWithText("原片段不可用或已归档；固定引用保留。").assertCountEquals(2)
 }
 @Test fun switchingSessionDuringDelayedPollCannotApplyTheOldSessionResponse(){
  multipleSessions=true;processingRunning=true;delayOldPoll=true;showDetail()
  compose.waitUntil(15000){delayedReadStarted.get()};click("Other meeting fixture");await("Other recording summary fixture")
  releaseDelayed.countDown();compose.waitUntil(15000){delayedReadFinished.get()};compose.waitForIdle()
  compose.onNodeWithText("Other recording summary fixture").assertExists();compose.onNodeWithText("Recording summary fixture").assertDoesNotExist()
 }
 @Test fun pollingRefreshesEveryLoadedPageWithoutFetchingUnknownThirdPage(){
  processingRunning=true;thirdPageExists=true;showDetail();click("加载更多会议片段");await("Second page original fixture")
  secondPageUpdated=true;processingRunning=false;processingReady=true
  await("Second page updated fixture");compose.onNodeWithText("Second page original fixture").assertDoesNotExist()
  assertTrue(reads.count{it.contains("cursor=1")}>=2);assertFalse(reads.any{it.contains("cursor=2")});compose.onNodeWithText("加载更多会议片段").assertExists()
 }
 @Test fun segmentPreviewResolvesOriginalFilenameWithAuthorizedFileIdQuery(){
  availableSegment=true;showDetail();click("读取第 1 段原文件");await("原文件：meeting-original.mp3")
  assertTrue(reads.any{it.contains("/files?fileId=$file&limit=1")});compose.onNodeWithText("下载并原生预览").assertExists();assertTrue(writes.isEmpty())
 }
 @Test fun deniedRefreshClearsCloudSummaryAndDisablesRetry(){
  showDetail();failedRead=403;click("刷新会议录制");await("录制访问权限已变化，服务端内容已清除。")
  compose.onNodeWithText("Recording summary fixture").assertDoesNotExist();compose.onNodeWithText("重试会议处理").assertDoesNotExist();assertTrue(writes.isEmpty())
 }
 @Test fun temporaryNetworkErrorRetainsClearlyMarkedSnapshot(){
  showDetail();failedRead=503;click("刷新会议录制");await("当前显示上次读取的录制快照；网络读取失败，请刷新核对状态。")
  compose.onNodeWithText("Recording summary fixture").assertExists();compose.onNodeWithText("重试会议处理").assertIsNotEnabled();assertTrue(writes.isEmpty())
 }
 @Test fun retryRequiresConfirmationAndMakesOnlyOneExplicitRequest(){
  showDetail();click("重试会议处理");assertTrue(writes.isEmpty());compose.onNodeWithText("确认重试").performClick()
  compose.waitUntil(15000){writes.any{it.first.endsWith("/retry")}};assertEquals(1,writes.count{it.first.endsWith("/retry")});assertTrue(reads.count{it.startsWith("$base/$session?")}>=2)
 }
 @Test fun retryPermissionFailureRemovesPreviouslyLoadedCloudData(){
  showDetail();failedRetry=403;click("重试会议处理");compose.onNodeWithText("确认重试").performClick();await("录制访问权限已变化，服务端内容已清除。")
  compose.onNodeWithText("Recording summary fixture").assertDoesNotExist();assertEquals(1,writes.count{it.first.endsWith("/retry")})
 }
}

package cn.buwei.nativeapp.features

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.closeSoftKeyboard
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

/** Tests use only loopback, covering real production contract paths and no implicit model writes. */
class DataWorkspaceTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer
 private lateinit var repository:ClientRepository
 private lateinit var context:Context
 private val project="11111111-1111-4111-8111-111111111111"
 private val material="22222222-2222-4222-8222-222222222222"
 private val source="33333333-3333-4333-8333-333333333333"
 private val version="44444444-4444-4444-8444-444444444444"
 private val previous="55555555-5555-4555-8555-555555555555"
 private val file="66666666-6666-4666-8666-666666666666"
 private val user="77777777-7777-4777-8777-777777777777"
 private val calls=ConcurrentLinkedQueue<Pair<String,JsonObject>>()
 private val gets=ConcurrentLinkedQueue<String>()
 private fun reply(data:JsonElement)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
 private fun obj(text:String)=Json.parseToJsonElement(text).jsonObject
 private fun rows(items:List<JsonObject>)=buildJsonObject{put("items",JsonArray(items));put("nextCursor",JsonNull)}
 private fun resource(type:String="material",id:String=material)=buildJsonObject{put("resourceType",type);put("resourceId",id);put("title",if(type=="material")"研究成果"else"来源原文");put("purpose","reference");put("revision",9);put("currentVersionId",version);put("canManage",true);put("lifecycleVersion",5);put("archivedAt",JsonNull);put("deletedAt",JsonNull);put("createdAt","2026-10-19T00:00:00Z");put("updatedAt","2026-10-19T00:00:00Z")}
 private fun materialVersion(id:String=version)=buildJsonObject{put("versionId",id);put("revision",if(id==version)2 else 1);put("markdown",if(id==version)"标题\n新证据\n结尾"else"标题\n旧证据\n结尾");put("attachments",JsonArray(emptyList()));put("createdAt","2026-10-19T00:00:00Z");put("doc",buildJsonObject{put("type","doc");put("content",JsonArray(emptyList()))})}
 private fun sourceRow()=buildJsonObject{put("sourceId",source);put("kind","paste");put("title","来源原文");put("lifecycleVersion",5);put("currentVersionId",version);put("fileId",JsonNull);put("revision",9);put("canDelete",true);put("deletedAt",JsonNull)}
 @Before fun setup(){context=InstrumentationRegistry.getInstrumentation().targetContext;server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
 val route=request.path.orEmpty().substringBefore('?');val method=request.method.orEmpty();val base="/api/v1/projects/$project";val account=buildJsonObject{put("id",user);put("displayName","本机成员");put("role","user")}
 if(route=="/api/v1/auth/native/exchange")return reply(buildJsonObject{put("user",account)}).addHeader("Set-Cookie","ai_office_session=fixture; HttpOnly")
 if(route=="/api/v1/auth/session")return reply(buildJsonObject{put("user",account)})
 if(method=="GET"){gets.add(request.path.orEmpty());return when(route){
 "$base/resource-library"->reply(rows(listOf(resource())))
 "$base/resource-library/material/$material"->reply(resource())
 "$base/resource-library/source/$source"->reply(resource("source",source))
 "$base/materials/$material"->reply(buildJsonObject{put("materialId",material);put("title","研究成果");put("revision",9);put("canEdit",false);put("canArchive",false);put("currentVersion",materialVersion())})
 "$base/materials/$material/versions"->reply(rows(listOf(materialVersion(),materialVersion(previous))))
 "$base/materials/$material/versions/$version"->reply(materialVersion())
 "$base/materials/$material/versions/$previous"->reply(materialVersion(previous))
 "$base/members"->reply(rows(listOf(buildJsonObject{put("userId",user);put("displayName","本机成员")})))
 "$base/sources/$source"->reply(sourceRow())
 "$base/sources/$source/versions/$version"->reply(buildJsonObject{put("sourceVersionId",version);put("sourceId",source);put("revision",1);put("status","pending");put("pages",JsonArray(emptyList()))})
 "$base/sources/$source/versions/$version/processing"->reply(buildJsonObject{put("textStatus","pending");put("requirementsStatus","pending");put("summaryStatus","pending");put("summaryRevision",0)})
 "$base/resource-index/source/$version","$base/resource-index/material/$version"->reply(buildJsonObject{put("indexStatus","ready");put("coverage","complete");put("items",buildJsonArray{add(buildJsonObject{put("sectionId","section-2");put("heading","开题要求");put("pageNumber",2)})});put("nextOffset",JsonNull)})
 "$base/resource-index/source/$version/section","$base/resource-index/material/$version/section"->reply(buildJsonObject{put("text","实际第二页原文，可供核对引用");put("nextOffset",JsonNull)})
 "$base/files"->if(request.path.orEmpty().contains("deleted=true"))reply(rows(listOf(buildJsonObject{put("fileId",file);put("name","保留原件.pdf");put("status","available");put("lifecycleVersion",5);put("canDelete",true);put("deletedAt","2026-10-18T00:00:00Z")})))else reply(rows(emptyList()))
 "$base/sources"->reply(rows(emptyList()))
 else->MockResponse().setResponseCode(404).setBody("Unexpected GET $route")}}
 val body=if(request.body.size>0)obj(request.body.readUtf8())else JsonObject(emptyMap());calls.add(route to body)
 return when{route=="$base/sources"->reply(JsonObject(sourceRow()+("sourceVersionId" to JsonPrimitive(version))));route=="$base/resource-library/material/$material"->reply(resource());route.endsWith("/restore")->reply(buildJsonObject{put("fileId",file);put("lifecycleVersion",6);put("deletedAt",JsonNull);put("affectedSourceIds",JsonArray(emptyList()))});route.endsWith("blank-pages")->reply(buildJsonObject{put("confirmed",1);put("textReady",true)});else->MockResponse().setResponseCode(404).setBody("Unexpected write $route")}
 }};server.start();repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"data-${UUID.randomUUID()}-");runBlocking{repository.exchange("fixture","fixture")}}
 @After fun tearDown(){server.shutdown()}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()}}
 private fun click(text:String){await(text);compose.onNode(hasText(text) and hasClickAction()).performScrollTo().performClick()}
 @Test fun oneNewEntryCreatesPastedSourceWithoutImplicitParse(){compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){DataWorkspace(repository,project)}}};compose.onAllNodes(hasText("新增资料") and hasClickAction()).assertCountEquals(1);click("新增资料");click("新增方式：成果文档");click("粘贴文本");compose.onNode(hasSetTextAction() and hasText("来源原文")).performScrollTo().performTextInput("项目通知真实原文");closeSoftKeyboard();click("确认新增资料");compose.onNodeWithText("确认新增").performClick();compose.waitUntil(10000){calls.any{it.first.endsWith("/sources")}};val create=calls.first{it.first.endsWith("/sources")};assertEquals("paste",create.second.twText("kind"));assertEquals("项目通知真实原文",create.second.twText("text"));assertEquals("reference",create.second.twText("purpose"));assertTrue(calls.none{it.first.endsWith("/parse")||it.first.endsWith("/analyze")})}
 @Test fun purposeChangeUsesResourceRevision(){compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){DataWorkspace(repository,project)}}};click("查看资料");click("修改资料用途：参考资料");click("项目背景");click("保存资料用途");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){calls.isNotEmpty()};val call=calls.first();assertEquals("/api/v1/projects/$project/resource-library/material/$material",call.first);assertEquals(9,call.second["expectedRevision"]!!.jsonPrimitive.int);assertEquals("background",call.second.twText("purpose"))}
 @Test fun recycleRestoreCarriesLifecycleAndDoesNotStartProcessing(){compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceFiles(repository,project,0){}}}};click("文件视图：文件库");click("回收站");click("恢复资料");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){calls.isNotEmpty()};assertEquals("/api/v1/projects/$project/files/$file/restore",calls.first().first);assertEquals(5,calls.first().second["expectedLifecycleVersion"]!!.jsonPrimitive.int);assertEquals(1,calls.size)}
 @Test fun directorySelectionFetchesActualFixedVersionSection(){compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceReference(repository,project,"source",version)}}};click("资料目录、搜索与原文定位");await("第 2 页 · 开题要求");assertTrue(gets.none{it.contains("/section?")});click("第 2 页 · 开题要求");await("实际第二页原文，可供核对引用");assertTrue(gets.any{it.contains("/resource-index/source/$version/section?")&&it.contains("sectionId=section-2")&&it.contains("neighbors=true")});assertTrue(calls.isEmpty())}
 @Test fun versionsCompareImmutableBodiesWithoutWriting(){compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceVersions(repository,project,buildJsonObject{put("materialId",material)})}}};click("历史版本与比较");await("＋ 新证据");compose.onNodeWithText("− 旧证据").assertExists();assertTrue(gets.any{it.contains("/versions/$previous")});assertTrue(gets.any{it.contains("/versions/$version")});assertTrue(calls.isEmpty())}
 @Test fun selectingActualPageConfirmsBlankWithoutOcr(){val versionRow=buildJsonObject{put("pages",buildJsonArray{add(buildJsonObject{put("pageNumber",2);put("textStatus","none");put("ocrStatus","none")})})};compose.setContent{NativeTheme{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){DataWorkspaceScan(repository,project,source,version,file,"保留原件.pdf",versionRow){}}}};click("补充扫描页识别或确认空白");await("第 2 页 · 待提取 · ");compose.onNode(isToggleable()).performScrollTo().performClick();click("确认选定页为空白");compose.onNodeWithText("确认").performClick();compose.waitUntil(10000){calls.isNotEmpty()};assertTrue(calls.first().first.endsWith("/document-imports/blank-pages"));assertEquals(version,calls.first().second.twText("sourceVersionId"));assertEquals(listOf(2),calls.first().second["pages"]!!.jsonArray.map{it.jsonPrimitive.int});assertEquals(1,calls.size)}
}

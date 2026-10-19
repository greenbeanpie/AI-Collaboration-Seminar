package cn.buwei.nativeapp.media
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import cn.buwei.nativeapp.data.ClientRepository
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.*
import org.junit.Assert.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/** Real PDF bytes, loopback authorization and file metadata; no production requests. */
class AttachmentOriginalNameInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private lateinit var server:MockWebServer;private lateinit var repository:ClientRepository
 private val owner=UUID.randomUUID().toString();private val project=UUID.randomUUID().toString();private val file=UUID.randomUUID().toString()
 private val downloads=AtomicInteger();private val metadataReads=AtomicInteger()
 @Volatile private var rejected=0;@Volatile private var wrongId=false
 private fun response(data:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
 @Before fun setup(){
  val context=InstrumentationRegistry.getInstrumentation().targetContext;PDFBoxResourceLoader.init(context)
  val pdf=ByteArrayOutputStream().also{out->PDDocument().use{it.addPage(PDPage());it.save(out)}}.toByteArray()
  val user=buildJsonObject{put("id",owner);put("role","user")}
  server=MockWebServer();server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   val path=request.requestUrl!!.encodedPath
   if(path=="/api/v1/auth/native/exchange")return response(buildJsonObject{put("user",user)}).addHeader("Set-Cookie","ai_office_session=fixture")
   if(path=="/api/v1/auth/session")return response(buildJsonObject{put("user",user)})
   if(path=="/api/v1/projects/$project/files"){
    metadataReads.incrementAndGet();assertEquals(file,request.requestUrl!!.queryParameter("fileId"));assertEquals("1",request.requestUrl!!.queryParameter("limit"))
    if(rejected!=0)return MockResponse().setResponseCode(rejected).setBody("{\"error\":{\"code\":\"FIXTURE\",\"message\":\"Denied fixture\"}}")
    return response(buildJsonObject{put("items",buildJsonArray{add(buildJsonObject{put("fileId",if(wrongId)UUID.randomUUID().toString()else file);put("name","真实手册.pdf");put("status","available")})})})
   }
   if(path=="/api/v1/projects/$project/files/$file/content"){downloads.incrementAndGet();return MockResponse().setHeader("Content-Type","application/pdf").setBody(Buffer().write(pdf))}
   return MockResponse().setResponseCode(404)
  }};server.start();repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"original-name-${UUID.randomUUID()}-");runBlocking{repository.exchange("fixture","fixture")}
 }
 @After fun teardown(){server.shutdown();File(repository.context.filesDir,"accounts/$owner/attachments/$file-真实手册.pdf").delete()}
 private fun await(text:String){compose.waitUntil(15000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
 private fun show(title:String){compose.setContent{NativeTheme{Surface{Column{AttachmentActions(repository,project,file,title,resolveOriginalName=true)}}}}}
 private fun open(){compose.onNodeWithText("下载并原生预览").performClick()}
 private fun assertPdf(){await("1 / 1");compose.onNodeWithContentDescription("文件预览").assertExists();assertTrue(File(repository.context.filesDir,"accounts/$owner/attachments/$file-真实手册.pdf").exists());assertEquals(1,downloads.get());assertEquals(1,metadataReads.get())}
 @Test fun sourceWithoutExtensionOpensActualPdf(){show("会议手册");open();assertPdf()}
 @Test fun misleadingMp3TitleStillOpensActualPdf(){show("错误标题.mp3");open();assertPdf()}
 @Test fun mismatchedFileIdentityNeverDownloads(){wrongId=true;show("错误标题.pdf");open();await("原文件当前不可用");assertEquals(0,downloads.get());compose.onNodeWithText("导出原文件").assertDoesNotExist()}
 @Test fun deniedMetadataRemovesPreviouslyAvailableExportAndNeverRedownloads(){show("会议手册");open();assertPdf();compose.onNodeWithText("关闭预览").performClick();compose.onNodeWithText("导出原文件").assertExists();rejected=403;open();await("Denied fixture");assertEquals(1,downloads.get());compose.onNodeWithText("导出原文件").assertDoesNotExist();compose.onNodeWithText("1 / 1").assertDoesNotExist()}
}

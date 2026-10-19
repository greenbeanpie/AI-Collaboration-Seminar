package cn.buwei.nativeapp.media

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import cn.buwei.nativeapp.data.ClientRepository
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class DerivedUploadsInstrumentedTest {
    private class Fixture:AutoCloseable {
        val context=ApplicationProvider.getApplicationContext<android.content.Context>()
        val owner=UUID.randomUUID().toString();val project=UUID.randomUUID().toString()
        val parent=UUID.randomUUID().toString();val other=UUID.randomUUID().toString()
        val source=UUID.randomUUID().toString();val version=UUID.randomUUID().toString()
        val calls=CopyOnWriteArrayList<Pair<String,JsonObject>>()
        val initialized=CopyOnWriteArrayList<Pair<String,JsonObject>>()
        val failStatus=AtomicBoolean(false);val prepared=AtomicBoolean(false)
        var versionFile:String?=parent
        val server=MockWebServer()
        val repository:ClientRepository
        private fun data(body:JsonObject)=MockResponse().setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",body)}.toString())
        init {
            server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
                val path=request.requestUrl!!.encodedPath.removePrefix("/api/v1")
                val body=request.body.readUtf8().let{if(it.isBlank())JsonObject(emptyMap())else Json.parseToJsonElement(it).jsonObject}
                calls.add("${request.method} $path" to body)
                return when {
                    path=="/auth/native/exchange"||path=="/auth/session"->data(buildJsonObject{put("user",buildJsonObject{put("id",owner);put("displayName","Fixture");put("role","user");put("isAdmin",false)})}).setHeader("Set-Cookie","ai_office_session=fixture; Path=/; HttpOnly")
                    path=="/projects/$project/sources/$source"->data(buildJsonObject{put("fileId",parent);put("lifecycleVersion",1);put("currentVersionId",version);put("deletedAt",JsonNull)})
                    path.endsWith("/versions/$version")->data(buildJsonObject{put("sourceId",source);put("sourceVersionId",version);put("fileId",versionFile?.let(::JsonPrimitive)?:JsonNull)})
                    path=="/capabilities"->data(buildJsonObject{put("limits",buildJsonObject{put("pageImageMaxEdge",64);put("pageImageMaxBytes",2000);put("maxPdfPages",JsonNull)})})
                    path.endsWith("/render-requests")->data(buildJsonObject{put("items",buildJsonArray{if(!prepared.get())add(buildJsonObject{put("pageNumber",1)})})})
                    request.method=="POST"&&path=="/projects/$project/files"->{val id=UUID.randomUUID().toString();initialized.add(id to body);data(buildJsonObject{put("fileId",id)})}
                    request.method=="POST"&&path.endsWith("/uploads")->data(buildJsonObject{put("sessionId","fixture");put("partBytes",1024)})
                    request.method=="GET"&&path.endsWith("/uploads/fixture")->if(failStatus.getAndSet(false))MockResponse().setResponseCode(503).setBody("fixture transport interruption")else data(buildJsonObject{put("status","complete")})
                    request.method=="POST"&&path.endsWith("/page-images/prepare")->{prepared.set(true);data(buildJsonObject{put("accepted",1);put("jobId",JsonNull)})}
                    else->MockResponse().setResponseCode(500).setBody("Unexpected request ${request.method} $path")
                }
            }}
            server.start()
            repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"derived-${UUID.randomUUID()}-")
        }
        suspend fun login(){repository.exchange("fixture","fixture")}
        fun pdf():File {
            PDFBoxResourceLoader.init(context)
            val file=File.createTempFile("derived-", ".pdf",context.cacheDir)
            PDDocument().use{it.addPage(PDPage(PDRectangle(100f,100f)));it.save(file)}
            return file
        }
        override fun close(){server.shutdown();File(context.filesDir,"accounts/$owner").deleteRecursively()}
    }
    @Test fun interruptedUploadReusesItsParentButSameBytesForAnotherParentAndOrdinaryAreSeparate()=runBlocking {
        Fixture().use {f->f.login();val file=File.createTempFile("derived-", ".jpg",f.context.cacheDir).apply{writeBytes(byteArrayOf(1,2,3))}
            try {
                val transfer=AttachmentTransfer(f.repository);f.failStatus.set(true)
                assertTrue(runCatching{transfer.upload(f.project,file,{},"reference",null,f.parent)}.isFailure)
                val first=transfer.upload(f.project,file,{},"reference",null,f.parent)
                assertEquals(f.initialized.single().first,first)
                val second=transfer.upload(f.project,file,{},"reference",null,f.other)
                val ordinary=transfer.upload(f.project,file,{})
                assertEquals(first,transfer.upload(f.project,file,{},"reference",null,f.parent))
                assertEquals(3,setOf(first,second,ordinary).size);assertEquals(3,f.initialized.size)
                assertEquals(listOf(f.parent,f.other,null),f.initialized.map{it.second["derivedFromFileId"]?.jsonPrimitive?.contentOrNull})
                assertTrue(f.initialized.all{it.second["contributorIds"]==null})
            } finally{file.delete()}
        }
    }
    @Test fun contributorOverrideIsRejectedBeforeAnyNetworkRequest()=runBlocking {
        Fixture().use{f->f.login();val count=f.calls.size;val file=File.createTempFile("derived-", ".jpg",f.context.cacheDir)
            try {assertTrue(runCatching{AttachmentTransfer(f.repository).upload(f.project,file,{},"reference",listOf(f.owner),f.parent)}.exceptionOrNull() is IllegalArgumentException);assertEquals(count,f.calls.size)}finally{file.delete()}
        }
    }
    @Test fun prepareUploadsOnlyDerivedImageAndRegistersWithoutModelJob()=runBlocking {
        Fixture().use{f->f.login();val pdf=f.pdf()
            try {
                uploadMissingPdfImages(f.repository,f.project,f.source,f.version,pdf,{},f.parent)
                assertEquals(f.parent,f.initialized.single().second["derivedFromFileId"]!!.jsonPrimitive.content)
                val writes=f.calls.filter{it.first.startsWith("POST ")&&!it.first.contains("/auth/")}
                assertEquals(3,writes.size)
                assertTrue(writes[0].first.endsWith("/files"));assertTrue(writes[1].first.endsWith("/uploads"))
                val registration=writes[2];assertTrue(registration.first.endsWith("/page-images/prepare"))
                assertEquals(false,registration.second["analyze"]!!.jsonPrimitive.boolean)
                assertEquals(f.version,registration.second["sourceVersionId"]!!.jsonPrimitive.content)
                assertEquals(f.initialized.single().first,registration.second["images"]!!.jsonArray.single().jsonObject["fileId"]!!.jsonPrimitive.content)
                assertEquals(1,registration.second["expectedLifecycleVersion"]!!.jsonPrimitive.int)
                assertFalse(f.calls.any{it.first.contains("/jobs")||it.first.endsWith("/page-images")})
            }finally{pdf.delete()}
        }
    }
    @Test fun mismatchedVersionFileStopsBeforeImageUploadOrRegistration()=runBlocking {
        Fixture().use{f->f.login();val pdf=f.pdf();f.versionFile=f.other
            try {assertTrue(runCatching{uploadMissingPdfImages(f.repository,f.project,f.source,f.version,pdf,{},f.parent)}.exceptionOrNull() is IllegalStateException);assertTrue(f.initialized.isEmpty());assertFalse(f.prepared.get());assertFalse(f.calls.any{it.first=="GET /capabilities"})}finally{pdf.delete()}
        }
    }
}

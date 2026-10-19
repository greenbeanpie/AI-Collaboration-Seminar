package cn.buwei.nativeapp.features

import android.graphics.Bitmap
import androidx.test.core.app.ApplicationProvider
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

class SupportWorkspaceImageInstrumentedTest {
 @Test fun immutableImageIdAndPrivateTicketRoutePreserveOriginalBytes()=runBlocking {
  val server=MockWebServer();server.start();val user=UUID.randomUUID().toString();val ticket=UUID.randomUUID().toString();val id=UUID.randomUUID().toString()
  server.enqueue(MockResponse().setHeader("Content-Type","application/json").setHeader("Set-Cookie","ai_office_session=fixture").setBody("""{"data":{"user":{"id":"$user","displayName":"Fixture","isAdmin":false,"role":"user"}}}"""))
  val context=ApplicationProvider.getApplicationContext<android.content.Context>();val repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"support-${UUID.randomUUID()}-");val file=File(context.filesDir,"accounts/$user/support-images/$id.png");file.parentFile!!.mkdirs()
  try{repository.exchange("fixture","fixture");server.takeRequest();val bitmap=Bitmap.createBitmap(12,12,Bitmap.Config.ARGB_8888);file.outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle();server.enqueue(MockResponse().setBody("{}"))
   supportUploadImage(repository,ticket,buildJsonObject{put("id",id);put("file",file.path);put("type","image/png")},user,repository.epoch)
   val request=server.takeRequest();assertEquals("/api/v1/support/tickets/$ticket/images/$id",request.path);assertEquals("PUT",request.method);assertEquals("image/png",request.getHeader("Content-Type"));assertArrayEquals(file.readBytes(),request.body.readByteArray());assertTrue(repository.pending().isEmpty())
  }finally{file.delete();server.shutdown()}
 }
}

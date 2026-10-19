package cn.buwei.nativeapp.features

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.UUID

internal val supportStatuses=listOf("pending" to "待处理","in_progress" to "处理中","waiting_user" to "待用户回复","resolved" to "已解决","closed" to "已关闭")
internal val supportUrgencies=listOf("low" to "低","normal" to "普通","high" to "高","urgent" to "紧急")
internal val supportCategories=listOf("interface" to "界面","functionality" to "功能","account" to "账户","performance" to "性能","other" to "其他")
internal fun supportCreateBody(title:String,body:String,urgency:String,category:String):JsonObject {
 require(title.trim().length in 1..160&&body.trim().length in 1..8000){"标题需1–160字，描述需1–8000字"};require(supportUrgencies.any{it.first==urgency}&&supportCategories.any{it.first==category})
 return buildJsonObject{put("title",title.trim());put("body",body.trim());put("urgency",urgency);put("category",category)}
}
internal suspend fun supportStageImage(repository:ClientRepository,uri:Uri,owner:String,epoch:Long):JsonObject=withContext(Dispatchers.IO){
 check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
 val type=repository.context.contentResolver.getType(uri);require(type in listOf("image/png","image/jpeg","image/webp")){"仅支持 PNG、JPEG 或静态 WebP 图片"}
 val id=UUID.randomUUID().toString();val directory=File(repository.context.filesDir,"accounts/$owner/support-images").apply{mkdirs()};val file=File(directory,"$id."+when(type){"image/png"->"png";"image/jpeg"->"jpg";else->"webp"});val temporary=File(file.path+".partial")
 try{repository.context.contentResolver.openInputStream(uri)!!.use{input->temporary.outputStream().use{output->val buffer=ByteArray(65536);var size=0;while(true){ensureActive();val n=input.read(buffer);if(n<0)break;size+=n;require(size<=5*1024*1024){"每张图片不得超过5 MiB"};output.write(buffer,0,n)};require(size>0){"图片为空"}}};val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeFile(temporary.path,bounds);require(bounds.outWidth in 1..12000&&bounds.outHeight in 1..12000&&bounds.outWidth.toLong()*bounds.outHeight<=40_000_000){"图片尺寸过大或内容无效"};check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};check(temporary.renameTo(file));buildJsonObject{put("id",id);put("file",file.path);put("type",type);put("state","selected")}}finally{temporary.delete()}
}
internal suspend fun supportUploadImage(repository:ClientRepository,ticketId:String,image:JsonObject,owner:String,epoch:Long)=withContext(Dispatchers.IO){
 val allowed=File(repository.context.filesDir,"accounts/$owner/support-images").canonicalFile;val file=File(image.text("file")).canonicalFile;require(file.parentFile==allowed&&file.length() in 1..5L*1024*1024){"本机原图不存在或超出大小限制"}
 repository.execute("PUT","/api/v1/support/tickets/$ticketId/images/${image.text("id")}",file.readBytes().toRequestBody(image.text("type").toMediaType()),expectedOwner=owner,expectedEpoch=epoch).use{check(it.isSuccessful){"图片上传失败 (${it.code})，原图片与固定标识已保留，可显式重试"}}
}
@Composable internal fun SupportWorkspaceImage(repository:ClientRepository,ticketId:String,image:JsonObject){
 var bitmap by remember(ticketId,image.text("id")){mutableStateOf<android.graphics.Bitmap?>(null)};var error by remember{mutableStateOf<String?>(null)};var opened by remember{mutableStateOf(false)};var busy by remember{mutableStateOf(false)};val scope=rememberCoroutineScope()
 TextButton({busy=true;scope.launch{try{val owner=repository.accountId?:error("请登录");val file=File(repository.context.filesDir,"accounts/$owner/support-images/view-${image.text("id")}."+when(image.text("contentType")){"image/png"->"png";"image/jpeg"->"jpg";else->"webp"});repository.download("/api/v1/support/tickets/$ticketId/images/${image.text("id")}",file);bitmap=withContext(Dispatchers.IO){val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeFile(file.path,bounds);require(bounds.outWidth>0&&bounds.outHeight>0);val options=BitmapFactory.Options();while(bounds.outWidth/options.inSampleSize.coerceAtLeast(1)>1600||bounds.outHeight/options.inSampleSize.coerceAtLeast(1)>1600)options.inSampleSize=options.inSampleSize.coerceAtLeast(1)*2;BitmapFactory.decodeFile(file.path,options)};opened=true}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text(if(busy)"读取图片中"else"查看工单图片（${image.text("sizeBytes")}字节）")}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(opened)AlertDialog(onDismissRequest={opened=false},title={Text("工单图片")},text={bitmap?.let{Image(it.asImageBitmap(),"工单附件",Modifier.fillMaxWidth().heightIn(max=480.dp))}},confirmButton={TextButton({opened=false}){Text("关闭")}})
 DisposableEffect(bitmap){val held=bitmap;onDispose{held?.recycle()}}
}

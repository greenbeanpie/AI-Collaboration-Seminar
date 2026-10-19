package cn.buwei.nativeapp.media

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

@Composable fun AttachmentActions(repository:ClientRepository,projectId:String,fileId:String,fileName:String,resolveOriginalName:Boolean=false) {
    val account by repository.account.collectAsState()
    key(account?.get("id")?.jsonPrimitive?.contentOrNull,repository.epoch,projectId,fileId,fileName,resolveOriginalName){AttachmentActionsContent(repository,projectId,fileId,fileName,resolveOriginalName)}
}
@Composable private fun AttachmentActionsContent(repository:ClientRepository,projectId:String,fileId:String,fileName:String,resolveOriginalName:Boolean) {
    val context=LocalContext.current;val scope=rememberCoroutineScope();val owner=repository.accountId;val epoch=repository.epoch
    fun owned(){check(owner!=null&&owner==repository.accountId&&epoch==repository.epoch){"账户上下文已变化，操作已停止"}}
    var busy by remember {mutableStateOf(false)};var error by remember {mutableStateOf<String?>(null)};var preview by remember {mutableStateOf<File?>(null)}
    var cached by remember {mutableStateOf<File?>(null)}
    OutlinedButton(onClick={scope.launch {
        busy=true;error=null;cached=null;preview=null
        try {
            owned();repository.validateSession();owned()
            val originalName=if(resolveOriginalName){
                val page=repository.networkJson("GET","/projects/${Uri.encode(projectId)}/files?fileId=${Uri.encode(fileId)}&limit=1",expectedOwner=owner,expectedEpoch=epoch)
                owned()
                val row=(page["items"] as? JsonArray)?.mapNotNull{it as? JsonObject}?.singleOrNull{it["fileId"]?.jsonPrimitive?.contentOrNull==fileId}?:error("原文件当前不可用")
                check(row["status"]?.jsonPrimitive?.contentOrNull=="available"&&row["deletedAt"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()&&row["archivedAt"]?.jsonPrimitive?.contentOrNull.isNullOrBlank()){"原文件不可用或已归档"}
                row["name"]?.jsonPrimitive?.contentOrNull?.takeIf{it.isNotBlank()}?:error("服务端未提供原文件名称")
            }else fileName
            val safe=attachmentLocalName(originalName,fileId)
            val destination=File(context.filesDir,"accounts/$owner/attachments/$fileId-$safe")
            owned();repository.download("/projects/${Uri.encode(projectId)}/files/${Uri.encode(fileId)}/content",destination);owned()
            cached=destination;preview=destination
        } catch(e:Exception){if(e is CancellationException)throw e;error=e.message}finally{busy=false}
    }},enabled=!busy){Text(if(busy)"正在读取原文件"else"下载并原生预览")}
    cached?.let {file->TextButton(onClick={try{owned();val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",file);context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"导出原文件"))}catch(e:Exception){cached=null;preview=null;error=e.message}}){Text("导出原文件")}}
    error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
    preview?.let {NativeFilePreview(repository,it){preview=null}}
}

/** Keep the real extension and stay below the filesystem byte limit even for CJK names. */
internal fun attachmentLocalName(name:String,fallback:String):String {
    val safe=name.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").trim().ifBlank{fallback}
    val split=safe.lastIndexOf('.')
    val extension=if(split>0&&safe.substring(split).toByteArray(Charsets.UTF_8).size<=24)safe.substring(split)else ""
    val stem=if(extension.isEmpty())safe else safe.substring(0,split)
    val budget=180-extension.toByteArray(Charsets.UTF_8).size
    val bounded=buildString{for(codepoint in stem.codePoints().toArray()){val next=String(Character.toChars(codepoint));if((toString()+next).toByteArray(Charsets.UTF_8).size>budget)break;append(next)}}
    return bounded+extension
}

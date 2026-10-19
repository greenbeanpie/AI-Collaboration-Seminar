package cn.buwei.nativeapp.media

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.FileProvider
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import java.io.File

@Composable fun AttachmentActions(repository:ClientRepository,projectId:String,fileId:String,fileName:String) {
    val context=LocalContext.current;val scope=rememberCoroutineScope()
    var busy by remember {mutableStateOf(false)};var error by remember {mutableStateOf<String?>(null)};var preview by remember {mutableStateOf<File?>(null)}
    var cached by remember {mutableStateOf<File?>(null)}
    OutlinedButton(onClick={scope.launch {
        busy=true
        try {
            val account=repository.accountId?:error("请登录")
            repository.validateSession()
            val safe=fileName.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").take(180).ifBlank {fileId}
            val destination=File(context.filesDir,"accounts/$account/attachments/$fileId-$safe")
            repository.download("/projects/$projectId/files/$fileId/content",destination)
            cached=destination;preview=destination
        } catch(e:Exception){if(e is CancellationException)throw e;error=e.message}finally{busy=false}
    }},enabled=!busy){Text(if(busy)"正在读取原文件"else"下载并原生预览")}
    cached?.let {file->TextButton(onClick={val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",file);context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"导出原文件"))}){Text("导出原文件")}}
    error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
    preview?.let {NativeFilePreview(repository,it){preview=null}}
}

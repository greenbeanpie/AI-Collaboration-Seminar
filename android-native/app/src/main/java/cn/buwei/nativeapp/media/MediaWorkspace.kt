package cn.buwei.nativeapp.media

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.graphics.createBitmap
import cn.buwei.mobile.RecordingService
import cn.buwei.mobile.RecordingStore
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.json.JSONObject
import java.io.File
import java.util.UUID

@Composable fun MediaWorkspace(repository:ClientRepository,projectId:String?,onActivityChange:(Boolean)->Unit = {}) {
    val context=LocalContext.current;val scope=rememberCoroutineScope()
    val owner=repository.accountId?:return
    val epoch=remember(owner){repository.epoch}
    fun assertOwner(){check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化，请重新打开录制与文件"}}
    val root=File(context.filesDir,"accounts/$owner/attachments").apply {mkdirs()}
    var files by remember {mutableStateOf(root.listFiles()?.filter {it.isFile&&!it.name.endsWith(".partial")}.orEmpty())}
    var selected by remember {mutableStateOf<File?>(null)}
    var progress by remember {mutableStateOf("")};var busy by remember {mutableStateOf(false)}
    var permissionKind by remember {mutableStateOf("audio")}
    var microphone by remember {mutableStateOf("")};var camera by remember {mutableStateOf("")}
    var drafts by remember {mutableStateOf<List<File>>(emptyList())}
    var running by remember {mutableStateOf(RecordingService.instance!=null)}
    val activityCallback by rememberUpdatedState(onActivityChange)
    LaunchedEffect(running,busy){activityCallback(running||busy)}
    DisposableEffect(Unit){onDispose{activityCallback(false)}}
    fun reload() { files=root.listFiles()?.filter {it.isFile&&!it.name.endsWith(".partial")}.orEmpty();drafts=File(context.dataDir,"recordings/$owner").listFiles()?.filter {File(it,"manifest.json").isFile}.orEmpty() }
    fun startRecording(kind:String) {
        if(repository.accountId!=owner||repository.epoch!=epoch){progress="账户已变化，请重新打开录制与文件";return}
        if(projectId==null){progress="请先打开项目再录制";return}
        val args=JSONObject().put("root",File(context.dataDir,"recordings").absolutePath).put("accountId",owner).put("id",UUID.randomUUID().toString()).put("projectId",projectId).put("kind",kind).put("accountEpoch",repository.epoch)
        if(microphone.isNotBlank())args.put("inputDeviceId",microphone)
        if(camera.isNotBlank())args.put("cameraDeviceId",camera)
        ContextCompat.startForegroundService(context,Intent(context,RecordingService::class.java).putExtra("args",args.toString()));running=true
    }
    val permissions=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted->
        if(granted.values.all {it}) startRecording(permissionKind) else progress="录制权限未获允许，可继续导入已有文件"
    }
    val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {uri->if(uri!=null) scope.launch {
        busy=true
        try {
            assertOwner()
            val name=context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use {if(it.moveToFirst())it.getString(0) else null}?:"附件"
            val safeName=name.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").take(180)
            val destination=File(root,UUID.randomUUID().toString().take(8)+"-"+safeName)
            withContext(Dispatchers.IO) {
                val temporary=File(destination.path+".partial")
                try {
                    context.contentResolver.openInputStream(uri)?.use {input->temporary.outputStream().use {out->val buffer=ByteArray(65536);while(true){ensureActive();assertOwner();val count=input.read(buffer);if(count<0)break;check(temporary.length()+count<=512L*1024*1024){"文件超过本机导入上限 512 MiB"};check(android.os.StatFs(root.path).availableBytes>64L*1024*1024){"本机剩余存储不足"};out.write(buffer,0,count)}}}?:error("无法读取文件")
                    ensureActive();assertOwner()
                    check(temporary.renameTo(destination)){"本机文件保存失败"}
                } finally {temporary.delete()}
            }
            reload();selected=destination;progress="已保存本机，请预览后确认上传"
        } catch(e:Exception){if(e is CancellationException)throw e;progress=e.message?:"文件读取失败"}finally{busy=false}
    } }
    LaunchedEffect(owner) {reload();while(true){delay(1000);running=RecordingService.instance!=null;if(!running)reload()} }
    Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("录制与文件",style=MaterialTheme.typography.headlineMedium)
        Text("文件先保存在当前账户的本机空间；预览确认后上传。",style=MaterialTheme.typography.bodyMedium)
        if(projectId==null)Text("打开项目后可上传或录制。")
        Button(onClick={picker.launch(arrayOf("*/*"))},enabled=!busy){Text("新增资料 · 选择文件")}
        val paused=RecordingService.instance?.store?.view()?.optString("state")=="paused"
        val microphones=remember { (context.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager).getDevices(android.media.AudioManager.GET_DEVICES_INPUTS).map {it.id.toString() to it.productName.toString()} }
        val cameras=remember {val manager=context.getSystemService(android.content.Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager;manager.cameraIdList.map {id->id to (if(manager.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)==android.hardware.camera2.CameraCharacteristics.LENS_FACING_FRONT)"前置摄像头" else "后置 / 外接摄像头")}}
        DevicePicker("麦克风",microphone,microphones,!running||paused){microphone=it}
        DevicePicker("摄像头",camera,cameras,!running||paused){camera=it}
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            listOf("audio" to "录音","video" to "录像","photo" to "拍照").forEach {(kind,title)->OutlinedButton(onClick={permissionKind=kind;val needed=buildList{if(kind!="photo")add(Manifest.permission.RECORD_AUDIO);if(kind!="audio")add(Manifest.permission.CAMERA)};if(needed.all {ContextCompat.checkSelfPermission(context,it)==PackageManager.PERMISSION_GRANTED})startRecording(kind) else permissions.launch(needed.toTypedArray())},enabled=!running&&!busy&&projectId!=null){Text(title)}}
        }
        if(running) {
            Text("正在录制；可锁屏继续。停止后检查片段再上传。")
            Row {TextButton(onClick={RecordingService.instance?.store?.view()?.getString("id")?.let {RecordingService.instance?.action(it,"pause",JSONObject())}}){Text("暂停")};TextButton(onClick={RecordingService.instance?.store?.view()?.getString("id")?.let {val args=JSONObject();if(microphone.isNotBlank())args.put("inputDeviceId",microphone);if(camera.isNotBlank())args.put("cameraDeviceId",camera);RecordingService.instance?.action(it,"resume",args)}},enabled=paused){Text("继续")};TextButton(onClick={context.startService(Intent(context,RecordingService::class.java).setAction("stop"))}){Text("停止并保存")}}
        }
        if(progress.isNotBlank())Text(progress)
        if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        selected?.let {file->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            Text(file.name);Text("${file.length()/1024} KiB")
            Text("上传后可能按项目配置自动处理正文、转写或生成总结，并产生 AI 费用。请预览后再确认上传。",style=MaterialTheme.typography.bodySmall)
            TextButton(onClick={selected=file;progress="预览 ${file.name}"}){Text("原生预览")}
            if(projectId!=null)Button(onClick={scope.launch {busy=true;try{val id=AttachmentTransfer(repository).upload(projectId,file){progress=it};progress="已上传文件：$id"}catch(e:Exception){if(e is CancellationException)throw e;progress=e.message?:"上传失败"}finally{busy=false}}},enabled=!busy){Text("确认上传原文件")}
            if(projectId!=null&&file.extension.lowercase() in listOf("pdf","docx","xlsx","pptx"))OutlinedButton(onClick={scope.launch {busy=true;try{val result=AttachmentTransfer(repository).importDocument(projectId,file){progress=it};progress="正文导入完成：$result"}catch(e:Exception){if(e is CancellationException)throw e;progress=e.message?:"导入失败"}finally{busy=false}}},enabled=!busy){Text("确认上传并导入正文")}
            TextButton(onClick={scope.launch {try {val exported=withContext(Dispatchers.IO){val target=File(context.cacheDir,"exports/$owner/${file.name}");target.parentFile?.mkdirs();file.inputStream().use {input->target.outputStream().use {out->input.copyTo(out,65536)}};check(repository.accountId==owner){"账户已变化"};target};val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",exported);context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("application/octet-stream").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"导出文件"))}catch(e:Exception){if(e is CancellationException)throw e;progress=e.message?:"文件导出失败"}}}){Text("导出本机文件")}
        }}}
        files.forEach {file->TextButton(onClick={selected=file}){Text(file.name)}}
        Text("录制草稿",style=MaterialTheme.typography.titleLarge)
        drafts.forEach {directory->
            val store=remember(directory.path) {RecordingStore(context,File(context.dataDir,"recordings").path,owner,directory.name)}
            val manifest=if(!running)store.recover() else store.view()
            Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){
                Text("${manifest.optString("kind")} · ${manifest.optString("state")} · ${manifest.optLong("elapsedMs")/1000} 秒")
                manifest.optString("error").takeIf {it.isNotBlank()}?.let {Text(it)}
                val pieces=directory.listFiles()?.filter {it.extension in listOf("mp4","m4a","jpg")}.orEmpty()
                pieces.forEach {file->TextButton(onClick={selected=file}){Text("预览 / 导出 ${file.name}")}}
                directory.listFiles()?.filter {it.name.endsWith(".partial")}?.forEach {tail->TextButton(onClick={selected=tail;progress="此尾段可能未完成封装，请导出检查；原始文件继续保留"}){Text("导出中断尾段 ${tail.name}")}}
                if(!running&&projectId==manifest.optString("projectId"))Button(onClick={scope.launch {busy=true;try{uploadRecording(repository,projectId,store){progress=it};progress="录制已上传，后续处理状态请查看资料"}catch(e:Exception){if(e is CancellationException)throw e;progress=e.message?:"录制上传失败"}finally{busy=false}}},enabled=!busy&&pieces.isNotEmpty()){Text("确认上传整次录制")}
            }}
        }
    }
    // Separate preview state prevents selecting a file from reopening the dialog after dismissal.
    var preview by remember {mutableStateOf<File?>(null)}
    LaunchedEffect(progress) {if(progress.startsWith("预览 "))preview=selected}
    preview?.let {file->NativeFilePreview(repository,file){preview=null;progress=""}}
}

@Composable private fun DevicePicker(title:String,selected:String,choices:List<Pair<String,String>>,enabled:Boolean,onSelect:(String)->Unit) {
    var expanded by remember {mutableStateOf(false)}
    Box {TextButton(onClick={expanded=true},enabled=enabled){Text("$title："+(choices.firstOrNull {it.first==selected}?.second?:"系统默认"))};DropdownMenu(expanded,onDismissRequest={expanded=false}){DropdownMenuItem(text={Text("系统默认")},onClick={onSelect("");expanded=false});choices.forEach {(id,name)->DropdownMenuItem(text={Text(name)},onClick={onSelect(id);expanded=false})}}}
}

private suspend fun uploadRecording(repository:ClientRepository,project:String,store:RecordingStore,onProgress:(String)->Unit) {
    val data=store.view();check(data.optString("state") !in listOf("recording","paused")){"请先停止录制"}
    val account=repository.accountId;val epoch=repository.epoch
    val session=repository.networkJson("POST","/projects/$project/recording-sessions",buildJsonObject{put("clientSessionId",data.getString("id"));put("title","会议录制 ${data.optString("createdAt")}");put("kind",data.getString("kind"))})
    val path="/projects/$project/recording-sessions/${session["sessionId"]!!.jsonPrimitive.content}"
    val segments=data.getJSONArray("segments")
    val interruptions=repository.json.parseToJsonElement(data.optJSONArray("interruptions")?.toString()?:"[]")
    for(i in 0 until segments.length()) {
        check(account==repository.accountId&&epoch==repository.epoch){"账户已变化"}
        val segment=segments.getJSONObject(i);val name=segment.getString("name");check(File(name).name==name)
        val fileId=AttachmentTransfer(repository).upload(project,File(store.directory,name),onProgress)
        repository.networkJson("PUT","$path/segments/${segment.getInt("sequence")}",buildJsonObject{put("fileId",fileId);put("startMs",segment.getLong("startMs"));put("endMs",segment.getLong("endMs"));put("sha256",segment.getString("sha256"));put("interruptions",interruptions)})
    }
    repository.networkJson("POST","$path/complete",buildJsonObject{put("segmentCount",segments.length());put("interruptions",interruptions)})
}

@Composable fun NativeFilePreview(repository:ClientRepository,file:File,onDismiss:()->Unit) {
    var page by remember {mutableIntStateOf(0)};var pages by remember {mutableIntStateOf(0)}
    var bitmap by remember {mutableStateOf<Bitmap?>(null)};var text by remember {mutableStateOf("")};var error by remember {mutableStateOf<String?>(null)}
    val context=LocalContext.current
    LaunchedEffect(file,page) {try {withContext(Dispatchers.IO) {
        if(file.extension.equals("pdf",true))ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY).use {fd->PdfRenderer(fd).use {renderer->pages=renderer.pageCount;renderer.openPage(page).use {p->val scale=minOf(1.8f,1500f/maxOf(p.width,p.height));val image=createBitmap((p.width*scale).toInt().coerceAtLeast(1),(p.height*scale).toInt().coerceAtLeast(1),Bitmap.Config.ARGB_8888);image.eraseColor(android.graphics.Color.WHITE);p.render(image,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);bitmap=image}}}
        else if(file.extension.lowercase() in listOf("docx","xlsx","pptx","md","txt","csv")) {val output=StringBuilder();DocumentReader.read(context,file){block->if(output.length<500000)output.append(block.text).append('\n')};text=output.toString()}
        else if(file.extension.lowercase() in listOf("jpg","jpeg","png","webp")){val opts=android.graphics.BitmapFactory.Options().apply {inJustDecodeBounds=true};android.graphics.BitmapFactory.decodeFile(file.path,opts);opts.inSampleSize=maxOf(1,maxOf(opts.outWidth,opts.outHeight)/1500);opts.inJustDecodeBounds=false;bitmap=android.graphics.BitmapFactory.decodeFile(file.path,opts)}
    }}catch(e:Exception){if(e is CancellationException)throw e;error=e.message} }
    Dialog(onDismiss,properties=DialogProperties(usePlatformDefaultWidth=false)){Surface(Modifier.fillMaxSize()){Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp)){
        TextButton(onClick=onDismiss){Text("关闭预览")};Text(file.name,style=MaterialTheme.typography.titleMedium)
        error?.let {Text(it)}
        if(pages>0)Row {TextButton(onClick={page--},enabled=page>0){Text("上一页")};Text("${page+1} / $pages");TextButton(onClick={page++},enabled=page<pages-1){Text("下一页")}}
        if(file.extension.lowercase() in listOf("mp4","m4a","mp3","wav","webm")) {
            NativeMediaPlayer(file)
        } else Column(Modifier.weight(1f).verticalScroll(rememberScrollState())){bitmap?.let {Image(it.asImageBitmap(),contentDescription="文件预览",modifier=Modifier.fillMaxWidth())};if(text.isNotBlank())androidx.compose.foundation.text.selection.SelectionContainer {Text(text)}}
    }}}
}

package cn.buwei.nativeapp.features

import android.provider.OpenableColumns
import android.os.StatFs
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.media.AttachmentActions
import cn.buwei.nativeapp.media.AttachmentTransfer
import cn.buwei.nativeapp.media.DocumentReader
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

@Composable internal fun TaskWorkspaceFiles(repository:ClientRepository,project:String,task:String,canUpload:Boolean,onBusy:(Boolean)->Unit={},onChanged:()->Unit={}){
 val owner=repository.accountId;val epoch=repository.epoch;val base=twBase(project);val path="$base/tasks/$task/files";val scope=rememberCoroutineScope();var refresh by remember{mutableIntStateOf(0)};var busy by remember{mutableStateOf(false)};var progress by remember{mutableStateOf("")};var error by remember{mutableStateOf<String?>(null)};var pending by remember{mutableStateOf<File?>(null)};var replacement by remember{mutableStateOf<JsonObject?>(null)};var key by remember{mutableStateOf(UUID.randomUUID().toString())}
 val drafts=remember(repository){NativeDraftStore(repository)};val draftKey="task-file:$project:$task"
 LaunchedEffect(project,task,owner){try{drafts.read(draftKey)?.let{saved->val file=File(saved.twText("path"));val parent=File(repository.context.filesDir,"accounts/$owner/task-uploads/$project/$task").canonicalFile;require(file.canonicalFile.parentFile==parent&&file.isFile){"本机待上传文件缺失，请重新选择"};pending=file;replacement=saved["replace"] as? JsonObject;key=saved.twText("key").ifBlank{key};onBusy(true)}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 fun owned(){check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，任务文件操作已停止"}}
 fun transfer(){val file=pending?:return;busy=true;onBusy(true);scope.launch{try{
  owned();drafts.save(draftKey,buildJsonObject{put("path",file.path);put("replace",replacement?:JsonNull);put("key",key)});val fileId=AttachmentTransfer(repository).upload(project,file,{progress=it},purpose="output");owned();var text:String?=null
  if(file.extension.lowercase() in listOf("pdf","docx","xlsx","pptx","txt","md","csv")){try{val buffer=StringBuilder();val parsed=DocumentReader.read(repository.context,file){block->if(buffer.length+block.text.length+1<=1_000_000){buffer.append(block.text).append('\n')}else error("成果正文超过可提取上限，原文件已保留")};text=buffer.toString().trim();if(parsed.warnings.isNotEmpty())progress=parsed.warnings.joinToString("；")}catch(e:CancellationException){throw e}catch(e:Exception){progress="正文提取未完成：${e.message}。原文件仍会保留，材料检查可能无法读取正文。"}}
  val replace=replacement;repository.requestDurably("task-file-registration:$task:${file.name}",if(replace==null)"POST"else"PUT",path+(replace?.let{"/${it.twText("materialId")}"}?:""),buildJsonObject{put("fileId",fileId);text?.takeIf{it.isNotBlank()}?.let{put("text",it)};if(replace!=null)put("expectedRevision",twRevision(replace))});owned();drafts.remove(draftKey);pending=null;replacement=null;key=UUID.randomUUID().toString();error=null;refresh++;onChanged()
 }catch(e:CancellationException){throw e}catch(e:Exception){error="${e.message?:"文件登记失败"}；本机原文件保留，可核对后重试。"}finally{busy=false;onBusy(pending!=null)}}}
 val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()){uri->if(uri!=null){busy=true;onBusy(true);scope.launch{try{
  val file=withContext(Dispatchers.IO){owned();val name=repository.context.contentResolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use{if(it.moveToFirst())it.getString(0)else null}?:"成果文件";val safe=name.replace(Regex("[^\\p{L}\\p{N}._ -]"),"_").take(150);val destination=File(repository.context.filesDir,"accounts/$owner/task-uploads/$project/$task/${UUID.randomUUID()}-$safe");destination.parentFile?.mkdirs();val partial=File(destination.path+".partial");try{repository.context.contentResolver.openInputStream(uri)?.use{input->partial.outputStream().use{out->val buffer=ByteArray(65536);var total=0L;while(true){ensureActive();owned();val count=input.read(buffer);if(count<0)break;total+=count;check(total<=512L*1024*1024){"文件超过 512 MiB"};check(StatFs(destination.parent!!).availableBytes>64L*1024*1024){"本机剩余空间不足"};out.write(buffer,0,count)}}}?:error("无法读取所选文件");check(partial.renameTo(destination)){"保存原文件失败"};destination}finally{partial.delete()}}
  owned();pending=file;key=UUID.randomUUID().toString();error=null;busy=false;transfer()
 }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;busy=false;onBusy(false)}}}}
 Text("成果文件",style=MaterialTheme.typography.titleMedium);Text("当前有效文件的最新版本将固定引用到下一轮提交；后续更新不会改变已有提交。",style=MaterialTheme.typography.bodySmall)
 if(canUpload)OutlinedButton({replacement=null;picker.launch(arrayOf("*/*"))},enabled=!busy&&pending==null){Text("上传成果文件")}
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());if(progress.isNotBlank())Text(progress);error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 pending?.let{Text("本机保留：${it.name.substringAfter('-')}");OutlinedButton({transfer()},enabled=!busy){Text("重试上传或登记")};TextButton({scope.launch{try{drafts.remove(draftKey);pending=null;replacement=null;onBusy(false)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}},enabled=!busy){Text("移除待上传项（保留原文件）")}}
 TaskWorkspacePage(repository,"$path?limit=100",refresh){rows->rows.forEach{row->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(row.twText("name"));val archived=row.twText("archivedAt").isNotBlank()||row.twText("materialArchivedAt").isNotBlank();if(archived)Text("已归档，仅供查阅");if(row.twText("deletedAt").isBlank())AttachmentActions(repository,project,row.twText("fileId"),row.twText("name"));if(row["canManage"]?.jsonPrimitive?.booleanOrNull==true){if(!archived&&canUpload)OutlinedButton({replacement=row;picker.launch(arrayOf("*/*"))},enabled=!busy&&pending==null){Text("上传此文件的新版本")};val materialArchived=row.twText("materialArchivedAt").isNotBlank();val endpoint=if(materialArchived)"$base/materials/${row.twText("materialId")}/unarchive"else"$base/files/${row.twText("fileId")}/${if(archived)"unarchive"else"archive"}";TaskWorkspaceAction(repository,if(archived)"撤销归档"else"归档文件",endpoint,buildJsonObject{if(materialArchived)put("expectedRevision",twRevision(row))else put("expectedLifecycleVersion",row["lifecycleVersion"]!!)},enabled=!busy&&pending==null,confirmation=if(archived)"恢复此文件参与后续提交？"else"归档后此文件不参与下一轮成果提交；历史版本会保留。",onSuccess={refresh++;onChanged()})}}}}}
}


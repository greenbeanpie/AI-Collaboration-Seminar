package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.NativeAiReferenceBadge
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.media.AttachmentActions
import cn.buwei.nativeapp.media.MediaWorkspace
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

internal val dataPurposes=listOf("background" to "项目背景","reference" to "参考资料","output" to "成果材料")
internal fun JsonObject.dataFlag(name:String)=get(name)?.jsonPrimitive?.booleanOrNull==true
internal fun dataStatus(status:String)=mapOf("pending" to "尚未开始","queued" to "已排队","processing" to "正在处理","running" to "正在处理","waiting_input" to "待补充或继续","ready" to "已完成","succeeded" to "已完成","failed" to "处理失败","cancelled" to "已取消","skipped" to "不适用","disabled" to "AI 未启用","waiting_config" to "等待模型配置","not_applicable" to "不适用","available" to "文件已保存","quarantined" to "校验未通过","discarded" to "文件已弃用")[status]?:status
@Composable fun DataWorkspace(repository:ClientRepository,projectId:String,initial:cn.buwei.nativeapp.NativeDestination?=null,onActivityChange:(Boolean)->Unit={},onMaterialAi:()->Unit={}){key(projectId,repository.accountId,repository.epoch,initial){DataWorkspaceContent(repository,projectId,initial,onActivityChange,onMaterialAi)}}
@Composable private fun DataWorkspaceContent(repository:ClientRepository,projectId:String,initial:cn.buwei.nativeapp.NativeDestination?,onActivityChange:(Boolean)->Unit,onMaterialAi:()->Unit){
 val base=twBase(projectId);var mode by rememberSaveable{mutableStateOf("library")};var resourceType by rememberSaveable{mutableStateOf(initial?.resourceType?:"material")};var resourceId by rememberSaveable{mutableStateOf(initial?.recordId)};var fixedVersion by rememberSaveable{mutableStateOf(initial?.versionId)};var refresh by remember{mutableIntStateOf(0)};var captureBusy by remember{mutableStateOf(false)}
 val activityCallback by rememberUpdatedState(onActivityChange)
 LaunchedEffect(captureBusy){activityCallback(captureBusy)}
 DisposableEffect(Unit){onDispose{activityCallback(false)}}
 BackHandler(mode!="library"||resourceId!=null||fixedVersion!=null){if(!captureBusy){mode="library";resourceId=null;fixedVersion=null}}
 // Recording subpage deliberately owns scrolling; never nest the native capture surface.
 if(mode=="capture"){Column(Modifier.fillMaxSize()){TextButton({mode="new"},enabled=!captureBusy){Text("返回新增资料")};Box(Modifier.weight(1f)){MediaWorkspace(repository,projectId){captureBusy=it}}};return}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 Text("项目资料",style=MaterialTheme.typography.headlineSmall)
 if(mode!="library"||resourceId!=null||fixedVersion!=null)TextButton({mode="library";resourceId=null;fixedVersion=null},enabled=!captureBusy){Text("返回资料列表")}
 if(fixedVersion!=null){Text("引用的固定版本 · 只读",style=MaterialTheme.typography.titleMedium);TextButton({fixedVersion=null}){Text("返回当前资料")};DataWorkspaceReference(repository,projectId,resourceType,fixedVersion!!,initiallyOpen=true,initialPage=initial?.pageNumber);return@Column}
 if(resourceId!=null){DataWorkspaceDetail(repository,projectId,resourceType,resourceId!!,refresh,onMaterialAi){refresh++};return@Column}
 if(mode=="new"){DataWorkspaceIntake(repository,projectId,{mode="capture"},{captureBusy=it}){type,id->resourceType=type;resourceId=id;mode="library";refresh++};return@Column}
 if(mode=="files"){DataWorkspaceFiles(repository,projectId,refresh){refresh++};return@Column}
 Button({mode="new"}){Text("新增资料")};OutlinedButton(onMaterialAi){Text("AI 补位与成果采纳")};OutlinedButton({mode="files"}){Text("附件与回收站")};TextButton({refresh++}){Text("刷新资料")}
 var query by rememberSaveable{mutableStateOf("")};var applied by rememberSaveable{mutableStateOf("")};var purpose by rememberSaveable{mutableStateOf("")};var archived by rememberSaveable{mutableStateOf(false)}
 TaskWorkspaceField("搜索资料标题",query,{query=it},200);OutlinedButton({applied=query.trim()}){Text("搜索资料")};TaskWorkspaceChoice("资料用途",listOf("" to "全部资料")+dataPurposes,purpose){purpose=it};TaskWorkspaceChoice("资料视图",listOf("false" to "当前资料","true" to "已归档"),archived.toString()){archived=it=="true"}
 val path="$base/resource-library?limit=50&q=${Uri.encode(applied)}&archived=$archived"+(if(purpose.isNotBlank())"&purpose=$purpose"else"")
 TaskWorkspacePage(repository,path,refresh){rows->if(rows.isEmpty())Text("当前视图暂无资料");rows.forEach{row->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(row.twText("title"),style=MaterialTheme.typography.titleMedium);NativeAiReferenceBadge();Text((dataPurposes.firstOrNull{it.first==row.twText("purpose")}?.second?:"资料")+if(row.twText("resourceType")=="source")" · 来源原文"else" · 成果文档");if(row.dataFlag("systemManaged"))Text("系统背景 · 自动同步");if(row.twText("archivedAt").isNotBlank())Text("已归档 · 只读");Text("更新于 ${row.twText("updatedAt")}");OutlinedButton({resourceType=row.twText("resourceType");resourceId=row.twText("resourceId")}){Text("查看资料")}}}}}
 }
}
@Composable private fun DataWorkspaceDetail(repository:ClientRepository,project:String,type:String,id:String,refresh:Int,onMaterialAi:()->Unit,onChanged:()->Unit){
 val base=twBase(project);var resource by remember(type,id){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)};var localRefresh by remember(type,id){mutableIntStateOf(0)}
 LaunchedEffect(type,id,refresh,localRefresh){try{resource=repository.get("$base/resource-library/$type/${Uri.encode(id)}");error=null}catch(e:CancellationException){throw e}catch(e:Exception){if(e.taskReadAccessDenied())resource=null;error=(e.message?:"读取失败")+if(resource!=null)"；当前显示上次读取内容，请重试核对。"else""}}
 TextButton({localRefresh++}){Text("刷新当前资料")}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};val row=resource?:return
 Text(row.twText("title"),style=MaterialTheme.typography.titleLarge);NativeAiReferenceBadge();Text("${dataPurposes.firstOrNull{it.first==row.twText("purpose")}?.second.orEmpty()} · 创建于 ${row.twText("createdAt")}")
 if(type=="material")OutlinedButton(onMaterialAi){Text("AI 补位与成果采纳")}
 if(row.dataFlag("canManage")&&row.twText("archivedAt").isBlank()&&row.twText("deletedAt").isBlank()){var purpose by rememberSaveable(id,row.twText("revision")){mutableStateOf(row.twText("purpose"))};TaskWorkspaceChoice("修改资料用途",dataPurposes,purpose){purpose=it};TaskWorkspaceAction(repository,"保存资料用途","$base/resource-library/$type/$id",buildJsonObject{put("purpose",purpose);put("expectedRevision",twRevision(row))},"PATCH",confirmation="修改用途可能按项目配置继续后台文件处理，请核对后保存。",onSuccess={resource=it;onChanged()})}
 if(type=="material")DataWorkspaceMaterial(repository,project,row,refresh+localRefresh,onChanged)else DataWorkspaceSource(repository,project,row,refresh+localRefresh,onChanged)
}
@Composable internal fun DataWorkspaceContributors(row:JsonObject){val people=row.twRows("contributors");if(people.isNotEmpty())Text("贡献者："+people.joinToString("、"){it.twText("displayName").ifBlank{it.twText("username")}})}
@Composable internal fun DataWorkspaceLifecycle(repository:ClientRepository,base:String,kind:String,id:String,name:String,lifecycle:Int,deleted:Boolean,onChanged:()->Unit){
 TaskWorkspaceAction(repository,if(deleted)"恢复资料"else"移入回收站","$base/${if(kind=="file")"files"else"sources"}/$id"+(if(deleted)"/restore"else""),buildJsonObject{put("expectedLifecycleVersion",lifecycle)},if(deleted)"POST"else"DELETE",confirmation=if(deleted)"恢复 $name 的可用状态。不会启动解析、OCR、总结或恢复已取消任务。"else"将 $name 移入回收站并停止相关处理？原文件、已接收正文与历史引用会保留，可按权限恢复；已发生模型费用无法撤回。",onSuccess={onChanged()})
}
@Composable internal fun DataWorkspaceFiles(repository:ClientRepository,project:String,refresh:Int,onChanged:()->Unit){
 val base=twBase(project);var view by rememberSaveable{mutableStateOf("active")};var query by rememberSaveable{mutableStateOf("")};var filter by rememberSaveable{mutableStateOf("")}
 Text("文件库与回收站",style=MaterialTheme.typography.titleLarge);TaskWorkspaceChoice("文件视图",listOf("active" to "文件库","archived" to "已归档","recycle" to "回收站"),view){view=it};TaskWorkspaceField("搜索文件与来源",query,{query=it},200);OutlinedButton({filter=query.trim()}){Text("搜索文件")}
 if(view=="recycle")Text("恢复不会启动解析、OCR、要求提取或总结；原文件和历史仍会保留。")
 val path="$base/files?limit=50&q=${Uri.encode(filter)}&deleted=${view=="recycle"}&archived=${view=="archived"}"
 TaskWorkspacePage(repository,path,refresh){rows->rows.forEach{file->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(file.twText("name"),style=MaterialTheme.typography.titleMedium);DataWorkspaceContributors(file);Text(dataStatus(file.twText("status")));Text("${file.twText("sizeBytes").toLongOrNull()?.let{"${it/1024} KiB"}?:"大小待确认"} · ${file.twText("createdAt")}")
 if(view!="recycle"&&file.twText("status")=="available"){AttachmentActions(repository,project,file.twText("fileId"),file.twText("name"));if(file.twText("archivedAt").isBlank())DataWorkspaceFileProcessing(repository,project,file.twText("fileId"),file.twText("name"))}
 if(file.dataFlag("canManage")&&view!="recycle"){val archived=file.twText("archivedAt").isNotBlank();TaskWorkspaceAction(repository,if(archived)"撤销文件归档"else"归档文件","$base/files/${file.twText("fileId")}/${if(archived)"unarchive"else"archive"}",buildJsonObject{put("expectedLifecycleVersion",file["lifecycleVersion"]!!)},confirmation=if(archived)"恢复此文件参与当前资料列表？"else"归档后不会参与后续默认资料选择，历史引用保留。",onSuccess={onChanged()})}
 if(file.dataFlag("canDelete")&&view!="archived")DataWorkspaceLifecycle(repository,base,"file",file.twText("fileId"),file.twText("name"),file["lifecycleVersion"]!!.jsonPrimitive.int,view=="recycle",onChanged)
 }}}}
 if(view=="recycle")TaskWorkspacePage(repository,"$base/sources?limit=50&deleted=true&q=${Uri.encode(filter)}",refresh){rows->rows.filter{it.twText("kind")!="file"&&it.twText("fileId").isBlank()}.forEach{source->Text(source.twText("title"));if(source.dataFlag("canDelete"))DataWorkspaceLifecycle(repository,base,"source",source.twText("sourceId"),source.twText("title"),source["lifecycleVersion"]!!.jsonPrimitive.int,true,onChanged)}}
}
@Composable private fun DataWorkspaceMaterial(repository:ClientRepository,project:String,resource:JsonObject,refresh:Int,onChanged:()->Unit){
 val base=twBase(project);val path="$base/materials/${resource.twText("resourceId")}";var material by remember(path){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)}
 LaunchedEffect(path,refresh){try{material=repository.get(path);error=null}catch(e:CancellationException){throw e}catch(e:Exception){if(e.taskReadAccessDenied())material=null;error=(e.message?:"读取失败")+if(material!=null)"；当前显示上次读取内容，请重试核对。"else""}};error?.let{Text(it,color=MaterialTheme.colorScheme.error)};val row=material?:return
 if(row.dataFlag("systemManaged"))Text("系统背景由服务端同步，仅供查看。");val version=row["currentVersion"] as? JsonObject
 if(version!=null){Text("当前正文 · 第 ${version.twText("revision")} 版",style=MaterialTheme.typography.titleMedium);NativeAiReferenceBadge();DataWorkspaceVersionContent(version);version.twRows("attachments").forEach{file->DataWorkspaceContributors(file);if(file.twText("availability")=="unavailable")Text("${file.twText("name")}（原文件不可用）")else AttachmentActions(repository,project,file.twText("fileId"),file.twText("name"))};DataWorkspaceReference(repository,project,"material",version.twText("versionId"))}
 if(row.dataFlag("canEdit")&&row.twText("archivedAt").isBlank())NativeRichMaterialEditor(repository,path,row)
 if(row.dataFlag("canArchive")){val archived=row.twText("archivedAt").isNotBlank();TaskWorkspaceAction(repository,if(archived)"撤销材料归档"else"归档材料","$path/${if(archived)"unarchive"else"archive"}",buildJsonObject{put("expectedRevision",twRevision(row))},confirmation=if(archived)"恢复这份材料？"else"归档材料将退出当前资料选择，历史固定版本保留。",onSuccess={onChanged()})}
 DataWorkspaceVersions(repository,project,row)
 MaterialDiscussionWorkspace(repository,project,resource.twText("resourceId"))
}
@Composable private fun DataWorkspaceSource(repository:ClientRepository,project:String,resource:JsonObject,refresh:Int,onChanged:()->Unit){
 val base=twBase(project);val path="$base/sources/${resource.twText("resourceId")}";var source by remember(path){mutableStateOf<JsonObject?>(null)};var version by remember(path){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)}
 LaunchedEffect(path,refresh){try{val record=repository.get(path);val current=record.twText("currentVersionId").takeIf{it.isNotBlank()}?.let{repository.get("$path/versions/$it")};source=record;version=current;error=null}catch(e:CancellationException){throw e}catch(e:Exception){if(e.taskReadAccessDenied()){source=null;version=null};error=(e.message?:"读取失败")+if(source!=null)"；当前显示上次读取内容，请重试核对。"else""}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};val row=source?:return;DataWorkspaceContributors(row);Text("来源类型：${mapOf("file" to "文件","web" to "公开网页","paste" to "粘贴文本")[row.twText("kind")].orEmpty()}");val fileId=row.twText("fileId")
 if(fileId.isNotBlank())AttachmentActions(repository,project,fileId,row.twText("title"))
 version?.let{current->Text("原文版本 ${current.twText("revision")} · ${dataStatus(current.twText("status"))} · ${current.twText("pageCount").ifBlank{"无固定页数"}} · ${current.twText("charCount")} 字符");if(current.twText("parseError").isNotBlank())Text(current.twText("parseError"),color=MaterialTheme.colorScheme.error);Text("提取方式：${current.twText("extractionMethod")} · 覆盖情况：${current.twText("extractionCoverage")}");current.twIds("extractionWarnings").forEach{Text(it,color=MaterialTheme.colorScheme.error)};DataWorkspaceReference(repository,project,"source",current.twText("sourceVersionId"));DataWorkspaceSourceProcessing(repository,project,row,current,onChanged)}
 if(row.dataFlag("canDelete")&&fileId.isBlank())DataWorkspaceLifecycle(repository,base,"source",row.twText("sourceId"),row.twText("title"),row["lifecycleVersion"]!!.jsonPrimitive.int,row.twText("deletedAt").isNotBlank(),onChanged)
}

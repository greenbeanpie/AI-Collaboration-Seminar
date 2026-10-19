package cn.buwei.nativeapp.features

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.ClipEntry
import android.content.ClipData
import androidx.core.content.FileProvider
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.media.AttachmentActions
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File

/** Full authorised context for a manually operated agent; never executes a model or submits work. */
@Composable internal fun TaskWorkspacePrompt(repository:ClientRepository,base:String,task:JsonObject){
 var open by remember{mutableStateOf(false)};OutlinedButton({open=!open}){Text("手动复制或导出任务上下文")};if(!open)return
 val scope=rememberCoroutineScope();var text by remember(task.twText("taskId")){mutableStateOf<String?>(null)};var error by remember{mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};val owner=repository.accountId;val epoch=repository.epoch;val clipboard=LocalClipboard.current
 suspend fun generate(){busy=true;try{val eligibility=repository.get("$base/collaboration/tasks/${task.twText("taskId")}/agent-eligibility");require(eligibility.twText("status")=="ready"&&eligibility["eligible"]?.jsonPrimitive?.booleanOrNull==true&&eligibility["taskRevision"]?.jsonPrimitive?.int==twRevision(task)){eligibility.twText("reason").ifBlank{"请先完成当前任务的 AI 适用性判断"}}
 text=taskWorkspacePromptText(repository,base,task);error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}
 LaunchedEffect(task.twText("taskId"),task.twText("revision")){generate()}
 if(busy)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 text?.let{value->Text("上下文包含当前任务、主目标、生效标准、全部前置任务当前提交，以及项目材料及前置成果固定版本。导出后需自行保护。",style=MaterialTheme.typography.bodySmall);SelectionContainer{Text(value,style=MaterialTheme.typography.bodySmall)};OutlinedButton({scope.launch{clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("任务执行上下文",value)))}}){Text("复制任务上下文")};OutlinedButton({scope.launch{try{check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"};val file=withContext(Dispatchers.IO){File(repository.context.cacheDir,"exports/$owner/task-${task.twText("taskId")}.md").apply{parentFile?.mkdirs();writeText(value)}};check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化"};val uri=FileProvider.getUriForFile(repository.context,"${repository.context.packageName}.files",file);repository.context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/markdown").putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"导出任务上下文").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}){Text("导出任务上下文文件")}}
 TextButton({scope.launch{generate()}},enabled=!busy){Text("重新读取上下文")}
}
internal suspend fun taskWorkspacePromptText(repository:ClientRepository,base:String,task:JsonObject):String{
 val owner=repository.accountId;val epoch=repository.epoch
 fun owned(){check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，上下文读取已停止"}}
 val goal=repository.get("$base/goal");val standard=repository.get("$base/standards/current");val allMaterials=taskWorkspaceAllPages(repository,"$base/materials");val dependencies=mutableListOf<Pair<JsonObject,JsonObject?>>();val seen=mutableSetOf(task.twText("taskId"));val pending=ArrayDeque(task.twIds("dependsOnTaskIds"));val versions=linkedMapOf<String,Pair<String,String>>()
 while(pending.isNotEmpty()){owned();val id=pending.removeFirst();if(!seen.add(id))continue;val dependency=repository.get("$base/tasks/$id");pending.addAll(dependency.twIds("dependsOnTaskIds"));val current=dependency.twText("currentSubmissionId");val submission=if(current.isNotBlank())taskWorkspaceAllPages(repository,"$base/tasks/$id/submissions").firstOrNull{it.twText("submissionId")==current}?:error("前置任务当前成果不可用，请先刷新")else null;dependencies+=dependency to submission
 submission?.twRows("materialVersions")?.forEach{version->versions[version.twText("versionId")]=version.twText("materialId") to version.twText("title")}}
 allMaterials.forEach{material->val version=material.twText("currentVersionId");if(version.isNotBlank())versions[version]=material.twText("materialId") to material.twText("title")}
 val body=StringBuilder("# 任务执行上下文\n\n请依据下列固定版本资料完成任务，成果由用户核对后提交验收。不要自行变更项目配置、权限、任务状态或提交成果。\n\n")
 fun taskText(row:JsonObject){body.append("## ").append(row.twText("title")).append("\n").append(row.twText("detail")).append("\n\n验收标准：\n").append(row.twText("criteria")).append("\n预计投入：").append(row.twText("effortHours")).append(" 小时\n修订：").append(row.twText("revision")).append("\n")}
 taskText(task);body.append("\n## 项目主目标\n").append(goal.twText("title")).append('\n').append(goal.twText("detail")).append("\n\n## 生效标准\n").append(standard["standard"]?.toString()?:"尚无生效标准").append("\n\n## 全部前置任务与当前成果\n")
 dependencies.forEach{(dependency,submission)->taskText(dependency);body.append("状态：").append(twState(dependency)).append("\n成果说明：\n").append(submission?.twText("body")?:"尚无成果").append("\n\n")}
 body.append("## 固定版本材料\n")
 versions.forEach{(version,pair)->owned();val material=repository.get("$base/materials/${pair.first}/versions/$version");body.append("### ").append(pair.second).append("\n固定版本：").append(version).append("\n").append(material.twText("markdown")).append('\n');material.twRows("attachments").forEach{attachment->body.append("- ").append(attachment.twText("name")).append(if(attachment.twText("availability")=="unavailable")"（不可用）"else"：${repository.origin}$base/files/${attachment.twText("fileId")}/content").append('\n')}}
 owned();return body.toString()
}

@Composable internal fun TaskWorkspaceFixedVersion(repository:ClientRepository,base:String,version:JsonObject){
 var open by remember{mutableStateOf(false)};var detail by remember{mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)};OutlinedButton({open=!open}){Text("${version.twText("title")} · 第 ${version.twText("revision")} 版")}
 LaunchedEffect(open){if(open&&detail==null)try{detail=repository.get("$base/materials/${version.twText("materialId")}/versions/${version.twText("versionId")}");error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 if(open){error?.let{Text(it,color=MaterialTheme.colorScheme.error)};detail?.let{NativeMarkdown(it.twText("markdown"));it.twRows("attachments").forEach{attachment->if(attachment.twText("availability")=="unavailable")Text("${attachment.twText("name")}（原文件不可用）")else AttachmentActions(repository,base.substringAfterLast('/'),attachment.twText("fileId"),attachment.twText("name"))}}}
}
@Composable internal fun TaskWorkspaceScores(repository:ClientRepository,base:String,submission:JsonObject,manage:Boolean,onChanged:()->Unit){
 val scoring=(submission["aiReport"] as? JsonObject)?.get("rubricScoring") as? JsonObject?:return
 if(scoring.twText("status")!="scored"){Text("辅助评分不可用：${scoring.twText("reason")}");return}
 val weights=scoring.twRows("weights");Text("成果辅助评分 · 标准版本 ${scoring.twText("rubricVersion")}",style=MaterialTheme.typography.titleMedium);Text("AI 辅助总分：${scoring.twText("weightedTotal")} / 100")
 scoring.twRows("scores").forEach{score->val weight=weights.firstOrNull{it.twText("key")==score.twText("key")};Text("${weight?.twText("label")?:score.twText("key")}：${score.twText("score")} · 权重 ${weight?.twText("weight").orEmpty()}");NativeMarkdown(score.twText("comment"));score.twRows("evidence").forEach{NativeMarkdown(it.twText("quote"))}}
 val override=submission["humanScoreOverride"] as? JsonObject;override?.let{Text("负责人复核辅助总分：${it.twText("weightedTotal")} / 100");NativeMarkdown(it.twText("reason"))}
 if(!manage)return
 var current by remember{mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)};LaunchedEffect(submission.twText("submissionId")){try{current=repository.get("$base/standards/current")["standard"] as? JsonObject}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(current==null)return
 if(current!!.twText("standardsVersionId")!=scoring.twText("standardsVersionId")){Text("本轮评分依据的标准已失效，保留历史记录。请依据生效标准重新提交。",color=MaterialTheme.colorScheme.error);return}
 var open by remember{mutableStateOf(false)};OutlinedButton({open=!open}){Text("负责人复核辅助分数")};if(!open)return
 var values by rememberSaveable(submission.twText("submissionId")){mutableStateOf(scoring.twRows("scores").associate{row->val existing=override?.twRows("scores")?.firstOrNull{it.twText("key")==row.twText("key")};row.twText("key") to (existing?.twText("score")?:row.twText("score"))})};var reason by rememberSaveable(submission.twText("submissionId")){mutableStateOf("")};var baseRevision by rememberSaveable(submission.twText("submissionId")){mutableIntStateOf(twRevision(submission))}
 values.forEach{(id,value)->TaskWorkspaceField("复核${weights.firstOrNull{it.twText("key")==id}?.twText("label")?:id}分数（0–100）",value,{values=values+(id to it)},8)};TaskWorkspaceField("辅助分数复核理由",reason,{reason=it},2000,3)
 if(baseRevision!=twRevision(submission)){Text("评分记录已变化，填写内容保留。请核对最新记录。",color=MaterialTheme.colorScheme.error);TextButton({baseRevision=twRevision(submission)}){Text("已核对最新评分，保留本次编辑")}}
 TaskWorkspaceAction(repository,"保存辅助分数复核","$base/collaboration/submissions/${submission.twText("submissionId")}/scores",buildJsonObject{put("expectedRevision",baseRevision);put("reason",reason.trim());put("scores",JsonArray(values.map{(id,value)->buildJsonObject{put("key",id);put("score",value.toDoubleOrNull()?:0.0)}}))},enabled=baseRevision==twRevision(submission)&&reason.isNotBlank()&&values.values.all{it.toDoubleOrNull()?.let{n->n.isFinite()&&n in 0.0..100.0}==true},confirmation="记录人工辅助分数复核，原 AI 分数与证据会保留。",onSuccess={baseRevision=it["revision"]?.jsonPrimitive?.int?:baseRevision;reason="";onChanged()})
}

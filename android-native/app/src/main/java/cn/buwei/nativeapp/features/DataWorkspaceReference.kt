package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.media.AttachmentActions
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

@Composable internal fun DataWorkspaceReference(repository:ClientRepository,project:String,type:String,version:String,initiallyOpen:Boolean=false,initialPage:Int?=null){
 var open by remember(version){mutableStateOf(initiallyOpen)};OutlinedButton({open=!open}){Text("资料目录、搜索与原文定位")};if(!open)return
 val path="${twBase(project)}/resource-index/$type/$version";var query by remember(version){mutableStateOf("")};var applied by remember(version){mutableStateOf("")};var offset by remember(version){mutableIntStateOf(0)};var index by remember(version){mutableStateOf<JsonObject?>(null)};var section by remember(version){mutableStateOf<JsonObject?>(null)};var readOffset by remember(version){mutableIntStateOf(0)};var detail by remember(version){mutableStateOf<JsonObject?>(null)};var refresh by remember{mutableIntStateOf(0)};var error by remember{mutableStateOf<String?>(null)}
 var locatorMessage by remember(version,initialPage){mutableStateOf<String?>(null)}
 LaunchedEffect(path,initialPage){if(initialPage!=null){val owner=repository.accountId;val epoch=repository.epoch;try{var start=0;while(true){val page=repository.networkJson("GET","$path?offset=$start",expectedOwner=owner,expectedEpoch=epoch);val match=page.twRows().firstOrNull{it["pageNumber"]?.jsonPrimitive?.intOrNull==initialPage};if(match!=null){offset=start;section=match;locatorMessage="已定位引用原文件第 $initialPage 页";break};val next=page["nextOffset"]?.jsonPrimitive?.intOrNull;if(next==null){locatorMessage="固定版本中未找到第 $initialPage 页的正文，请核对目录及原文件";break};check(next>start){"目录分页未前进"};start=next}}catch(e:CancellationException){throw e}catch(e:Exception){locatorMessage=e.message}}}
 locatorMessage?.let{Text(it,style=MaterialTheme.typography.bodySmall)}
 TaskWorkspaceField("资料内搜索",query,{query=it},200);Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){OutlinedButton({applied=query.trim();offset=0;section=null}){Text("搜索原文")};TextButton({query="";applied="";offset=0;section=null}){Text("返回目录")}}
 LaunchedEffect(path,offset,applied,refresh){try{index=repository.get(path+(if(applied.isBlank())"?offset=$offset"else"/search?offset=$offset&query=${Uri.encode(applied)}"));error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 LaunchedEffect(path,section?.twText("sectionId"),readOffset){val item=section;if(item!=null)try{detail=repository.get("$path/section?sectionId=${Uri.encode(item.twText("sectionId"))}&offset=$readOffset&neighbors=true");error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};index?.let{current->Text("索引：${current.twText("indexStatus")} · 原文覆盖：${current.twText("coverage")}");Text("搜索摘录仅用于定位，请打开原文核对完整语境。",style=MaterialTheme.typography.bodySmall);current.twRows().forEach{entry->OutlinedButton({section=entry;readOffset=0;detail=null},Modifier.fillMaxWidth()){Column{Text((entry.twText("pageNumber").takeIf{it.isNotBlank()}?.let{"第 $it 页 · "}?:"")+entry.twText("heading").ifBlank{"原文段落"});if(entry.twText("excerpt").isNotBlank())Text(entry.twText("excerpt"),style=MaterialTheme.typography.bodySmall)}}};Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){if(offset>0)TextButton({offset=maxOf(0,offset-20)}){Text("上一批目录")};current["nextOffset"]?.jsonPrimitive?.intOrNull?.let{next->TextButton({offset=next;section=null}){Text("下一批目录")}}}}
 section?.let{Text(it.twText("heading").ifBlank{"原文"},style=MaterialTheme.typography.titleMedium);val page=it.twText("pageNumber");if(page.isNotBlank())Text("对应原文件第 $page 页");detail?.let{read->SelectionContainer{Column{if(read.twText("text").isNotBlank())Text(read.twText("text"));read.twRows("fragments").forEach{fragment->Text(fragment.twText("quote"))}};read["nextOffset"]?.jsonPrimitive?.intOrNull?.let{next->TextButton({readOffset=next}){Text("继续读取原文")}}}}}
 TextButton({refresh++}){Text("刷新目录状态")}
}
@Composable internal fun DataWorkspaceVersions(repository:ClientRepository,project:String,material:JsonObject){
 val base=twBase(project);val path="$base/materials/${material.twText("materialId")}";var open by remember{mutableStateOf(false)};OutlinedButton({open=!open}){Text("历史版本与比较")};if(!open)return
 var rows by remember(path){mutableStateOf<List<JsonObject>>(emptyList())};var left by remember(path){mutableStateOf<String?>(null)};var right by remember(path){mutableStateOf<String?>(null)};var selected by remember(path){mutableStateOf<JsonObject?>(null)};var other by remember(path){mutableStateOf<JsonObject?>(null)};var error by remember{mutableStateOf<String?>(null)}
 LaunchedEffect(path){try{rows=taskWorkspaceAllPages(repository,"$path/versions");left=rows.firstOrNull()?.twText("versionId");right=rows.getOrNull(1)?.twText("versionId");error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 LaunchedEffect(path,left,right){try{selected=left?.let{repository.get("$path/versions/$it")};other=right?.let{repository.get("$path/versions/$it")};error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};val choices=rows.map{it.twText("versionId") to "第 ${it.twText("revision")} 版 · ${it.twText("createdAt")}"};TaskWorkspaceChoice("查看版本",choices,left.orEmpty()){left=it};TaskWorkspaceChoice("对照版本",listOf("" to "不比较")+choices,right.orEmpty()){right=it.takeIf{value->value.isNotBlank()}}
 selected?.let{version->Text("历史版本只读 · 第 ${version.twText("revision")} 版",style=MaterialTheme.typography.titleMedium);NativeMarkdown(version.twText("markdown"));version.twRows("attachments").forEach{file->if(file.twText("availability")=="unavailable")Text("${file.twText("name")}（不可用，保留引用）")else AttachmentActions(repository,project,file.twText("fileId"),file.twText("name"))};DataWorkspaceReference(repository,project,"material",version.twText("versionId"));other?.let{previous->val diff=remember(version.twText("versionId"),previous.twText("versionId")){dataWorkspaceDiff(previous.twText("markdown"),version.twText("markdown"))};Text("版本比较：第 ${previous.twText("revision")} 版 → 第 ${version.twText("revision")} 版",style=MaterialTheme.typography.titleMedium);if(diff.isEmpty())Text("两个版本正文相同");diff.forEach{line->Text(line.text,color=when(line.kind){"+"->MaterialTheme.colorScheme.primary;"-"->MaterialTheme.colorScheme.error;else->MaterialTheme.colorScheme.onSurface},style=MaterialTheme.typography.bodySmall)};val oldFiles=previous.twRows("attachments").map{it.twText("fileId")}.toSet();val newFiles=version.twRows("attachments").map{it.twText("fileId")}.toSet();Text("附件变化：新增 ${(newFiles-oldFiles).size} 个，移除 ${(oldFiles-newFiles).size} 个。历史原文件仍受当前访问权限约束。")}}
}
internal data class DataWorkspaceDiffLine(val kind:String,val text:String)
/** Bounded look-ahead avoids quadratic memory on large documents while showing every changed line. */
internal fun dataWorkspaceDiff(before:String,after:String):List<DataWorkspaceDiffLine>{
 if(before==after)return emptyList();val a=before.lines();val b=after.lines();val result=mutableListOf<DataWorkspaceDiffLine>();var i=0;var j=0;var equal=0
 fun flushEqual(){if(equal>0){result+=DataWorkspaceDiffLine("=","… $equal 行相同 …");equal=0}}
 while(i<a.size||j<b.size){if(i<a.size&&j<b.size&&a[i]==b[j]){equal++;i++;j++;continue};flushEqual();val nextOld=if(j<b.size)(i+1 until minOf(i+21,a.size)).firstOrNull{a[it]==b[j]}else null;val nextNew=if(i<a.size)(j+1 until minOf(j+21,b.size)).firstOrNull{b[it]==a[i]}else null
 when{nextOld!=null&&(nextNew==null||nextOld-i<=nextNew-j)->{while(i<nextOld)result+=DataWorkspaceDiffLine("-","− ${a[i++]}")};nextNew!=null->{while(j<nextNew)result+=DataWorkspaceDiffLine("+","＋ ${b[j++]}")};else->{if(i<a.size)result+=DataWorkspaceDiffLine("-","− ${a[i++]}");if(j<b.size)result+=DataWorkspaceDiffLine("+","＋ ${b[j++]}")}}};flushEqual();return result
}

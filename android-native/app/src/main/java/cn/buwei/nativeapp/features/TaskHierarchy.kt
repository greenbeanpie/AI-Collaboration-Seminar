package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.serialization.json.*

internal data class TaskTreeRow(val task:JsonObject,val depth:Int,val context:Boolean)
internal fun taskAncestors(task:JsonObject,tasks:List<JsonObject>):List<JsonObject>{
 val byId=tasks.associateBy{it.twText("taskId")};val result=mutableListOf<JsonObject>();val seen=mutableSetOf(task.twText("taskId"));var parent=task.twText("parentTaskId")
 while(parent.isNotBlank()&&seen.add(parent)){val row=byId[parent]?:break;result.add(0,row);parent=row.twText("parentTaskId")};return result
}
internal fun taskTreeRows(tasks:List<JsonObject>,matches:Set<String>,collapsed:Set<String>,filtered:Boolean):List<TaskTreeRow>{
 val ids=tasks.map{it.twText("taskId")}.toSet();val visible=matches.toMutableSet()
 tasks.filter{it.twText("taskId") in matches}.forEach{taskAncestors(it,tasks).forEach{p->visible.add(p.twText("taskId"))}}
 val children=tasks.groupBy{it.twText("parentTaskId")};val result=mutableListOf<TaskTreeRow>();val seen=mutableSetOf<String>()
 fun visit(row:JsonObject,depth:Int){val id=row.twText("taskId");if(id !in visible||!seen.add(id))return;result.add(TaskTreeRow(row,depth,id !in matches));if(filtered||id !in collapsed)children[id].orEmpty().forEach{visit(it,depth+1)}}
 tasks.filter{it.twText("parentTaskId") !in ids}.forEach{visit(it,0)}
 return result
}
@Composable internal fun TaskFocusSection(repository:ClientRepository,base:String,focus:JsonObject?,onSelect:(String)->Unit,onChanged:()->Unit){
 var all by remember{mutableStateOf(false)}
 Text("我现在需要处理",style=MaterialTheme.typography.titleLarge)
 if(focus==null){Text("重点任务暂不可用，请刷新重试");return}
 val rows=focus.twRows();if(rows.isEmpty())Text("暂无需要你处理的任务")
 rows.take(if(all)rows.size else 5).forEach{task->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
  Text(task.twText("title"),style=MaterialTheme.typography.titleMedium);Text(task.twIds("focusReasons").joinToString(" · "));Text(if(task.twText("assigneeId")==repository.accountId)"由你负责"else"我关注")
  TextButton({onSelect(task.twText("taskId"))}){Text("查看与处理")};TaskPin(repository,base,task.twText("taskId"),task.flag("pinned"),onChanged)
 }}}
 if(rows.size>5)TextButton({all=!all}){Text(if(all)"收起重点任务"else"查看全部 ${rows.size} 项")}
 listOf("waitingReview" to "等待验收","reviewRequired" to "待我审核").forEach{(field,title)->val pending=focus.twRows(field);if(pending.isNotEmpty()){Text("$title（${pending.size}）",style=MaterialTheme.typography.titleMedium);pending.forEach{task->TextButton({onSelect(task.twText("taskId"))}){Text(task.twText("title"))}}}}
}
@Composable private fun TaskPin(repository:ClientRepository,base:String,id:String,pinned:Boolean,onChanged:()->Unit){TaskWorkspaceAction(repository,if(pinned)"取消个人置顶"else"个人置顶","$base/tasks/${Uri.encode(id)}/pin",buildJsonObject{put("pinned",!pinned)},"PUT",onSuccess={onChanged()})}
@Composable internal fun TaskHierarchyList(repository:ClientRepository,base:String,tasks:List<JsonObject>,focus:JsonObject?,query:String,filter:String,mine:Boolean,members:List<JsonObject>,onSelect:(String)->Unit,onChanged:()->Unit){
 var collapsed by remember{mutableStateOf(emptySet<String>())}
 val matches=tasks.filter{(query.isBlank()||(it.twText("title")+" "+it.twText("detail")).contains(query,true))&&(!mine||it.twText("assigneeId")==repository.accountId)&&(filter.isBlank()||if(filter=="pending")it.flag("pendingHumanReview")else it.twText("lifecycleState")==filter)}.map{it.twText("taskId")}.toSet()
 val rows=taskTreeRows(tasks,matches,collapsed,query.isNotBlank()||filter.isNotBlank()||mine)
 Text("全部任务与关系",style=MaterialTheme.typography.titleLarge);if(rows.isEmpty())Text("当前筛选下没有任务")
 val pinned=(focus?.twRows().orEmpty()+focus?.twRows("waitingReview").orEmpty()+focus?.twRows("reviewRequired").orEmpty()).filter{it.flag("pinned")}.map{it.twText("taskId")}.toSet()
 rows.forEach{entry->val task=entry.task;val id=task.twText("taskId");val children=tasks.filter{it.twText("parentTaskId")==id}
  Card(Modifier.fillMaxWidth().padding(start=(entry.depth.coerceAtMost(3)*8).dp)){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
   if(entry.context)Text("父任务上下文 · 不符合当前筛选",style=MaterialTheme.typography.labelMedium)
   Text(task.twText("title"),style=MaterialTheme.typography.titleMedium);Text(twState(task));Text("负责人："+(members.firstOrNull{it.twText("userId")==task.twText("assigneeId")}?.twText("displayName")?:"未分配"))
   if(task.twText("dueDate").isNotBlank())Text("期限：${task.twText("dueDate")}")
   if(children.isNotEmpty()){Text("子任务：已完成 ${children.count{it.twText("status")=="done"}} / ${children.size}");if(query.isBlank()&&filter.isBlank()&&!mine)TextButton({collapsed=if(id in collapsed)collapsed-id else collapsed+id}){Text(if(id in collapsed)"展开子任务"else"收起子任务")}}
   TaskRelations(task,tasks,onSelect,false);TextButton({onSelect(id)}){Text("查看与处理")};if(focus!=null)TaskPin(repository,base,id,id in pinned,onChanged)
  }}
 }
}
@Composable internal fun TaskRelations(task:JsonObject,tasks:List<JsonObject>?,onSelect:(String)->Unit,showChildren:Boolean=true){
 if(tasks==null){Text("任务关系暂不可用");return}
 val parents=taskAncestors(task,tasks);if(parents.isNotEmpty()){Text("父任务路径",style=MaterialTheme.typography.labelLarge);parents.forEach{p->TextButton({onSelect(p.twText("taskId"))}){Text(p.twText("title"))}}}
 TaskWorkspaceDependencies(task,tasks,onSelect)
 if(showChildren){val children=tasks.filter{it.twText("parentTaskId")==task.twText("taskId")};if(children.isNotEmpty()){Text("直接子任务（${children.count{it.twText("status")=="done"}}/${children.size} 已完成）");children.forEach{child->TextButton({onSelect(child.twText("taskId"))}){Text(child.twText("title")+" · "+twState(child))}}}}
 val downstream=tasks.filter{task.twText("taskId") in it.twIds("dependsOnTaskIds")};if(downstream.isNotEmpty()){Text("后续依赖任务",style=MaterialTheme.typography.labelLarge);downstream.forEach{row->TextButton({onSelect(row.twText("taskId"))}){Text(row.twText("title")+" · "+twState(row))}}}
}
@Composable internal fun TaskParentEditor(repository:ClientRepository,path:String,task:JsonObject,graph:JsonObject,onChanged:()->Unit){
 val id=task.twText("taskId");var parent by remember(id){mutableStateOf(task.twText("parentTaskId"))};var revision by remember(id){mutableIntStateOf(graph["graphRevision"]!!.jsonPrimitive.int)}
 Text("父子任务",style=MaterialTheme.typography.titleMedium);Text("父任务自动依赖子任务；仍可提前执行和提交。")
 TaskWorkspaceChoice("父任务",listOf("" to "无父任务")+graph.twRows().filter{it.twText("taskId")!=id&&taskAncestors(it,graph.twRows()).none{p->p.twText("taskId")==id}}.map{it.twText("taskId") to it.twText("title")},parent){parent=it}
 if(revision!=graph["graphRevision"]!!.jsonPrimitive.int){Text("关系图已变化，请核对后保存");TextButton({revision=graph["graphRevision"]!!.jsonPrimitive.int}){Text("已核对关系图，保留选择")}}
 TaskWorkspaceAction(repository,"保存父任务","$path/parent",buildJsonObject{put("parentTaskId",parent.takeIf{it.isNotBlank()}?.let(::JsonPrimitive)?:JsonNull);put("expectedGraphRevision",revision)},"PUT",enabled=revision==graph["graphRevision"]!!.jsonPrimitive.int,onSuccess={revision=it["graphRevision"]!!.jsonPrimitive.int;onChanged()})
}

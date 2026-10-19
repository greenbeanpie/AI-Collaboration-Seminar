package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import cn.buwei.nativeapp.ReferenceFieldLabel
import cn.buwei.nativeapp.ReferenceOutlinedTextField
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*
import java.util.UUID

@Composable internal fun CreationText(label:String,value:String,onChange:(String)->Unit){ReferenceOutlinedTextField(value,onChange,label=label,aiReference=label!="邀请码标识（每行一个）",modifier=Modifier.fillMaxWidth())}
@Composable internal fun CreationChoice(label:String,value:String,choices:List<Pair<String,String>>,change:(String)->Unit){Text(label,style=MaterialTheme.typography.labelLarge);choices.chunked(2).forEach{row->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(6.dp)){row.forEach{(id,title)->FilterChip(selected=value==id,onClick={change(id)},label={Text(title)})}}}}
@Composable internal fun CreationPayloadFields(payload:JsonObject,change:(JsonObject)->Unit){
 fun field(key:String,value:JsonElement?)=change(creationPatch(payload,key,value))
 CreationText("项目名称",payload.text("name")){field("name",JsonPrimitive(it))}
 CreationText("项目描述",payload.text("description")){field("description",JsonPrimitive(it))}
 val goal=payload.obj("goal")
 CreationText("项目目标",goal.text("title")){field("goal",creationPatch(goal,"title",JsonPrimitive(it)))}
 CreationText("目标详情",goal.text("detail")){field("goal",creationPatch(goal,"detail",JsonPrimitive(it)))}
 CreationText("补充说明",payload.text("brief")){field("brief",JsonPrimitive(it))}
 CreationText("截止日期（YYYY-MM-DD，可留空）",payload.text("deadlineDate")){field("deadlineDate",it.takeIf(String::isNotBlank)?.let(::JsonPrimitive))}
 CreationText("团队人数（1–100）",payload.text("teamSize")){it.toIntOrNull()?.takeIf{n->n in 1..100}?.let{n->field("teamSize",JsonPrimitive(n))}}
 CreationText("邀请用户名（每行一个）",(payload["inviteUsernames"]as? JsonArray).orEmpty().joinToString("\n"){it.jsonPrimitive.content}){field("inviteUsernames",JsonArray(it.lines().filter(String::isNotBlank).map(::JsonPrimitive)))}
 CreationText("邀请码标识（每行一个）",(payload["inviteLabels"]as? JsonArray).orEmpty().joinToString("\n"){it.jsonPrimitive.content}){field("inviteLabels",JsonArray(it.lines().filter(String::isNotBlank).map(::JsonPrimitive)))}
 Row{Checkbox(payload["aiCollaborationEnabled"]?.jsonPrimitive?.booleanOrNull==true,{field("aiCollaborationEnabled",JsonPrimitive(it))});Text("启用 AI 协作")}
 listOf("planningMode" to "任务规划","assignmentMode" to "任务分配","evaluationMode" to "成果评价","progressionMode" to "进度推进").forEach{(key,label)->CreationChoice(label,payload.text(key),listOf("manual" to "手动","automatic" to "自动")){field(key,JsonPrimitive(it))}}
 if(payload["workspace"]is JsonObject)CreationWorkspaceFields(payload.obj("workspace")){field("workspace",it)}
}
@Composable internal fun CreationTasks(tasks:JsonArray,change:(JsonArray)->Unit){
 fun update(index:Int,value:JsonObject)=change(JsonArray(tasks.toMutableList().apply{set(index,value)}))
 tasks.forEachIndexed{index,element->val task=element.jsonObject
  Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
   Text("任务 ${index+1}",style=MaterialTheme.typography.titleMedium)
   listOf("title" to "任务标题","detail" to "任务详情","criteria" to "验收要求").forEach{(key,label)->CreationText(label,task.text(key)){update(index,creationPatch(task,key,JsonPrimitive(it)))}}
   CreationText("预计工时（0.25–200）",task.text("effortHours")){it.toDoubleOrNull()?.takeIf{n->n in .25..200.0}?.let{n->update(index,creationPatch(task,"effortHours",JsonPrimitive(n)))}}
   ReferenceFieldLabel("前置任务")
   tasks.forEachIndexed{otherIndex,other->if(otherIndex!=index){val key=other.jsonObject.text("key");if(key.isNotBlank()){val dependencies=(task["dependsOn"]as? JsonArray).orEmpty();Row{Checkbox(dependencies.any{it.jsonPrimitive.content==key},{checked->update(index,creationPatch(task,"dependsOn",JsonArray(if(checked)dependencies+JsonPrimitive(key)else dependencies.filter{it.jsonPrimitive.content!=key})))});Text(other.jsonObject.text("title").ifBlank{"任务 ${otherIndex+1}"})}}}}
   TextButton({val key=task.text("key");change(JsonArray(tasks.filterIndexed{i,_->i!=index}.map{creationPatch(it.jsonObject,"dependsOn",JsonArray((it.jsonObject["dependsOn"]as? JsonArray).orEmpty().filter{d->d.jsonPrimitive.content!=key}))}))}){Text("删除任务")}
  }}
 }
 OutlinedButton({change(JsonArray(tasks+buildJsonObject{put("key",UUID.randomUUID().toString());put("title","");put("detail","");put("criteria","");put("effortHours",1);put("dependsOn",JsonArray(emptyList()));put("citations",JsonArray(emptyList()))}))},enabled=tasks.size<20){Text("新增任务")}
}
@Composable internal fun CreationWorkspaceFields(workspace:JsonObject,change:(JsonObject)->Unit){
 Text("模板初始资料与标准",style=MaterialTheme.typography.titleLarge)
 val materials=(workspace["materials"]as? JsonArray)?:JsonArray(emptyList())
 fun material(index:Int,next:JsonObject)=change(creationPatch(workspace,"materials",JsonArray(materials.toMutableList().apply{set(index,next)})))
 materials.forEachIndexed{index,item->val value=item.jsonObject;Card{Column(Modifier.padding(10.dp)){
  CreationText("资料标题",value.text("title")){material(index,creationPatch(value,"title",JsonPrimitive(it)))}
  CreationText("资料正文（Markdown）",value.text("markdown")){material(index,creationPatch(value,"markdown",JsonPrimitive(it)))}
  CreationChoice("用途",value.text("purpose"),listOf("background" to "背景","reference" to "参考","output" to "产出")){material(index,creationPatch(value,"purpose",JsonPrimitive(it)))}
  TextButton({change(creationPatch(workspace,"materials",JsonArray(materials.filterIndexed{i,_->i!=index})))}){Text("移除资料")}
 }}}
 OutlinedButton({change(creationPatch(workspace,"materials",JsonArray(materials+buildJsonObject{put("key",UUID.randomUUID().toString());put("title","");put("markdown","");put("purpose","reference")})))},enabled=materials.size<20){Text("新增初始资料")}
 val standard=workspace["standards"]as? JsonObject
 if(standard==null){OutlinedButton({change(creationPatch(workspace,"standards",buildJsonObject{put("title","");put("requirements",JsonArray(emptyList()));put("weights",JsonArray(emptyList()))}))}){Text("添加项目标准")}}else{
  fun save(next:JsonObject)=change(creationPatch(workspace,"standards",next))
  CreationText("标准标题",standard.text("title")){save(creationPatch(standard,"title",JsonPrimitive(it)))}
  CreationText("评分说明",standard.text("notes")){save(creationPatch(standard,"notes",JsonPrimitive(it)))}
  val requirements=(standard["requirements"]as? JsonArray)?:JsonArray(emptyList());val weights=(standard["weights"]as? JsonArray)?:JsonArray(emptyList())
  requirements.forEachIndexed{index,item->val requirement=item.jsonObject
   fun update(key:String,value:JsonElement?)=save(creationPatch(standard,"requirements",JsonArray(requirements.toMutableList().apply{set(index,creationPatch(requirement,key,value))})))
   Card{Column(Modifier.padding(10.dp)){
    CreationText("要求标题",requirement.text("title")){update("title",JsonPrimitive(it))};CreationText("要求详情",requirement.text("detail")){update("detail",JsonPrimitive(it))}
    CreationChoice("要求类型",requirement.text("category"),listOf("deadline" to "期限","deliverable" to "交付","format" to "格式","scoring" to "评分","team" to "团队","other" to "其他")){update("category",JsonPrimitive(it))}
    CreationText("要求截止日期或 ISO 时间（可留空）",requirement.text("dueDate")){update("dueDate",it.takeIf(String::isNotBlank)?.let(::JsonPrimitive))}
    CreationChoice("日期精度",requirement.text("duePrecision"),listOf("unknown" to "未指定","date" to "日期","datetime" to "时间")){update("duePrecision",JsonPrimitive(it))}
    CreationChoice("评分维度",requirement.text("dimensionKey"),listOf("" to "不关联")+weights.map{it.jsonObject.text("key") to it.jsonObject.text("label")}){update("dimensionKey",it.takeIf(String::isNotBlank)?.let(::JsonPrimitive))}
    TextButton({save(creationPatch(standard,"requirements",JsonArray(requirements.filterIndexed{i,_->i!=index})))}){Text("删除要求")}
   }}
  }
  OutlinedButton({save(creationPatch(standard,"requirements",JsonArray(requirements+buildJsonObject{put("key",UUID.randomUUID().toString());put("title","");put("detail","");put("category","deliverable")})))},enabled=requirements.size<100){Text("新增要求")}
  weights.forEachIndexed{index,item->val weight=item.jsonObject
   fun update(key:String,value:JsonElement)=save(creationPatch(standard,"weights",JsonArray(weights.toMutableList().apply{set(index,creationPatch(weight,key,value))})))
   CreationText("评分维度名称",weight.text("label")){update("label",JsonPrimitive(it))};CreationText("权重（0–100）",weight.text("weight")){it.toDoubleOrNull()?.takeIf{n->n in 0.0..100.0}?.let{n->update("weight",JsonPrimitive(n))}}
   TextButton({val key=weight.text("key");save(creationPatch(creationPatch(standard,"weights",JsonArray(weights.filterIndexed{i,_->i!=index})),"requirements",JsonArray(requirements.map{if(it.jsonObject.text("dimensionKey")==key)creationPatch(it.jsonObject,"dimensionKey",null)else it})))}){Text("删除评分维度")}
  }
  OutlinedButton({save(creationPatch(standard,"weights",JsonArray(weights+buildJsonObject{put("key",UUID.randomUUID().toString());put("label","");put("weight",1)})))},enabled=weights.size<10){Text("新增评分维度")}
  TextButton({change(creationPatch(workspace,"standards",JsonNull))}){Text("移除标准")}
 }
}

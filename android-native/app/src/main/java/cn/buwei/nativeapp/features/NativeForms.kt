package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

internal fun JsonObject.text(key:String):String = (get(key) as? JsonPrimitive)?.contentOrNull.orEmpty()
internal fun JsonObject.obj(key:String):JsonObject = get(key) as? JsonObject ?: JsonObject(emptyMap())
internal fun JsonObject.flag(key:String):Boolean = (get(key) as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.kind():String = when(val t=get("type")){is JsonArray->t.firstOrNull { it.toString()!="\"null\"" }?.jsonPrimitive?.content;is JsonPrimitive->t.content;else->null} ?: if(containsKey("properties"))"object" else "string"
internal val labels=mapOf(
 "title" to "标题","name" to "名称","description" to "说明","detail" to "任务内容","criteria" to "验收要求","body" to "正文","content" to "内容","text" to "原文","url" to "网页地址","recipientId" to "收件人成员 ID","assigneeId" to "负责人 ID","expectedRevision" to "保存基于的版本","revision" to "版本","status" to "状态","purpose" to "用途","dueDate" to "截止日期","deadlineDate" to "项目截止日期","markdown" to "正文","displayName" to "显示名称","email" to "邮箱","username" to "用户名","password" to "密码","instruction" to "给 AI 的指令","code" to "邀请码","query" to "搜索词",
 "kind" to "类型","currentVersion" to "当前版本","attachments" to "附件","createdAt" to "创建时间","updatedAt" to "更新时间","finishedAt" to "结束时间","startedAt" to "开始时间","joinedAt" to "加入时间","archivedAt" to "归档时间","deletedAt" to "移入回收站时间","expiresAt" to "有效期至","readAt" to "阅读时间","lifecycleState" to "任务进展","myRole" to "我的角色","role" to "角色","assigneeName" to "负责人","authorName" to "作者","requesterName" to "发起人","recipientName" to "收件人","origin" to "来源","summary" to "摘要","summaryStatus" to "摘要状态","summaryError" to "摘要处理说明","error" to "处理说明","message" to "消息","reason" to "原因","note" to "备注","notes" to "备注","feedback" to "反馈","question" to "问题","answer" to "回答","questions" to "问题","answers" to "回答","turns" to "问答记录","runs" to "执行记录","report" to "报告","result" to "结果","ticket" to "工单","messages" to "会话","scope" to "范围","mode" to "模式","capability" to "辅助能力","category" to "分类","urgency" to "紧急程度","quote" to "引用原文","locator" to "引用位置","pageNumber" to "页码","references" to "参考资料","citations" to "引用","score" to "得分","scores" to "评分","totalScore" to "总分","maxScore" to "满分","weight" to "权重","weights" to "评分权重","dimensions" to "评分维度","requirements" to "要求","items" to "记录","tasks" to "任务","materials" to "材料","sources" to "来源资料","files" to "文件","goal" to "项目目标","goals" to "项目目标","standards" to "评估标准","preview" to "预览","payload" to "项目信息","workspace" to "初始资料","members" to "成员","invitations" to "邀请","planningMode" to "规划方式","assignmentMode" to "分工方式","evaluationMode" to "评价方式","progressionMode" to "推进方式","aiCollaborationEnabled" to "AI 智能协作","teamSize" to "团队人数","inviteUsernames" to "邀请用户名","inviteLabels" to "邀请说明","brief" to "项目简述","effortHours" to "预计工时","pendingHumanReview" to "等待人工审阅","processingStatus" to "处理状态","availability" to "可用状态","contributors" to "贡献者","sizeBytes" to "文件大小","mimeType" to "文件格式","fileName" to "文件名","totalCount" to "总记录数","unreadCount" to "未读数","workload" to "任务数量","ai" to "AI 用量","storage" to "存储用量","usedBytes" to "已用空间","limitBytes" to "空间额度","used" to "已用","limit" to "额度","remaining" to "剩余","provider" to "服务提供方","model" to "模型","enabled" to "已启用","timezone" to "时区","locale" to "语言","resourceType" to "资料类型","retrievalStatus" to "正文检索状态","parsingStatus" to "正文解析状态","processing" to "处理进度","warnings" to "注意事项","warning" to "注意事项","missing" to "待补充内容","statusLabel" to "状态说明","label" to "名称","recommendations" to "建议","strengths" to "优势","weaknesses" to "不足","issues" to "问题","rubric" to "评分标准","history" to "历史记录","version" to "版本","permissions" to "成员权限","teamManage" to "团队管理","taskManage" to "任务管理","resourceManage" to "资料管理","scoreInitiate" to "发起评估","scoreCorrect" to "修正评分")
internal fun label(key:String)=labels[key]?:key

internal fun businessFieldVisible(key:String):Boolean =
 key!="id"&&!key.endsWith("Id")&&!key.endsWith("Ids")&&!(key.startsWith("can")&&key.getOrNull(3)?.isUpperCase()==true)&&!key.endsWith("Hash")&&!key.endsWith("Token")&&!key.endsWith("Secret")&&!key.endsWith("Key")&&
 key !in setOf("requestId","nextCursor","cursor","doc","attrs","marks","type","lifecycleVersion","expectedRevision","expectedGraphRevision","graphRevision","previewRevision","previewAttemptId","generation","execution","activity","retry","retryAfter","attempts","systemManaged","key","seq","sequence","sha256","r2Key","storageKey","uploadUrl","downloadUrl","endpoint","apiKey","token","secret","permissionsRevision","duePrecision","deadlinePrecision","receivedAt","isAdmin","accountId","hasPassword","hasToken","hasSecret","raw","rawResponse","headers","request","response")

internal fun businessValue(key:String,value:JsonPrimitive):String {
 val raw=value.contentOrNull?:return ""
 value.booleanOrNull?.takeIf{!value.isString}?.let{return if(it)"是"else"否"}
 if(key.endsWith("At"))runCatching{java.time.Instant.parse(raw).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))}.getOrNull()?.let{return it}
 if(key in setOf("sizeBytes","usedBytes","limitBytes")){raw.toLongOrNull()?.let{bytes->return when{bytes>=1073741824->String.format(java.util.Locale.ROOT,"%.1f GB",bytes/1073741824.0);bytes>=1048576->String.format(java.util.Locale.ROOT,"%.1f MB",bytes/1048576.0);bytes>=1024->String.format(java.util.Locale.ROOT,"%.1f KB",bytes/1024.0);else->"$bytes B"}}}
 if(key !in setOf("status","lifecycleState","summaryStatus","processingStatus","parsingStatus","availability","kind","purpose","myRole","role","origin","mode","planningMode","assignmentMode","evaluationMode","progressionMode","scope","category","urgency","resourceType","capability"))return raw
 return mapOf("active" to "进行中","archived" to "已归档","deleted" to "已移入回收站","todo" to "待开始","doing" to "进行中","blocked" to "遇到阻碍","done" to "已完成","open" to "待领取","in_progress" to "进行中","submitted" to "已提交","accepted" to "已通过","improve" to "待完善","rework" to "需返工","queued" to "等待处理","running" to "处理中","pending" to "待处理","waiting_input" to "等待补充信息","waiting_user" to "等待回复","succeeded" to "已完成","failed" to "处理失败","cancelled" to "已取消","completed" to "已完成","complete" to "已完成","partial" to "部分完成","ready" to "已就绪","missing" to "待生成","disabled" to "未启用","resolved" to "已解决","closed" to "已关闭","owner" to "负责人","member" to "成员","admin" to "管理员","super_admin" to "超级管理员","user" to "用户","assistant" to "AI 助手","manual" to "手动","automatic" to "自动","ai" to "AI 辅助","ai_adoption" to "采纳 AI 成果","document" to "文档","paste" to "粘贴文本","web" to "网页","file" to "文件","source" to "来源资料","material" to "成果材料","background" to "背景资料","reference" to "参考资料","output" to "成果","unavailable" to "暂不可用","low" to "较低","normal" to "普通","high" to "较高","urgent" to "紧急","interface" to "界面","functionality" to "功能","account" to "账户","performance" to "性能","other" to "其他","project" to "项目","team" to "团队","task" to "任务","teach" to "带做","assist" to "帮做","substitute" to "代做")[raw]?:raw
}

internal fun richDocumentText(node:JsonObject):String {
 if(node.text("type")=="text")return node.text("text")
 if(node.text("type")=="hardBreak")return "\n"
 val children=(node["content"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}
 return children.joinToString(if(node.text("type")in setOf("tableRow"))" │ "else if(node.text("type")in setOf("table","doc","bulletList","orderedList"))"\n"else""){richDocumentText(it)}
}

internal fun initialValue(schema:JsonObject):JsonElement? = schema["default"] ?: when(schema.kind()){
 "object"->JsonObject(emptyMap());"array"->JsonArray(emptyList());else->null
}

/** Typed controls keep nested arrays and objects editable without a raw JSON console. */
@Composable
internal fun SchemaField(name:String,schema:JsonObject,value:JsonElement?,required:Boolean=false,onChange:(JsonElement?)->Unit) {
 val alternatives=(schema["oneOf"]?:schema["anyOf"]) as? JsonArray
 if(!alternatives.isNullOrEmpty()){
  var selected by remember(name){mutableIntStateOf(0)}
  Column(verticalArrangement=Arrangement.spacedBy(6.dp)) {
   Text(label(name),style=MaterialTheme.typography.titleSmall)
   alternatives.forEachIndexed { i,s-> FilterChip(selected==i,{selected=i;onChange(initialValue(s.jsonObject))},label={Text("方案 ${i+1}")}) }
   SchemaField(name,alternatives[selected].jsonObject,value,required,onChange)
  };return
 }
 val enabled=required||value!=null
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(6.dp)){
  if(!required) Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(label(name));Switch(enabled,{onChange(if(it)initialValue(schema)?:JsonPrimitive("") else null)})}
  if(enabled)when(schema.kind()){
   "object"->{
    val current=value as? JsonObject?:JsonObject(emptyMap());val props=schema["properties"] as? JsonObject?:JsonObject(emptyMap())
    val requiredFields=(schema["required"] as? JsonArray)?.map{it.jsonPrimitive.content}.orEmpty()
    if(required)Text(label(name),style=MaterialTheme.typography.titleSmall)
    Column(Modifier.padding(start=8.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
     props.forEach{(k,s)-> SchemaField(k,s.jsonObject,current[k],k in requiredFields){v->onChange(JsonObject(current.toMutableMap().apply{if(v==null)remove(k) else put(k,v)}))} }
     if(props.isEmpty()){
      var newKey by remember(name){mutableStateOf("")}
      current.forEach{(k,v)->SchemaField(k,inferSchema(v),v,true){n->onChange(JsonObject(current.toMutableMap().apply{if(n==null)remove(k)else put(k,n)}))};TextButton({onChange(JsonObject(current-k))}){Text("移除 $k")}}
      OutlinedTextField(newKey,{newKey=it},label={Text("新字段名称")},modifier=Modifier.fillMaxWidth())
      Row{TextButton({if(newKey.isNotBlank()){onChange(JsonObject(current+(newKey to JsonPrimitive(""))));newKey=""}}){Text("添加文本")};TextButton({if(newKey.isNotBlank()){onChange(JsonObject(current+(newKey to JsonObject(emptyMap()))));newKey=""}}){Text("添加对象")};TextButton({if(newKey.isNotBlank()){onChange(JsonObject(current+(newKey to JsonArray(emptyList()))));newKey=""}}){Text("添加列表")}}
     }
    }
   }
   "array"->{val items=value as? JsonArray?:JsonArray(emptyList());val itemSchema=schema["items"] as? JsonObject?:JsonObject(emptyMap())
    Text("${label(name)} · ${items.size} 项",style=MaterialTheme.typography.titleSmall)
    items.forEachIndexed{i,v->Card{Column(Modifier.padding(10.dp)){SchemaField("第 ${i+1} 项",itemSchema,v,true){n->onChange(JsonArray(items.toMutableList().apply{set(i,n?:JsonNull)}))};TextButton({onChange(JsonArray(items.filterIndexed{j,_->j!=i}))}){Text("移除")}}}}
    OutlinedButton({onChange(JsonArray(items+(initialValue(itemSchema)?:JsonPrimitive(""))))},enabled=items.size<(schema["maxItems"]?.jsonPrimitive?.intOrNull?:1000)){Text("添加${label(name)}")}
   }
   "boolean"->Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.SpaceBetween){Text(label(name));Switch((value as? JsonPrimitive)?.booleanOrNull?:false,{onChange(JsonPrimitive(it))})}
   else->{val enums=schema["enum"] as? JsonArray
    if(!enums.isNullOrEmpty()){
     Text(label(name),style=MaterialTheme.typography.labelLarge)
     enums.forEach{option->FilterChip(value==option,{onChange(option)},label={Text(option.jsonPrimitive.content)})}
    }else{
     val number=schema.kind() in listOf("integer","number");val secret=name.contains("password",true)||name.contains("secret",true)||name.contains("token",true)||name.endsWith("Key")
     OutlinedTextField((value as? JsonPrimitive)?.contentOrNull.orEmpty(),{s->onChange(if(number)s.toLongOrNull()?.let{JsonPrimitive(it)}?:s.toDoubleOrNull()?.let{JsonPrimitive(it)}?:JsonPrimitive(s) else JsonPrimitive(s))},modifier=Modifier.fillMaxWidth(),label={Text(label(name)+(if(required)" *" else ""))},minLines=if(name in listOf("body","text","markdown","detail","instruction"))3 else 1,keyboardOptions=KeyboardOptions(keyboardType=if(number)KeyboardType.Decimal else KeyboardType.Text),visualTransformation=if(secret)PasswordVisualTransformation()else VisualTransformation.None,supportingText={schema.text("description").takeIf{it.isNotBlank()}?.let{Text(it)}})
    }
   }
  }
 }
}

private fun inferSchema(value:JsonElement):JsonObject=buildJsonObject {put("type",when(value){is JsonObject->"object";is JsonArray->"array";else->if((value as? JsonPrimitive)?.booleanOrNull!=null)"boolean"else"string"})}

internal fun validate(schema:JsonObject,value:JsonElement?,path:String="表单"):String? {
 if(value==JsonNull){val types=schema["type"];if(types?.toString()=="\"null\""||types is JsonArray&&types.any{it.toString()=="\"null\""})return null}
 val variants=(schema["oneOf"]?:schema["anyOf"]) as? JsonArray
 if(!variants.isNullOrEmpty())return if(variants.any{validate(it.jsonObject,value,path)==null})null else "$path 不符合任何允许的格式"
 if(value==null)return "$path 必填"
 when(schema.kind()){
  "object"->{if(value !is JsonObject)return "$path 需要对象";val props=schema["properties"] as? JsonObject?:JsonObject(emptyMap());val required=(schema["required"] as? JsonArray)?.map{it.jsonPrimitive.content}.orEmpty();required.forEach{if(value[it]==null)return "${label(it)} 必填"};value.forEach{(k,v)->props[k]?.let{validate(it.jsonObject,v,"$path / ${label(k)}")?.let{return it}}}}
  "array"->{if(value !is JsonArray)return "$path 需要列表";val min=schema["minItems"]?.jsonPrimitive?.intOrNull?:0;val max=schema["maxItems"]?.jsonPrimitive?.intOrNull?:Int.MAX_VALUE;if(value.size !in min..max)return "$path 条目数需要在 $min 到 $max 之间";value.forEachIndexed{i,v->validate(schema.obj("items"),v,"$path 第 ${i+1} 项")?.let{return it}}}
  "boolean"->if((value as? JsonPrimitive)?.booleanOrNull==null)return "$path 需要开关值"
  "integer","number"->{val p=value as? JsonPrimitive;val n=p?.doubleOrNull;if(n==null||p?.isString==true||!n.isFinite())return "$path 需要数字";if(schema.kind()=="integer"&&n%1.0!=0.0)return "$path 需要整数";schema["minimum"]?.jsonPrimitive?.doubleOrNull?.let{if(n<it)return "$path 最小为 $it"};schema["maximum"]?.jsonPrimitive?.doubleOrNull?.let{if(n>it)return "$path 最大为 $it"};schema["exclusiveMinimum"]?.jsonPrimitive?.doubleOrNull?.let{if(n<=it)return "$path 需要大于 $it"}}
  else->{val s=(value as? JsonPrimitive)?.contentOrNull?:return "$path 需要文本";val min=schema["minLength"]?.jsonPrimitive?.intOrNull?:0;val max=schema["maxLength"]?.jsonPrimitive?.intOrNull?:Int.MAX_VALUE;if(s.length !in min..max)return "$path 长度需要在 $min 到 $max 之间";schema.text("pattern").takeIf{it.isNotEmpty()}?.let{p->if(runCatching{Regex(p).containsMatchIn(s)}.getOrDefault(true).not())return "$path 格式不正确"};if(schema.text("format")=="uuid"&&!Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").matches(s))return "$path 需要有效的 ID"}
 }
 (schema["enum"] as? JsonArray)?.let{if(value !in it)return "$path 需要选择允许的值"}
 return null
}

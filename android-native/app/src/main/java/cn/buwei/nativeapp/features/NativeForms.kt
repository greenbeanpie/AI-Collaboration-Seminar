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
internal val labels=mapOf("title" to "标题","name" to "名称","description" to "说明","detail" to "任务内容","criteria" to "验收要求","body" to "正文","content" to "内容","text" to "原文","url" to "网页地址","recipientId" to "收件人成员 ID","assigneeId" to "负责人 ID","expectedRevision" to "保存基于的版本","revision" to "版本","status" to "状态","purpose" to "用途","dueDate" to "截止日期","deadlineDate" to "项目截止日期","markdown" to "Markdown 正文","displayName" to "显示名称","email" to "邮箱","username" to "用户名","password" to "密码","instruction" to "给 AI 的指令","code" to "邀请码","query" to "搜索词")
internal fun label(key:String)=labels[key]?:key

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

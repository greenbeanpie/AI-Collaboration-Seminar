package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

/** Only text leaves are changed. Marks, attributes, references, tables and unknown nodes round-trip. */
@Composable
internal fun NativeRichMaterialEditor(repository:ClientRepository,path:String,material:JsonObject){
 var editing by remember(path){mutableStateOf(false)}
 var savedDocument by rememberSaveable(path){mutableStateOf(material.obj("currentVersion").obj("doc").toString())}
 val document=remember(savedDocument){Json.parseToJsonElement(savedDocument).jsonObject}
 var busy by remember{mutableStateOf(false)};var result by remember{mutableStateOf<String?>(null)};var revision by remember(path){mutableStateOf(material["revision"]?:JsonPrimitive(1))};val scope=rememberCoroutineScope();val intentKey=remember(savedDocument,revision){UUID.randomUUID().toString()}
 if(!editing){OutlinedButton({editing=true}){Text("编辑正文")};result?.let{Text(it)};return}
 Text("编辑版本 ${revision.jsonPrimitive.content} · 保留原有块、格式、表格与引用",style=MaterialTheme.typography.bodySmall)
 RichNodeEditor(document,0){savedDocument=it.toString()}
 result?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
  Button({busy=true;scope.launch{try{
   // Omit markdown intentionally: backend material API derives it through docToMarkdown.
   val response=repository.request("PUT",path,buildJsonObject{put("expectedRevision",revision);put("doc",document);put("attachmentIds",JsonArray((material.obj("currentVersion")["attachments"]as? JsonArray)?.mapNotNull{it.jsonObject["fileId"]}.orEmpty()))},intentKey)
   if(response.flag("queued")){result="已保存到本机，等待联网同步；服务端版本未更新。同步完成后请刷新核对，再继续编辑。"}else{revision=response["revision"]?:revision;result="已保存新版本"};editing=false
  }catch(e:CancellationException){throw e}catch(e:Exception){result=(e.message?:"保存失败")+"；编辑内容已保留。版本冲突时先复制内容，再刷新核对。"}finally{busy=false}}},enabled=!busy){Text("保存新版本")}
  TextButton({editing=false},enabled=!busy){Text("暂存编辑并返回")}
 }
}

@Composable
private fun RichNodeEditor(node:JsonObject,depth:Int,onChange:(JsonObject)->Unit){
 val type=node.text("type");val children=node["content"]as? JsonArray
 if(depth>30){Text("保留较深层级内容（未展开编辑）");return}
 when{
  type=="text"->{OutlinedTextField(node.text("text"),{newText->onChange(editRichText(node,emptyList(),newText))},modifier=Modifier.fillMaxWidth(),label={Text(if(node["marks"]is JsonArray)"文字 · 保留格式标记"else"文字")},minLines=1)}
  children!=null->{
   val names=mapOf("doc" to "正文","paragraph" to "段落","heading" to "标题","bulletList" to "无序列表","orderedList" to "有序列表","listItem" to "列表项","table" to "表格","tableRow" to "行","tableCell" to "单元格","tableHeader" to "表头","blockquote" to "引用","codeBlock" to "代码块")
   Column(Modifier.fillMaxWidth().padding(start=if(depth==0)0.dp else 6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
    if(type!="doc")Text(names[type]?:"保留节点 $type",style=MaterialTheme.typography.labelMedium)
    children.forEachIndexed{index,child->if(child is JsonObject)RichNodeEditor(child,depth+1){updated->onChange(JsonObject(node+("content" to JsonArray(children.toMutableList().apply{set(index,updated)}))))}}
    if(children.isEmpty()&&type in listOf("paragraph","heading","codeBlock"))OutlinedButton({onChange(JsonObject(node+("content" to buildJsonArray{add(buildJsonObject{put("type","text");put("text","新文字")})})))}){Text("添加文字")}
    if(type=="doc")OutlinedButton({onChange(JsonObject(node+("content" to JsonArray(children+buildJsonObject{put("type","paragraph");put("content",buildJsonArray{add(buildJsonObject{put("type","text");put("text","新段落")})})}))))}){Text("添加段落")}
   }
  }
  type=="hardBreak"->Text("↵",style=MaterialTheme.typography.bodySmall)
  else->Text("${if(type.isBlank())"附加"else type}节点 · 已保留${node.obj("attrs").text("label").takeIf{it.isNotBlank()}?.let{"：$it"}.orEmpty()}",style=MaterialTheme.typography.bodySmall)
 }
}

/** A narrow edit changes one text leaf while retaining every sibling and metadata value. */
internal fun editRichText(node:JsonObject,indices:List<Int>,text:String):JsonObject{
 if(indices.isEmpty()){require(node.text("type")=="text"){"Only text nodes can be changed"};return JsonObject(node+("text" to JsonPrimitive(text)))}
 val children=node["content"]as? JsonArray?:error("Missing rich document content")
 val index=indices.first();require(index in children.indices){"Text position outside document"}
 val child=children[index]as? JsonObject?:error("Invalid document node")
 return JsonObject(node+("content" to JsonArray(children.toMutableList().apply{set(index,editRichText(child,indices.drop(1),text))})))
}

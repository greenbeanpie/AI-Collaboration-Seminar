package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*

@Composable internal fun RichBlockEditor(node:JsonObject,path:List<Int>,enabled:Boolean,onChange:(JsonObject)->Unit,onSelection:(RichSelection)->Unit) {
    val type=node.text("type");val children=(node["content"]as? JsonArray).orEmpty()
    if(path.size>30){Text("此处为较深的嵌套内容，保存时保持原样");return}
    if(type=="text") {
        var field by remember(path){mutableStateOf(TextFieldValue(node.text("text")))}
        LaunchedEffect(node.text("text")){if(field.text!=node.text("text"))field=TextFieldValue(node.text("text"),TextRange(field.selection.min.coerceAtMost(node.text("text").length)))}
        OutlinedTextField(field,{value->field=value;if(value.text!=node.text("text"))onChange(editRichText(node,emptyList(),value.text));onSelection(RichSelection(path,value.selection))},modifier=Modifier.fillMaxWidth().onFocusChanged{if(it.isFocused)onSelection(RichSelection(path,field.selection))},enabled=enabled,label={Text("文字")},minLines=1)
        return
    }
    if(type in listOf("hardBreak","horizontalRule")){Text(if(type=="hardBreak")"换行"else"分隔线");return}
    val names=mapOf("doc" to "正文","paragraph" to "段落","heading" to "标题","bulletList" to "无序列表","orderedList" to "有序列表","listItem" to "列表项","table" to "表格","tableRow" to "行","tableCell" to "单元格","tableHeader" to "表头","blockquote" to "引用","codeBlock" to "代码块")
    if(type !in names){Text(if(type=="citation")"已保留原文引用"else"已保留附加内容",style=MaterialTheme.typography.bodySmall);return}
    Column(Modifier.fillMaxWidth().padding(start=if(path.isEmpty())0.dp else 6.dp),verticalArrangement=Arrangement.spacedBy(6.dp)) {
        if(type!="doc")Text(names[type].orEmpty(),style=MaterialTheme.typography.labelMedium)
        if(type in listOf("paragraph","heading","codeBlock")) {
            var expanded by remember{mutableStateOf(false)}
            Box {TextButton(onClick={expanded=true},enabled=enabled){Text("段落样式")};DropdownMenu(expanded,onDismissRequest={expanded=false}) {
                listOf("paragraph" to "正文段落","heading2" to "二级标题","heading3" to "三级标题","codeBlock" to "代码块").forEach {(style,title)->DropdownMenuItem(text={Text(title)},onClick={
                    expanded=false;onChange(JsonObject(node+mapOf("type" to JsonPrimitive(if(style.startsWith("heading"))"heading"else style),"attrs" to JsonObject(node.obj("attrs")+if(style.startsWith("heading"))mapOf("level" to JsonPrimitive(style.last().digitToInt()))else emptyMap()))))
                })}
            }}
        }
        var deleteIndex by remember{mutableStateOf<Int?>(null)}
        children.forEachIndexed {index,element->val child=element as? JsonObject?:return@forEachIndexed
            key(index,child.text("type")) {
                RichBlockEditor(child,path+index,enabled,{updated->onChange(richReplaceChildren(node,richChildren(node).toMutableList().apply{set(index,updated)}))},onSelection)
                if(child.text("type")!="text")FlowRow(horizontalArrangement=Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick={onChange(richMoveChild(node,index,-1))},enabled=enabled&&index>0&&type!="table"&&type!="tableRow"){Text("上移")}
                    TextButton(onClick={onChange(richMoveChild(node,index,1))},enabled=enabled&&index<children.lastIndex&&type!="table"&&type!="tableRow"){Text("下移")}
                    TextButton(onClick={deleteIndex=index},enabled=enabled&&(type=="doc"||(children.size>1&&type !in listOf("table","tableRow")))){Text("删除内容块")}
                }
            }
        }
        if(deleteIndex!=null)AlertDialog(onDismissRequest={deleteIndex=null},title={Text("删除此内容块？")},text={Text("当前编辑中的整块内容将移除；保存前可撤销。")},confirmButton={TextButton(onClick={val index=deleteIndex!!;deleteIndex=null;onChange(richReplaceChildren(node,richChildren(node).filterIndexed{i,_->i!=index}))}){Text("删除内容块")}},dismissButton={TextButton(onClick={deleteIndex=null}){Text("取消")}})
        if(type=="doc") {
            var expanded by remember{mutableStateOf(false)}
            FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
                OutlinedButton(onClick={onChange(richReplaceChildren(node,richChildren(node)+richParagraph("新段落")))},enabled=enabled){Text("添加段落")}
                Box{OutlinedButton(onClick={expanded=true},enabled=enabled){Text("插入内容块")};DropdownMenu(expanded,onDismissRequest={expanded=false}){
                    listOf("heading" to "标题","bulletList" to "无序列表","orderedList" to "有序列表","blockquote" to "引用块","codeBlock" to "代码块","table" to "3 × 3 表格","horizontalRule" to "分隔线").forEach{(kind,title)->DropdownMenuItem(text={Text(title)},onClick={expanded=false;onChange(richReplaceChildren(node,richChildren(node)+richBlock(kind)))})}
                }}
            }
        }
        if(children.isEmpty()&&type in listOf("paragraph","heading","codeBlock"))OutlinedButton(onClick={onChange(richReplaceChildren(node,listOf(buildJsonObject{put("type","text");put("text","新文字")})))},enabled=enabled){Text("添加文字")}
        if(type in listOf("bulletList","orderedList"))OutlinedButton(onClick={onChange(richReplaceChildren(node,richChildren(node)+richNode("listItem",listOf(richParagraph("新列表项")))))},enabled=enabled){Text("添加列表项")}
        if(type in listOf("listItem","tableCell","tableHeader","blockquote"))TextButton(onClick={onChange(richReplaceChildren(node,richChildren(node)+richParagraph("新段落")))},enabled=enabled){Text("添加单元段落")}
        if(type=="table")FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick={onChange(richTableAddRow(node))},enabled=enabled){Text("添加表格行")}
            OutlinedButton(onClick={onChange(richTableAddColumn(node))},enabled=enabled){Text("添加表格列")}
        }
    }
}

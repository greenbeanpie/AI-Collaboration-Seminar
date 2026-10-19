package cn.buwei.nativeapp.features

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlinx.serialization.json.*

/** Render stored JSON directly: a server Markdown export may omit tables or unknown nodes. */
@Composable internal fun ReadOnlyRichDocument(node:JsonObject){
    val blocks=remember(node){nativeRichDocumentBlocks(node)}
    NativeTextBlocksContent(blocks,LocalNativeContentNavigation.current)
}

private fun documentChildren(node:JsonObject)=(node["content"] as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}
private fun documentMarks(node:JsonObject):NativeMarkdownInline{
    val marks=(node["marks"] as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}
    fun has(kind:String)=marks.any{it.text("type")==kind}
    return NativeMarkdownInline(node.text("text"),has("bold"),has("italic"),has("strike"),has("code"),marks.lastOrNull{it.text("type")=="link"}?.obj("attrs")?.text("href"),has("underline"))
}

/** Iterative traversal preserves deep content without a silent depth cutoff or recursive stack. */
internal fun nativeRichDocumentInline(root:JsonObject):List<NativeMarkdownInline>{
    data class Pending(val node:JsonObject?,val separator:Boolean=false)
    val pending=ArrayDeque<Pending>();pending.addLast(Pending(root));val runs=mutableListOf<NativeMarkdownInline>()
    while(pending.isNotEmpty()){
        val item=pending.removeLast()
        if(item.separator){if(runs.isNotEmpty()&&!runs.last().text.endsWith('\n'))runs+=NativeMarkdownInline("\n");continue}
        val node=item.node?:continue;val type=node.text("type");val attrs=node.obj("attrs")
        when(type){
            "text"->runs+=documentMarks(node)
            "hardBreak"->runs+=NativeMarkdownInline("\n")
            "image"->runs+=NativeMarkdownInline("图片："+attrs.text("alt").ifBlank{attrs.text("title")}.ifBlank{"图片附件"})
            "citation","sourceCitation","reference"->{
                runs+=NativeMarkdownInline("引用："+attrs.text("label").ifBlank{attrs.text("title")}.ifBlank{"资料"},href=attrs.text("href").takeIf{it.isNotBlank()})
                listOf("sourceVersionId","materialVersionId","locator","quote").forEach{key->attrs.text(key).takeIf{it.isNotBlank()}?.let{value->runs+=NativeMarkdownInline("\n${label(key)}：$value")}}
            }
            else->{
                val children=documentChildren(node)
                if(type=="codeBlock"){
                    // Only text inside a code block is literal; no Markdown parser is involved.
                    val text=StringBuilder();val textNodes=ArrayDeque<JsonObject>();textNodes.addLast(node)
                    while(textNodes.isNotEmpty()){val part=textNodes.removeLast();if(part.text("type")=="text")text.append(part.text("text"))else if(part.text("type")=="hardBreak")text.append('\n')else documentChildren(part).asReversed().forEach{textNodes.addLast(it)}}
                    runs+=NativeMarkdownInline(text.toString(),code=true)
                }else if(children.isNotEmpty()){
                    children.asReversed().forEachIndexed{index,child->
                        if(index>0&&child.text("type") in listOf("paragraph","heading","listItem","tableRow","codeBlock"))pending.addLast(Pending(null,true))
                        pending.addLast(Pending(child))
                    }
                }else if(node.text("text").isNotEmpty())runs+=NativeMarkdownInline(node.text("text"))
                else if(type !in listOf("doc","paragraph","heading","listItem","tableCell","tableHeader"))runs+=NativeMarkdownInline("此内容块暂不支持显示（$type），原始内容仍保留")
            }
        }
    }
    return runs
}

internal fun nativeRichDocumentBlocks(root:JsonObject):List<NativeMarkdownBlock>{
    data class Pending(val node:JsonObject,val depth:Int=0,val marker:String="",val quoted:Boolean=false)
    val pending=ArrayDeque<Pending>();pending.addLast(Pending(root));val blocks=mutableListOf<NativeMarkdownBlock>()
    fun emit(kind:String,runs:List<NativeMarkdownInline>,item:Pending,level:Int=0){
        nativeMarkdownInlineChunks(runs).forEachIndexed{part,chunk->blocks+=NativeMarkdownBlock(if(item.marker.isNotBlank())"list" else if(item.quoted)"quote" else kind,chunk,level,if(part==0)item.marker else "",minOf(item.depth,5))}
    }
    while(pending.isNotEmpty()){
        val item=pending.removeLast();val node=item.node;val type=node.text("type");val children=documentChildren(node)
        when(type){
            "doc","listItem"->children.asReversed().forEachIndexed{index,child->pending.addLast(item.copy(node=child,marker=if(index==children.lastIndex)item.marker else "",depth=item.depth+if(type=="listItem"&&child.text("type") in listOf("bulletList","orderedList"))1 else 0))}
            "bulletList","orderedList"->{
                val start=(node.obj("attrs")["start"] as? JsonPrimitive)?.intOrNull?:1
                children.asReversed().forEachIndexed{index,child->val position=children.lastIndex-index;pending.addLast(item.copy(node=child,depth=if(item.marker.isNotBlank())item.depth+1 else item.depth,marker=if(type=="orderedList")"${start.toLong()+position}." else "•"))}
            }
            "blockquote"->children.asReversed().forEach{pending.addLast(item.copy(node=it,quoted=true,depth=item.depth+1))}
            "heading"->emit("heading",nativeRichDocumentInline(node),item,((node.obj("attrs")["level"]as? JsonPrimitive)?.intOrNull?:2).coerceIn(1,6))
            "horizontalRule"->blocks+=NativeMarkdownBlock("rule")
            "codeBlock"->nativeMarkdownChunks(nativeRichDocumentInline(node).joinToString(""){it.text}).forEach{blocks+=NativeMarkdownBlock("code",code=it,language=node.obj("attrs").text("language"))}
            "table"->{
                // Stacked cells wrap on phones and keep row/column boundaries without horizontal scrolling.
                children.forEachIndexed{rowIndex,row->
                    blocks+=NativeMarkdownBlock("heading",listOf(NativeMarkdownInline("表格 · 第 ${rowIndex+1} 行")),level=4)
                    documentChildren(row).forEachIndexed{columnIndex,cell->
                        val attrs=cell.obj("attrs");val span=listOf("colspan" to "列","rowspan" to "行").mapNotNull{(key,unit)->(attrs[key] as? JsonPrimitive)?.intOrNull?.takeIf{it>1}?.let{"合并 $it $unit"}}.joinToString("、")
                        blocks+=NativeMarkdownBlock("heading",listOf(NativeMarkdownInline("单元格 ${columnIndex+1}"+(if(span.isBlank())"" else "（$span）"))),level=5)
                        val runs=nativeRichDocumentInline(cell).map{if(cell.text("type")=="tableHeader")it.copy(bold=true)else it}
                        emit("paragraph",runs,item.copy(marker=""))
                    }
                }
            }
            "paragraph","text","hardBreak","image","citation","sourceCitation","reference"->emit("paragraph",nativeRichDocumentInline(node),item)
            else->if(children.isEmpty())emit("paragraph",nativeRichDocumentInline(node),item)else children.asReversed().forEach{pending.addLast(item.copy(node=it))}
        }
    }
    return blocks
}

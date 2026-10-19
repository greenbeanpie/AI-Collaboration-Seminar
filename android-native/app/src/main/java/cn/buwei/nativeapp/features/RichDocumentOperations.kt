package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*

internal fun richNode(type:String,children:List<JsonObject> = emptyList(),attrs:JsonObject?=null):JsonObject=buildJsonObject {
    put("type",type);if(type!="text"&&type!="hardBreak"&&type!="horizontalRule")put("content",JsonArray(children))
    if(attrs!=null)put("attrs",attrs)
}
internal fun richParagraph(text:String=""):JsonObject=richNode("paragraph",if(text.isEmpty())emptyList()else listOf(buildJsonObject{put("type","text");put("text",text)}))
internal fun richBlock(type:String):JsonObject=when(type) {
    "bulletList","orderedList"->richNode(type,listOf(richNode("listItem",listOf(richParagraph()))))
    "blockquote"->richNode(type,listOf(richParagraph()))
    "table"->richNode(type,(0..2).map {row->richNode("tableRow",(0..2).map {richNode(if(row==0)"tableHeader"else"tableCell",listOf(richParagraph()),buildJsonObject{put("colspan",1);put("rowspan",1);put("colwidth",JsonNull)})})})
    "heading"->richNode(type,attrs=buildJsonObject{put("level",2)})
    "codeBlock","paragraph","horizontalRule"->richNode(type)
    else->error("不支持新建此内容块")
}
internal fun richChildren(node:JsonObject):List<JsonObject> = (node["content"]as? JsonArray).orEmpty().map {it.jsonObject}
internal fun richReplaceChildren(node:JsonObject,children:List<JsonObject>)=JsonObject(node+("content" to JsonArray(children.filterNot {it.text("type")=="text"&&it.text("text").isEmpty()})))
internal fun richChangeAt(document:JsonObject,path:List<Int>,change:(JsonObject)->JsonObject):JsonObject {
    if(path.isEmpty())return change(document)
    val children=richChildren(document).toMutableList();val index=path.first();require(index in children.indices)
    children[index]=richChangeAt(children[index],path.drop(1),change)
    return richReplaceChildren(document,children)
}
internal fun richMoveChild(parent:JsonObject,index:Int,direction:Int):JsonObject {
    val children=richChildren(parent).toMutableList();val next=index+direction
    require(index in children.indices&&next in children.indices&&direction in listOf(-1,1))
    val node=children.removeAt(index);children.add(next,node);return richReplaceChildren(parent,children)
}
internal fun richMarkRange(node:JsonObject,start:Int,end:Int,kind:String,attrs:JsonObject?=null,remove:Boolean=false):List<JsonObject> {
    require(node.text("type")=="text");val text=node.text("text");require(start in 0..text.length&&end in start..text.length)
    if(start==end)return listOf(node)
    val marks=(node["marks"]as? JsonArray).orEmpty();val existing=marks.any {it.jsonObject.text("type")==kind}
    val updated=marks.filterNot{it.jsonObject.text("type")==kind}.toMutableList()
    if(!remove&&(!existing||attrs!=null))updated+=buildJsonObject{put("type",kind);if(attrs!=null)put("attrs",attrs)}
    return buildList {
        if(start>0)add(JsonObject(node+("text" to JsonPrimitive(text.substring(0,start)))))
        add(JsonObject(node+mapOf("text" to JsonPrimitive(text.substring(start,end)),"marks" to JsonArray(updated))))
        if(end<text.length)add(JsonObject(node+("text" to JsonPrimitive(text.substring(end)))))
    }
}
internal fun richFormatSelection(document:JsonObject,path:List<Int>,start:Int,end:Int,kind:String,attrs:JsonObject?=null,remove:Boolean=false):JsonObject {
    require(path.isNotEmpty())
    return richChangeAt(document,path.dropLast(1)){parent->
        val children=richChildren(parent).toMutableList();val index=path.last();require(index in children.indices)
        val parts=richMarkRange(children[index],start,end,kind,attrs,remove);children.removeAt(index);children.addAll(index,parts)
        richReplaceChildren(parent,children)
    }
}
internal fun richTableAddColumn(table:JsonObject):JsonObject {
    require(table.text("type")=="table")
    return richReplaceChildren(table,richChildren(table).map {row->
        val cells=richChildren(row);richReplaceChildren(row,cells+richNode(if(cells.all{it.text("type")=="tableHeader"})"tableHeader"else"tableCell",listOf(richParagraph()),buildJsonObject{put("colspan",1);put("rowspan",1);put("colwidth",JsonNull)}))
    })
}
internal fun richTableAddRow(table:JsonObject):JsonObject {
    require(table.text("type")=="table")
    val columns=richChildren(table).firstOrNull()?.let{row->richChildren(row).sumOf{it.obj("attrs")["colspan"]?.jsonPrimitive?.intOrNull?:1}}?:1
    require(columns in 1..100)
    return richReplaceChildren(table,richChildren(table)+richNode("tableRow",(0 until columns).map{richNode("tableCell",listOf(richParagraph()),buildJsonObject{put("colspan",1);put("rowspan",1);put("colwidth",JsonNull)})}))
}

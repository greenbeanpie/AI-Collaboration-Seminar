package cn.buwei.nativeapp.media

import android.content.Context
import android.util.Xml
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import kotlinx.coroutines.*
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.util.zip.ZipFile

data class DocumentBlock(val seq:Int,val page:Int?,val text:String)
data class DocumentResult(val pages:Int?,val warnings:List<String>)

/** Plain-body extraction only, matching web Office import semantics; no HTML execution. */
object DocumentReader {
    suspend fun read(context:Context,file:File,onBlock:suspend (DocumentBlock)->Unit):DocumentResult=withContext(Dispatchers.IO) {
        var seq=0; val warnings=mutableListOf<String>()
        suspend fun emit(text:String,page:Int?) { text.chunked(24000).forEach { if(it.isNotBlank()) { ensureActive(); onBlock(DocumentBlock(seq++,page,it)) } } }
        when(file.extension.lowercase()) {
            "pdf" -> {
                PDFBoxResourceLoader.init(context)
                PDDocument.load(file).use { document->
                    val count=document.numberOfPages
                    for(page in 1..count) { ensureActive(); val stripper=PDFTextStripper().apply { startPage=page;endPage=page }; val text=stripper.getText(document); if(text.isBlank()) warnings+="第 $page 页没有可提取正文，需要图像识别" else emit(text,page) }
                    DocumentResult(count,warnings)
                }
            }
            "docx","pptx","xlsx" -> ZipFile(file).use { zip->
                // Bound inflated bytes and reject external entities/DOCTYPE in XML parts.
                val entries=zip.entries().asSequence().toList()
                require(entries.size<=10000) { "文档内部文件过多" }
                var total=0L
                fun xml(name:String,consumer:(String,String,Map<String,String>,Boolean)->Unit) {
                    val entry=zip.getEntry(name)?:return
                    require(entry.size in 0..(32L*1024*1024)) { "文档分块过大或大小未知" }
                    total+=entry.size; require(total<=128L*1024*1024) { "解压后的文档过大" }
                    zip.getInputStream(entry).use { input->
                        val parser=Xml.newPullParser(); parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES,true);parser.setInput(input,"UTF-8")
                        var event=parser.eventType
                        while(event!=XmlPullParser.END_DOCUMENT) {
                            check(event!=XmlPullParser.DOCDECL) { "不支持包含 DOCTYPE 的文档" }
                            if(event==XmlPullParser.START_TAG || event==XmlPullParser.END_TAG) {
                                consumer(parser.name,"",(0 until parser.attributeCount).associate { parser.getAttributeName(it) to parser.getAttributeValue(it) },event==XmlPullParser.START_TAG)
                            } else if(event==XmlPullParser.TEXT) consumer("#text",parser.text,emptyMap(),true)
                            event=parser.nextToken()
                        }
                    }
                }
                when(file.extension.lowercase()) {
                    "docx" -> {
                        val text=StringBuilder(); var inside=false
                        xml("word/document.xml") { tag,value,_,start->when { tag=="t" -> inside=start; tag=="#text" && inside -> text.append(value); !start && tag in listOf("p","tr") -> text.append('\n'); tag=="tab" && start->text.append('\t') } }
                        emit(text.toString(),null); DocumentResult(null,listOf("已导入 DOCX 正文；未复制页面排版、图片和批注"))
                    }
                    "pptx" -> {
                        // Presentation relationship order is authoritative, not slide file numbering.
                        val relation=mutableMapOf<String,String>();val ordered=mutableListOf<String>()
                        xml("ppt/_rels/presentation.xml.rels") { tag,_,a,start->if(start && tag=="Relationship" && a["TargetMode"]!="External") { val target=a["Target"]?:"";if(!target.contains("..") && !target.contains(":") && !target.startsWith('/')) relation[a["Id"]?:""]=target } }
                        xml("ppt/presentation.xml") { tag,_,a,start->if(start&&tag=="sldId") a["id"]?.let { id->relation[id]?.let { ordered+="ppt/$it" } } }
                        require(ordered.isNotEmpty()) { "无法读取幻灯片顺序" }
                        ordered.forEachIndexed { index,name->val text=StringBuilder();var inside=false;xml(name){tag,value,_,start->when {tag=="t"->inside=start;tag=="#text"&&inside->text.append(value);!start&&tag=="p"->text.append('\n')}};emit(text.toString(),index+1) }
                        DocumentResult(ordered.size,listOf("已导入幻灯片正文；图像、动画和图表不转换为文字"))
                    }
                    else -> {
                        val strings=mutableListOf<String>();var builder=StringBuilder();var inside=false
                        xml("xl/sharedStrings.xml") {tag,value,_,start->when {tag=="si"&&start->builder=StringBuilder();tag=="t"->inside=start;tag=="#text"&&inside->builder.append(value);tag=="si"&&!start->strings.add(builder.toString())} }
                        var page=0
                        val relationships=mutableMapOf<String,String>();val sheets=mutableListOf<Pair<String,String>>()
                        xml("xl/_rels/workbook.xml.rels") {tag,_,a,start->if(start&&tag=="Relationship"&&a["TargetMode"]!="External") { val target=a["Target"]?:""; if(!target.contains("..")&&!target.contains(":"))relationships[a["Id"]?:""]=if(target.startsWith('/'))target.trimStart('/') else "xl/$target" } }
                        xml("xl/workbook.xml") {tag,_,a,start->if(start&&tag=="sheet") relationships[a["id"]]?.let {sheets+=(a["name"]?:"工作表") to it} }
                        sheets.forEach { (title,name)->
                            page++;val text=StringBuilder("$title\n");var type="";var cell=StringBuilder();var reading=false
                            xml(name) {tag,value,a,start->when {tag=="c"&&start->{type=a["t"]?:"";cell=StringBuilder()};tag in listOf("v","t")->reading=start;tag=="#text"&&reading->cell.append(value);tag=="c"&&!start->{text.append(if(type=="s") strings.getOrNull(cell.toString().toIntOrNull()?:-1)?:"" else cell.toString());text.append('\t')};tag=="row"&&!start->text.append('\n')} }
                            emit(text.toString(),page)
                        }
                        DocumentResult(page,listOf("已导入单元格及缓存公式结果；不重新计算公式，图表和图片不转换为文字"))
                    }
                }
            }
            "txt","md","csv" -> { emit(file.readText(),null);DocumentResult(null,emptyList()) }
            else -> error("此文件可上传；正文导入仅支持 PDF、DOCX、XLSX、PPTX 和文本")
        }
    }
}

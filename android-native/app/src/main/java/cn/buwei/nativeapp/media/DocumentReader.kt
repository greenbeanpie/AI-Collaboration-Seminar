package cn.buwei.nativeapp.media

import android.content.Context
import android.util.Xml
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import kotlinx.coroutines.*
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.io.FilterInputStream
import java.time.LocalDate
import java.time.LocalTime
import java.util.zip.ZipFile
import kotlin.math.floor

/** Office locations are headings, never invented PDF page numbers. */
data class DocumentBlock(val seq:Int,val page:Int?,val text:String,val headingPath:List<String> = emptyList())
data class DocumentResult(val pages:Int?,val warnings:List<String>)

object DocumentReader {
    suspend fun read(context:Context,file:File,onBlock:suspend (DocumentBlock)->Unit):DocumentResult=withContext(Dispatchers.IO) {
        var seq=0
        val warnings=linkedSetOf<String>()
        fun warn(message:String) { if(warnings.size<100) warnings+=message.take(1000) }
        suspend fun emit(text:String,page:Int?=null,headings:List<String> = emptyList(),allowEmpty:Boolean=false) {
            if(text.isBlank() && !allowEmpty) return
            for(chunk in text.chunked(24000).ifEmpty { listOf("") }) {
                ensureActive(); onBlock(DocumentBlock(seq++,page,chunk,headings.take(10).map {it.take(200)}))
            }
        }
        val extension=file.extension.lowercase()
        if(extension=="pdf") {
            PDFBoxResourceLoader.init(context)
            PDDocument.load(file).use { document->
                val count=document.numberOfPages
                require(count>0) {"PDF 没有可读取页面"}
                for(page in 1..count) {
                    ensureActive()
                    val text=PDFTextStripper().apply {startPage=page;endPage=page}.getText(document)
                    if(text.isBlank()) warn("第 $page 页没有可提取正文，需要图像识别")
                    // Even empty pages must be acknowledged for backend PDF coverage checks.
                    emit(text,page,allowEmpty=true)
                }
                return@withContext DocumentResult(count,warnings.toList())
            }
        }
        if(extension in listOf("txt","md","csv")) {
            file.bufferedReader().use { reader->val buffer=CharArray(24000);while(true){ensureActive();val count=reader.read(buffer);if(count<0)break;emit(String(buffer,0,count))} }
            if(seq==0) warn("未提取到可读取正文，原文件已保留")
            return@withContext DocumentResult(null,warnings.toList())
        }
        require(extension in listOf("docx","pptx","xlsx")) {"正文导入仅支持 PDF、DOCX、XLSX、PPTX 和文本"}
        ZipFile(file).use { zip->
            val entries=zip.entries().asSequence().toList()
            require(entries.size<=10000 && entries.map {it.name}.toSet().size==entries.size) {"文档内部文件过多或存在重名分块"}
            var inflated=0L
            suspend fun xml(name:String,required:Boolean=true,consumer:suspend (String,String,Map<String,String>,Boolean)->Unit) {
                val entry=zip.getEntry(name)
                if(entry==null) { require(!required) {"文档缺少必要分块：$name"};return }
                require(entry.size in 0..(32L*1024*1024)) {"文档分块过大或大小未知"}
                zip.getInputStream(entry).use { raw->
                    val bounded=object:FilterInputStream(raw) {
                        var count=0L
                        fun counted(number:Int) {if(number>0){count+=number;inflated+=number;require(count<=32L*1024*1024 && inflated<=128L*1024*1024){"解压后的文档过大"}}}
                        override fun read():Int=super.read().also {if(it>=0)counted(1)}
                        override fun read(bytes:ByteArray,offset:Int,length:Int):Int=`in`.read(bytes,offset,length).also {counted(it)}
                    }
                    val parser=Xml.newPullParser()
                    parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES,true)
                    parser.setInput(bounded,"UTF-8")
                    var event=parser.eventType;var events=0
                    while(event!=XmlPullParser.END_DOCUMENT) {
                        if(++events%256==0)ensureActive()
                        require(events<=2_000_000) {"XML 文档结构过于复杂"}
                        require(event!=XmlPullParser.DOCDECL) {"不支持包含 DOCTYPE 的文档"}
                        if(event==XmlPullParser.ENTITY_REF) require(parser.name in listOf("amp","lt","gt","quot","apos") || Regex("#(?:[0-9]+|x[0-9a-fA-F]+)").matches(parser.name.orEmpty())) {"不支持外部 XML 实体引用"}
                        if(event==XmlPullParser.START_TAG || event==XmlPullParser.END_TAG) {
                            val attributes=mutableMapOf<String,String>()
                            if(event==XmlPullParser.START_TAG) for(index in 0 until parser.attributeCount) {
                                val local=parser.getAttributeName(index);val value=parser.getAttributeValue(index)
                                val namespace=parser.getAttributeNamespace(index).orEmpty()
                                if(namespace.isEmpty()) attributes[local]=value
                                else if(namespace.endsWith("/relationships")) attributes["r:$local"]=value
                            }
                            consumer(parser.name,"",attributes,event==XmlPullParser.START_TAG)
                        } else if(event==XmlPullParser.TEXT || event==XmlPullParser.CDSECT || event==XmlPullParser.ENTITY_REF) consumer("#text",parser.text,emptyMap(),true)
                        event=parser.nextToken()
                    }
                }
            }
            fun target(part:String,reference:String):String {
                require(reference.isNotBlank() && !reference.contains(Regex("[:\\\\?#]"))) {"文档关联路径无效"}
                val path=if(reference.startsWith('/'))reference.trimStart('/') else part.substringBeforeLast('/',"")+"/"+reference
                val segments=mutableListOf<String>()
                for(segment in path.split('/'))when(segment){"","."->Unit;".."->{require(segments.isNotEmpty()){ "文档关联超出文件范围" };segments.removeAt(segments.lastIndex)};else->segments+=segment}
                return segments.joinToString("/")
            }
            suspend fun relationships(part:String,required:Boolean=true):Map<String,Map<String,String>> {
                val result=mutableMapOf<String,Map<String,String>>()
                val rel=part.substringBeforeLast('/')+"/_rels/"+part.substringAfterLast('/')+".rels"
                xml(rel,required){tag,_,attributes,start->if(start&&tag=="Relationship")result[attributes["Id"]?:error("文档关联缺少 ID")]=attributes}
                return result
            }
            suspend fun paragraphs(part:String,headings:List<String>,notes:Boolean=false) {
                var inside=false;var ignored=false;var text=StringBuilder();var table=0;var tableDepth=0;var row=0;var column=0
                xml(part){tag,value,attributes,start->
                    if(tag=="tbl") {if(start){table++;tableDepth++;row=0;column=0}else tableDepth--}
                    if(start&&tag=="tr"){row++;column=0};if(start&&tag=="tc")column++
                    if(notes&&tag=="sp")ignored=false
                    if(notes&&start&&tag=="ph"&&attributes["type"] in listOf("sldNum","dt","ftr","hdr","sldImg"))ignored=true
                    when {
                        tag=="t"->inside=start
                        tag=="#text"&&inside&&!ignored->{require(text.length+value.length<=512000){"单个文档段落过长"};text.append(value)}
                        start&&tag in listOf("tab","br")&&!ignored->text.append(if(tag=="tab")'\t' else '\n')
                        !start&&tag=="p"->{emit(text.toString(),headings=headings+if(tableDepth>0)listOf("表格 $table", "行 $row 列 $column")else emptyList());text=StringBuilder()}
                        !start&&tag in listOf("tc","tr")->if(text.isNotEmpty())text.append(if(tag=="tc")'\t' else '\n')
                    }
                }
                emit(text.toString(),headings=headings)
            }
            if(entries.any {Regex("/(?:media|drawings|charts|embeddings)/").containsMatchIn(it.name)}) warn("图片、图表、绘图或嵌入对象未读取；请核对原文件")
            xml("[Content_Types].xml"){_,_,_,_->}
            when(extension) {
                "docx"->{
                    warn("已导入 DOCX 正文；页面版式、图片和批注未复原")
                    paragraphs("word/document.xml",listOf("正文"))
                }
                "pptx"->{
                    val relations=relationships("ppt/presentation.xml")
                    val slides=mutableListOf<String>()
                    xml("ppt/presentation.xml"){tag,_,attributes,start->if(start&&tag=="sldId"){
                        val relation=relations[attributes["r:id"]]?:error("幻灯片缺少有效关联")
                        require(relation["TargetMode"]!="External"&&relation["Type"]?.endsWith("/slide")==true){"幻灯片关联无效"}
                        slides+=target("ppt/presentation.xml",relation["Target"]?:error("幻灯片关联缺少目标"))
                    }}
                    require(slides.isNotEmpty()){ "文档没有可读取的幻灯片" }
                    warn("只读取幻灯片文字、表格及演讲备注；视觉版式、动画和母版内容未复原")
                    slides.forEachIndexed {index,part->
                        var hidden=false
                        xml(part){tag,_,attributes,start->if(start&&tag=="sld")hidden=attributes["show"] in listOf("0","false")}
                        val title="幻灯片 ${index+1}"+if(hidden)"（隐藏）" else ""
                        if(hidden)warn("隐藏幻灯片已读取并标记，请核对原文件")
                        paragraphs(part,listOf(title,"正文"))
                        val notes=relationships(part,false).values.firstOrNull {it["Type"]?.endsWith("/notesSlide")==true}
                        if(notes!=null) {
                            if(notes["TargetMode"]=="External")warn("外部演讲备注未读取")
                            else paragraphs(target(part,notes["Target"]?:error("演讲备注缺少目标")),listOf(title,"演讲备注"),true)
                        }
                    }
                }
                "xlsx"->{
                    val strings=mutableListOf<String>();var string=StringBuilder();var reading=false;var phonetic=false;var stringChars=0
                    xml("xl/sharedStrings.xml",false){tag,value,_,start->when {
                        tag=="si"&&start->string=StringBuilder()
                        tag=="rPh"->phonetic=start
                        tag=="t"->reading=start
                        tag=="#text"&&reading&&!phonetic->{string.append(value);stringChars+=value.length;require(stringChars<=8*1024*1024){"工作簿共享文字过大"}}
                        tag=="si"&&!start->{require(strings.size<100000){"工作簿共享文字过多"};strings+=string.toString()}
                    }}
                    val numberFormats=mutableMapOf<Int,String>();val styles=mutableListOf<Int>();var cellStyles=false
                    xml("xl/styles.xml",false){tag,_,attributes,start->when {
                        tag=="numFmt"&&start->attributes["numFmtId"]?.toIntOrNull()?.let {numberFormats[it]=attributes["formatCode"].orEmpty()}
                        tag=="cellXfs"->cellStyles=start
                        tag=="xf"&&start&&cellStyles->styles+=attributes["numFmtId"]?.toIntOrNull()?:0
                    }}
                    val relations=relationships("xl/workbook.xml")
                    val sheets=mutableListOf<Triple<String,String,Boolean>>();var date1904=false
                    xml("xl/workbook.xml"){tag,_,attributes,start->if(start)when(tag){
                        "workbookPr"->date1904=attributes["date1904"] in listOf("1","true")
                        "sheet"->{val relation=relations[attributes["r:id"]]?:error("工作表缺少有效关联")
                            require(relation["TargetMode"]!="External"&&relation["Type"]?.endsWith("/worksheet")==true){"工作表关联无效"}
                            sheets+=Triple(attributes["name"]?:"工作表",target("xl/workbook.xml",relation["Target"]?:error("工作表关联缺少目标")),attributes["state"] in listOf("hidden","veryHidden"))}
                    }}
                    require(sheets.isNotEmpty()){ "工作簿没有可读取工作表" }
                    sheets.forEach {(name,part,hidden)->
                        if(hidden)warn("包含隐藏工作表／行／列，已读取并标记，请核对原文件")
                        var rowHidden=false;val hiddenColumns=mutableListOf<IntRange>()
                        var type="";var address="";var style=0;var cell=StringBuilder();var formula=StringBuilder();var readingValue=false;var readingFormula=false;var formulaPresent=false;var inline=false
                        xml(part){tag,value,attributes,start->when {
                            tag=="col"&&start&&attributes["hidden"] in listOf("1","true")->{val min=attributes["min"]?.toIntOrNull()?:1;val max=attributes["max"]?.toIntOrNull()?:min;hiddenColumns+=(min..max);warn("包含隐藏工作表／行／列，已读取并标记，请核对原文件")}
                            tag=="row"&&start->rowHidden=attributes["hidden"] in listOf("1","true")
                            tag=="c"&&start->{type=attributes["t"].orEmpty();address=attributes["r"]?:error("工作表单元格缺少地址");require(Regex("[A-Z]{1,3}[1-9][0-9]{0,6}").matches(address)){"工作表单元格地址无效"};style=attributes["s"]?.toIntOrNull()?:0;cell=StringBuilder();formula=StringBuilder();formulaPresent=false;inline=false}
                            tag=="f"->{readingFormula=start;if(start)formulaPresent=true}
                            tag=="is"->inline=start
                            tag=="v"||tag=="t"&&inline->readingValue=start
                            tag=="#text"&&readingFormula->formula.append(value)
                            tag=="#text"&&readingValue->{require(cell.length+value.length<=512000){"单元格文字过长"};cell.append(value)}
                            tag=="mergeCell"&&start->warn("合并单元格仅保留左上角值，版式未复原")
                            tag=="c"&&!start->{
                                var output=cell.toString()
                                if(formulaPresent) {
                                    warn("公式只读取文件中保存的结果，不重新计算；缓存值可能过期，缺失时已标记")
                                    if(output.isEmpty())output="[公式 ${formula.ifEmpty { "（共享公式）" }}：无已保存结果]"
                                }
                                if(type=="s") {val index=output.toIntOrNull();require(index!=null&&index in strings.indices){"单元格共享文字引用无效"};output=strings[index]}
                                else if(type=="b")output=if(output=="1")"TRUE" else "FALSE"
                                else if(type=="e")warn("工作簿包含错误单元格，已保留原错误值")
                                else if(type.isEmpty()||type=="n") {
                                    val format=styles.getOrNull(style)?:0
                                    output=OfficeDates.format(output,format,numberFormats[format],date1904)
                                }
                                var column=0;for(character in address.takeWhile {it.isLetter()})column=column*26+(character-'A'+1)
                                val cellHidden=rowHidden||hiddenColumns.any {column in it}
                                if(cellHidden)warn("包含隐藏工作表／行／列，已读取并标记，请核对原文件")
                                emit(output,headings=listOf(name+if(hidden)"（隐藏工作表）" else "",address+if(cellHidden)"（隐藏行／列）" else ""))
                                readingValue=false;readingFormula=false;inline=false
                            }
                        }}
                    }
                    if(entries.any {it.name.startsWith("xl/comments")})warn("单元格批注未读取")
                }
            }
        }
        if(seq==0)warn("未提取到可读取正文，原文件已保留")
        DocumentResult(null,warnings.toList())
    }
}

/** Date systems are workbook properties; never expose an Excel date serial as a plain quantity. */
internal object OfficeDates {
    fun format(raw:String,formatId:Int,custom:String?,date1904:Boolean):String {
        val number=raw.toDoubleOrNull()?:return raw
        if(!number.isFinite()||number<0||number>2958465)return raw
        val pattern=custom.orEmpty().replace(Regex("\"[^\"]*\"|\\\\.|\\[[^]]*]"),"").lowercase()
        val date=formatId in 14..22 || formatId in 27..36 || formatId in 50..58 || Regex("[ymdhis]").containsMatchIn(pattern)
        val timeOnly=formatId in 18..21 || formatId in 45..47 || (pattern.isNotEmpty()&&!Regex("[yd]").containsMatchIn(pattern)&&Regex("[hs]").containsMatchIn(pattern))
        if(!date&&!timeOnly)return raw
        val days=floor(number).toLong()
        val time=LocalTime.ofNanoOfDay(((number-days)*86400_000_000_000L).toLong().coerceIn(0,86399_999_999_999L)).withNano(0).toString()
        if(timeOnly)return time
        val value=if(!date1904&&days==60L)"1900-02-29" else {
            val origin=if(date1904)LocalDate.of(1904,1,1) else if(days<60)LocalDate.of(1899,12,31) else LocalDate.of(1899,12,30)
            origin.plusDays(days).toString()
        }
        return if(number!=days.toDouble())"$value $time" else value
    }
}

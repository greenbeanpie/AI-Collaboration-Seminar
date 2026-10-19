package cn.buwei.nativeapp.features

import java.net.IDN
import java.net.URI
import java.util.Locale

internal data class NativeMarkdownInline(val text:String,val bold:Boolean=false,val italic:Boolean=false,val strike:Boolean=false,val code:Boolean=false,val href:String?=null,val underline:Boolean=false)
internal data class NativeMarkdownBlock(
 val kind:String,val inline:List<NativeMarkdownInline> = emptyList(),val level:Int=0,val marker:String="",val depth:Int=0,
 val code:String="",val language:String="",val headers:List<List<NativeMarkdownInline>> = emptyList(),val cells:List<List<NativeMarkdownInline>> = emptyList()
)
private data class NativeMarkdownMarks(val bold:Boolean=false,val italic:Boolean=false,val strike:Boolean=false,val code:Boolean=false,val href:String?=null)
private fun NativeMarkdownMarks.run(text:String)=NativeMarkdownInline(text,bold,italic,strike,code,href)

/** Returns an explicit safe browser target or an application-relative route; never interprets HTML. */
internal fun nativeMarkdownHref(value:String):String?=runCatching {
 if(value.isBlank()||value.any{it=='\\'||it.code<=32})return@runCatching null
 val uri=URI(value)
 if(!uri.isAbsolute){val path=uri.normalize().path.orEmpty();if(uri.rawAuthority==null&&(path=="/app"||path.startsWith("/app/"))&&!path.any{it=='\\'||it.code<=32}&&!path.split('/').any{it=="."||it==".."})uri.normalize().toASCIIString()else null}
 else {
  if(uri.scheme.lowercase(Locale.ROOT) !in listOf("http","https")||uri.rawUserInfo!=null||uri.rawAuthority.isNullOrBlank()||uri.rawAuthority.contains('@'))return@runCatching null
  if(uri.host!=null)uri.toASCIIString()else{
   val authority=uri.rawAuthority;val host=authority.substringBefore(':');val suffix=authority.removePrefix(host)
   require(suffix.isEmpty()||Regex(":\\d{1,5}").matches(suffix));val ascii=IDN.toASCII(host,IDN.USE_STD3_ASCII_RULES);require(ascii.isNotBlank())
   URI(uri.scheme+"://"+ascii+suffix+(uri.rawPath?:"")+(uri.rawQuery?.let{"?$it"}?:"")+(uri.rawFragment?.let{"#$it"}?:"")).toASCIIString()
  }
 }
}.getOrNull()
private fun nativeMarkdownCodeEnd(text:String,start:Int,end:Int,count:Int):Int {
 var cursor=start+count
 while(cursor<end){if(text[cursor]=='`'){val begin=cursor;while(cursor<end&&text[cursor]=='`')cursor++;if(cursor-begin==count)return begin}else cursor++};return -1
}
private fun nativeMarkdownPairMap(text:String):Map<Int,Int>{
 val brackets=ArrayDeque<Int>();val parentheses=ArrayDeque<Int>();val pairs=mutableMapOf<Int,Int>();var index=0
 while(index<text.length){when(text[index]){
  '\\'->{index+=2;continue}
  '`'->{var count=1;while(index+count<text.length&&text[index+count]=='`')count++;val end=nativeMarkdownCodeEnd(text,index,text.length,count);if(end>=0){index=end+count;continue};index+=count;continue}
  '['->brackets.addLast(index);']'->if(brackets.isNotEmpty())pairs[brackets.removeLast()]=index
  '('->parentheses.addLast(index);')'->if(parentheses.isNotEmpty())pairs[parentheses.removeLast()]=index
 };index++};return pairs
}
/** Recursive inline subset matches the project's rich-document marks; code spans are opaque. */
internal fun parseNativeMarkdownInline(text:String):List<NativeMarkdownInline>{
 val pairs=nativeMarkdownPairMap(text)
 fun parse(start:Int,end:Int,marks:NativeMarkdownMarks,depth:Int):List<NativeMarkdownInline>{
  if(depth>24)return listOf(marks.run(text.substring(start,end)))
  val output=mutableListOf<NativeMarkdownInline>();val plain=StringBuilder()
  fun flush(){if(plain.isNotEmpty()){output+=marks.run(plain.toString());plain.setLength(0)}}
  fun close(delimiter:String,from:Int):Int {
   var cursor=from;var nestedSingle=false;var nestedDouble=false
   while(cursor<end){
    if(text[cursor]=='\\'){cursor+=2;continue}
    if(text[cursor]=='`'){var size=1;while(cursor+size<end&&text[cursor+size]=='`')size++;val stop=nativeMarkdownCodeEnd(text,cursor,end,size);if(stop>=0){cursor=stop+size;continue};cursor+=size;continue}
    if(text[cursor]==delimiter[0]){
     var length=1;while(cursor+length<end&&text[cursor+length]==text[cursor])length++
     if(delimiter.length==1&&length==2){nestedDouble=!nestedDouble;cursor+=length;continue}
     if(delimiter.length==2&&length==1){nestedSingle=!nestedSingle;cursor++;continue}
     if(length>=delimiter.length&&cursor>from&&!text[cursor-1].isWhitespace())return cursor+when{delimiter.length==2&&length>=3&&nestedSingle->1;delimiter.length==1&&length>=3&&nestedDouble->2;else->0}
     cursor+=length
    }else cursor++
   }
   return -1
  }
  var index=start
  while(index<end){val character=text[index]
   if(character=='\\'&&index+1<end&&text[index+1]in "\\`*_{}[]()#+-.!|>~"){plain.append(text[index+1]);index+=2;continue}
   if(character=='`'){var count=1;while(index+count<end&&text[index+count]=='`')count++;val closing=nativeMarkdownCodeEnd(text,index,end,count);if(closing>=0){flush();output+=marks.copy(code=true).run(text.substring(index+count,closing));index=closing+count;continue};plain.append(text.substring(index,index+count));index+=count;continue}
   if(character=='['){val labelEnd=pairs[index];val targetStart=labelEnd?.plus(1);val targetEnd=targetStart?.let{pairs[it]}
    if(labelEnd!=null&&labelEnd<end&&targetStart!=null&&targetStart<end&&text[targetStart]=='('&&targetEnd!=null&&targetEnd<end){flush();val raw=text.substring(targetStart+1,targetEnd).removeSurrounding("<",">");output+=if(labelEnd==index+1)listOf(marks.copy(href=raw).run(raw))else parse(index+1,labelEnd,marks.copy(href=raw),depth+1);index=targetEnd+1;continue}
   }
   if(character=='!'&&index+1<end&&text[index+1]=='['){val labelEnd=pairs[index+1];val targetStart=labelEnd?.plus(1);val targetEnd=targetStart?.let{pairs[it]};if(targetEnd!=null&&targetEnd<end){plain.append(text.substring(index,targetEnd+1));index=targetEnd+1;continue}}
   if(character in "*_~"){var count=1;while(index+count<end&&text[index+count]==character)count++;if(count>3){plain.append(text.substring(index,index+count));index+=count;continue}}
   val delimiter=when{index+3<=end&&(text.startsWith("***",index)||text.startsWith("___",index))->text.substring(index,index+3);index+2<=end&&(text.startsWith("**",index)||text.startsWith("__",index)||text.startsWith("~~",index))->text.substring(index,index+2);character=='*'||character=='_'->character.toString();else->null}
   if(delimiter!=null&&index+delimiter.length<end&&!text[index+delimiter.length].isWhitespace()&&!(character=='_'&&index>start&&text[index-1].isLetterOrDigit())){val closing=close(delimiter,index+delimiter.length);if(closing>=0){flush();val next=when(delimiter.length){3->marks.copy(bold=true,italic=true);2->if(delimiter=="~~")marks.copy(strike=true)else marks.copy(bold=true);else->marks.copy(italic=true)};output+=parse(index+delimiter.length,closing,next,depth+1);index=closing+delimiter.length;continue}}
   if(text.startsWith("https://",index)||text.startsWith("http://",index)){var stop=index;while(stop<end&&!text[stop].isWhitespace()&&text[stop] !in "<>")stop++;while(stop>index&&text[stop-1]in ".,;!?，。；！？")stop--;if(stop>index){flush();val url=text.substring(index,stop);output+=marks.copy(href=url).run(url);index=stop;continue}}
   plain.append(character);index++
  };flush();return output
 }
 return parse(0,text.length,NativeMarkdownMarks(),0)
}
/** Table separators inside code spans or escaped by the rich editor are content, never columns. */
internal fun nativeMarkdownTableCells(line:String):List<String>{
 val source=line.trim().removePrefix("|").removeSuffix("|");val cells=mutableListOf<String>();val cell=StringBuilder();var index=0;var codeFence=0
 while(index<source.length){val character=source[index]
  if(character=='\\'&&index+1<source.length){cell.append(character).append(source[index+1]);index+=2;continue}
  if(character=='`'){var count=1;while(index+count<source.length&&source[index+count]=='`')count++;if(codeFence==0)codeFence=count else if(codeFence==count)codeFence=0;repeat(count){cell.append('`')};index+=count;continue}
  if(character=='|'&&codeFence==0){cells+=cell.toString().trim();cell.setLength(0)}else cell.append(character);index++
 };cells+=cell.toString().trim();return cells
}
internal fun nativeMarkdownChunks(value:String,limit:Int=4000):List<String>{
 if(value.isEmpty())return listOf("");val result=mutableListOf<String>();var start=0
 while(start<value.length){var end=minOf(start+limit,value.length);if(end<value.length&&value[end-1].isHighSurrogate()&&value[end].isLowSurrogate())end--;result+=value.substring(start,end);start=end};return result
}
internal fun nativeMarkdownInlineChunks(runs:List<NativeMarkdownInline>):List<List<NativeMarkdownInline>>{
 val result=mutableListOf<List<NativeMarkdownInline>>();var chunk=mutableListOf<NativeMarkdownInline>();var size=0
 runs.forEach{run->nativeMarkdownChunks(run.text).forEach{part->if(size+part.length>4000&&chunk.isNotEmpty()){result+=chunk;chunk=mutableListOf();size=0};chunk+=run.copy(text=part);size+=part.length}}
 if(chunk.isNotEmpty())result+=chunk;return result
}
internal fun parseNativeMarkdown(markdown:String):List<NativeMarkdownBlock>{
 val lines=markdown.replace("\r\n","\n").replace('\r','\n').split('\n');val output=mutableListOf<NativeMarkdownBlock>();var index=0
 fun inline(kind:String,text:String,level:Int=0,marker:String="",depth:Int=0){nativeMarkdownInlineChunks(parseNativeMarkdownInline(text)).forEachIndexed{part,runs->output+=NativeMarkdownBlock(kind,runs,level,if(part==0)marker else"",depth)}}
 fun tableParts(kind:String,headers:List<List<NativeMarkdownInline>>,cells:List<List<NativeMarkdownInline>>){
  var batch=mutableListOf<List<NativeMarkdownInline>>();var labels=mutableListOf<List<NativeMarkdownInline>>();var size=0
  fun flush(){if(batch.isNotEmpty()){output+=NativeMarkdownBlock(kind,headers=labels,cells=batch);batch=mutableListOf();labels=mutableListOf();size=0}}
  cells.forEachIndexed{column,runs->nativeMarkdownInlineChunks(runs).ifEmpty{listOf(listOf(NativeMarkdownInline("")))}.forEach{part->val count=part.sumOf{it.text.length};if(batch.size>=4||size+count>4000)flush();batch+=part
   val header=headers.getOrNull(column).orEmpty();labels+=if(header.sumOf{it.text.length}>200)listOf(NativeMarkdownInline("列 ${column+1}（完整列名见表头）"))else header;size+=count
  }};flush()
 }
 fun delimiter(line:String):Boolean=Regex("^ {0,3}(?:(?:\\*\\s*){3,}|(?:-\\s*){3,}|(?:_\\s*){3,})$").matches(line)
 while(index<lines.size){val line=lines[index];val trimmed=line.trim();if(trimmed.isBlank()){index++;continue}
  val fence=Regex("^ {0,3}(`{3,}|~{3,})(.*)$").matchEntire(line)
  if(fence!=null){val token=fence.groupValues[1];val language=fence.groupValues[2].trim();val code=mutableListOf<String>();index++;while(index<lines.size&&!Regex("^ {0,3}"+Regex.escape(token.first().toString())+"{"+token.length+",}\\s*$").matches(lines[index])){code+=lines[index];index++};if(index<lines.size)index++;nativeMarkdownChunks(code.joinToString("\n")).forEach{output+=NativeMarkdownBlock("code",code=it,language=language)};continue}
  if(delimiter(line)){output+=NativeMarkdownBlock("rule");index++;continue}
  val heading=Regex("^ {0,3}(#{1,6})\\s+(.+?)(?:\\s+#+)?\\s*$").matchEntire(line);if(heading!=null){inline("heading",heading.groupValues[2],heading.groupValues[1].length);index++;continue}
  if(index+1<lines.size&&line.contains('|')){val separators=nativeMarkdownTableCells(lines[index+1]);if(separators.isNotEmpty()&&separators.all{Regex(":?-{3,}:?").matches(it)}){val headers=nativeMarkdownTableCells(line).map(::parseNativeMarkdownInline);tableParts("table-header",emptyList(),headers);index+=2;while(index<lines.size&&lines[index].contains('|')&&lines[index].isNotBlank()){val cells=nativeMarkdownTableCells(lines[index]).map(::parseNativeMarkdownInline);tableParts("table-row",headers,cells);index++};continue}}
  val quote=Regex("^\\s*((?:>\\s?)+)(.*)$").matchEntire(line);if(quote!=null){inline("quote",quote.groupValues[2],depth=quote.groupValues[1].count{it=='>'});index++;continue}
  val list=Regex("^(\\s*)([-+*]|\\d+[.)、])\\s+(.*)$").matchEntire(line);if(list!=null){inline("list",list.groupValues[3],marker=if(list.groupValues[2].length==1)"•"else list.groupValues[2],depth=(list.groupValues[1].replace("\t","    ").length/2).coerceAtMost(8));index++;continue}
  val paragraph=mutableListOf(line);index++;while(index<lines.size&&lines[index].isNotBlank()&&!Regex("^\\s*(?:#{1,6}\\s|>|[-+*]\\s|\\d+[.)、]\\s|`{3,}|~{3,})").containsMatchIn(lines[index])&&!delimiter(lines[index])&&!(index+1<lines.size&&lines[index].contains('|')&&nativeMarkdownTableCells(lines[index+1]).all{Regex(":?-{3,}:?").matches(it)})){paragraph+=lines[index];index++};inline("paragraph",paragraph.joinToString("\n"))
 }
 return output
}

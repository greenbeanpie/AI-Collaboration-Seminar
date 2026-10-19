package cn.buwei.nativeapp.features

import java.net.URI
import java.io.InputStream
import java.util.Locale


internal data class HelpWorkspaceSource(val key:String,val title:String,val filename:String,val detail:String,val sha256:String,val assetName:String) {
 fun content(open:(String)->InputStream):String=open(assetName).bufferedReader(Charsets.UTF_8).use{it.readText()}
}
internal data class HelpWorkspaceChapter(val id:String,val title:String,val content:String)
internal data class HelpWorkspaceChapters(val intro:String,val sections:List<HelpWorkspaceChapter>)
internal fun helpWorkspaceChapters(content:String,kind:String):HelpWorkspaceChapters {
 val parts=mutableListOf(StringBuilder());var fenced=false
 content.replace("\r","").split('\n').forEach{line->
  if(line.trim().startsWith("```"))fenced=!fenced
  if(!fenced&&line.startsWith("## "))parts+=StringBuilder(line.substring(3))else parts.last().append('\n').append(line)
 }
 return HelpWorkspaceChapters(parts.first().toString().trim().replace(Regex("^# [^\\n]+\\n?"),"").trim(),parts.drop(1).mapIndexed{index,part->val text=part.toString();val split=text.indexOf('\n');HelpWorkspaceChapter("$kind-section-${index+1}",if(split<0)text else text.substring(0,split),if(split<0)""else text.substring(split+1))})
}
internal fun helpWorkspaceSearch(chapters:List<HelpWorkspaceChapter>,query:String):List<HelpWorkspaceChapter>{val needle=query.trim().lowercase(Locale.ROOT);return chapters.filter{(it.title+"\n"+it.content).lowercase(Locale.ROOT).contains(needle)}}
internal data class HelpWorkspaceBlock(val kind:String,val text:String,val level:Int=0,val labels:List<String> = emptyList(),val cells:List<String> = emptyList())
internal fun helpWorkspaceBlocks(content:String):List<HelpWorkspaceBlock>{
 val lines=content.replace("\r","").trim().lines();val result=mutableListOf<HelpWorkspaceBlock>();var index=0
 fun cells(row:String)=row.trim().removePrefix("|").removeSuffix("|").split('|').map(String::trim)
 while(index<lines.size){val line=lines[index].trim();if(line.isBlank()){index++;continue}
  if(line.startsWith("```")){val language=line.drop(3).trim();val code=mutableListOf<String>();index++;while(index<lines.size&&!lines[index].trim().startsWith("```")){code+=lines[index];index++};if(index<lines.size)index++;result+=HelpWorkspaceBlock("code",code.joinToString("\n"),labels=listOf(language));continue}
  val heading=Regex("^(#{1,6}) (.+)$").matchEntire(line);if(heading!=null){result+=HelpWorkspaceBlock("heading",heading.groupValues[2],heading.groupValues[1].length);index++;continue}
  if(line.startsWith('|')&&index+1<lines.size&&Regex("^\\|[\\s:|\\-]+\\|$").matches(lines[index+1].trim())){val headers=cells(line);index+=2;while(index<lines.size&&lines[index].trim().startsWith('|')){result+=HelpWorkspaceBlock("table-row","",labels=headers,cells=cells(lines[index]));index++};continue}
  val list=Regex("^(?:([-*]) |(\\d+)\\. )(.*)$").matchEntire(line);if(list!=null){result+=HelpWorkspaceBlock("list",(if(list.groupValues[2].isBlank())"• "else list.groupValues[2]+". ")+list.groupValues[3]);index++;continue}
  val paragraph=mutableListOf(line);index++;while(index<lines.size&&lines[index].isNotBlank()&&!Regex("^(?:#|```|\\||[-*] |\\d+\\. )").containsMatchIn(lines[index].trim())){paragraph+=lines[index].trim();index++};result+=HelpWorkspaceBlock("paragraph",paragraph.joinToString(" "))
 }
 return result
}
/** No embedded content execution, arbitrary app links, credential URLs, or automatic image requests. */
internal fun helpWorkspaceLink(value:String):String?=runCatching {
 if(value.any{it=='\\'||it.code<=32})return@runCatching null
 val uri=URI(value)
 if(value.startsWith("#")&&value.length>1)return@runCatching value
 if(!uri.isAbsolute){val normalized=uri.normalize();val path=normalized.path.orEmpty();if(normalized.rawAuthority==null&&(path=="/app"||path.startsWith("/app/"))&&!path.split('/').any{it=="."||it==".."}&&!path.any{it=='\\'||it.code<=32})normalized.toASCIIString()else null}
 else if(uri.scheme.lowercase(Locale.ROOT) in listOf("https","http")&&!uri.host.isNullOrBlank()&&uri.rawUserInfo==null)uri.toASCIIString()else null
}.getOrNull()

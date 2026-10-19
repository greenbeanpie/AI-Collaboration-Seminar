package cn.buwei.nativeapp

import java.net.URI
import java.net.URLDecoder
import java.util.UUID

/** A server-provided navigation hint never grants access to the destination. */
data class NativeDestination(val section:String, val projectId:String?=null, val recordId:String?=null, val resourceType:String?=null, val versionId:String?=null, val assessmentSection:String?=null, val taskAction:String?=null, val pageNumber:Int?=null, val username:String?=null)

internal fun nativeDestination(value:String):NativeDestination? = runCatching {
    require(value.startsWith("/app") && !value.startsWith("//") && value.none { it=='\\' || it.code<=32 })
    val uri=URI(value)
    require(!uri.isAbsolute && uri.rawAuthority==null)
    val path=uri.path
    require(path.split('/').none { it=="." || it==".." || it.contains('\\') || it.contains('%') || it.any { c->c.code<=32 } })
    val pieces=path.trimEnd('/').split('/').drop(1)
    require(pieces.firstOrNull()=="app")
    val query=uri.rawQuery.orEmpty().split('&').filter { it.isNotBlank() }.associate {
        val pair=it.split('=',limit=2); URLDecoder.decode(pair[0],"UTF-8") to URLDecoder.decode(pair.getOrElse(1){""},"UTF-8")
    }
    fun id(raw:String?):String? { if(raw.isNullOrBlank())return null; require(UUID.fromString(raw).toString().equals(raw,true));return raw }
    if(pieces.getOrNull(1)=="projects") {
        if(pieces.getOrNull(2)=="new") return@runCatching NativeDestination("create-project")
        val project=id(pieces.getOrNull(2))?:error("Missing project")
        val page=pieces.getOrNull(3)?:"overview"
        require(pieces.size<=5)
        when(page) {
            "tasks","work"->NativeDestination("tasks",project,id(pieces.getOrNull(4)?:query["task"]?:query["taskId"]),taskAction=query["taskAction"]?.takeIf{it in listOf("work","settings","history","comments","inquiries","assistance")})
            "data","sources","materials","ai"->{
                val type=when(page){"sources"->"source";"materials"->"material";else->query["resourceType"]?:if(query.containsKey("sourceVersionId"))"source"else if(query.containsKey("materialVersionId"))"material"else null}
                require(type==null || type in listOf("source","material"))
                NativeDestination(if(page=="ai"||query["ai"]=="1")"material-ai" else "data",project,id(pieces.getOrNull(4)?:query["resourceId"]?:query["materialId"]?:query["material"]),type,id(query["versionId"]?:query["materialVersionId"]?:query["sourceVersionId"]),pageNumber=query["page"]?.let{require(it.toIntOrNull() in 1..1000000);it.toInt()})
            }
            "assessment","reviews","rehearsals","requirements"->{
                val area=when(page){"reviews"->"assessments";"rehearsals"->"rehearsals";"requirements"->"standards";else->when(query["section"]){"checks","reviews","assessments"->"assessments";"rehearsals"->"rehearsals";else->"standards"}}
                NativeDestination(if(area=="rehearsals")"rehearsals"else"assessment",project,id(pieces.getOrNull(4)?:query["assessmentId"]),assessmentSection=area)
            }
            "overview","team","ledger","settings","export"->NativeDestination(if(page=="settings")"project-settings"else page,project)
            else->error("Unsupported workspace")
        }
    } else {
        val suffix=pieces.drop(1).joinToString("/")
        if(pieces.getOrNull(1)=="people"){
            require(pieces.size in 2..3)
            val username=pieces.getOrNull(2)
            require(username==null||Regex("[A-Za-z0-9_-]{3,32}").matches(username))
            return@runCatching NativeDestination("people",username=username)
        }
        val section=when(suffix) {
            ""->"projects";"join"->"join";"support/help","help"->"help";"support"->"support";"profile"->"profile"
            "profile/settings/notifications","settings/notifications"->"notifications"
            "profile/settings/appearance","settings/appearance"->"appearance"
            "agent-bridges/connect","profile/settings/agent-bridges","settings/agent-bridges"->"bridges"
            "admin/accounts","profile/settings/accounts"->"accounts";"profile/settings/system"->"system";"admin/ai","profile/settings/ai"->"ai-settings"
            "profile/settings","profile/settings/profile","profile/settings/security","settings","settings/profile","settings/security"->"profile"
            else->if(pieces.getOrNull(1)=="support"&&pieces.size==3){id(pieces[2]);"support"}else error("Unsupported page")
        }
        NativeDestination(section,recordId=if(section=="support")id(pieces.getOrNull(2))else null)
    }
}.getOrNull()

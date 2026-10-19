package cn.buwei.nativeapp.features

import java.net.URI
import kotlinx.serialization.json.*

internal fun notificationWorkspaceTarget(value:String):String? {
 if(!value.startsWith("/app")||value.startsWith("//")||value.any{it=='\\'||it.code<=32})return null
 return runCatching{val uri=URI(value).normalize();if(uri.isAbsolute||uri.rawAuthority!=null||uri.path.any{it=='\\'||it.code<=32}||uri.path.split('/').any{it=="."||it==".."}||!(uri.path=="/app"||uri.path.startsWith("/app/")))null else uri.toASCIIString()}.getOrNull()
}
internal fun notificationWorkspaceMerge(previous:List<JsonObject>,page:List<JsonObject>):List<JsonObject>{val result=LinkedHashMap<String,JsonObject>();previous.forEach{result[it.text("id")]=it};page.forEach{result[it.text("id")]=it};return result.values.toList()}



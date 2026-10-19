package cn.buwei.nativeapp.data

object OfflinePolicy {
    fun project(path:String):String? = Regex("^/api/v1/projects/([a-zA-Z0-9-]+)(?:/|$)").find(path)?.groupValues?.get(1)
    fun tail(path:String):String = path.substringAfter("/api/v1/projects/").substringAfter('/',"")
    fun allowed(method:String,path:String):Boolean {
        if(project(path)==null || path.contains('?') || path.contains('#')) return false
        val tail=tail(path)
        return (method=="PUT" && Regex("materials/[a-zA-Z0-9-]+").matches(tail)) ||
            (method=="PATCH" && Regex("(?:collaboration/)?tasks/[a-zA-Z0-9-]+").matches(tail)) ||
            (method=="POST" && Regex("(?:tasks|comments|collaboration/tasks|(?:collaboration/)?tasks/[a-zA-Z0-9-]+/(?:claim|submissions))").matches(tail))
    }
    fun cacheable(path:String):Boolean = path=="/api/v1/projects" || path.startsWith("/api/v1/projects?") ||
        (project(path)!=null && !Regex("/(?:content|voice-sessions|agent-sessions|export|exports|uploads)(?:/|\\?|$)").containsMatchIn(path))
}

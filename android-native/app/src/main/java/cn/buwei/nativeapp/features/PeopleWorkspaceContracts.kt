package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*

internal fun peopleWorkspaceUsername(value:String):String=value.trim().also {
 require(Regex("[A-Za-z0-9_-]{3,32}").matches(it)){"请输入3–32位字母、数字、下划线或连字符组成的完整用户名"}
}
internal fun peopleWorkspaceSearchPath(value:String)="/api/v1/profiles/search?username="+peopleWorkspaceUsername(value)
internal fun peopleWorkspaceDetailPath(value:String)="/api/v1/profiles/"+peopleWorkspaceUsername(value)
internal val peopleWorkspaceFields=listOf("bio" to "自我介绍","major" to "专业","specialties" to "技能与特长","preferredRoles" to "倾向项目职位")
/** Only explicitly present public fields are shown; private account metadata is never projected. */
internal fun peopleWorkspacePublicFields(profile:JsonObject)=peopleWorkspaceFields.mapNotNull{(key,label)->
 (profile[key]as? JsonPrimitive)?.takeUnless{it is JsonNull}?.contentOrNull?.let{Triple(key,label,it)}
}

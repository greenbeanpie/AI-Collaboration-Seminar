package cn.buwei.nativeapp.features

import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Sensitive account requests never enter offline queues or persistent intent bodies. */
internal suspend fun accountWorkspaceRequest(repository:ClientRepository,method:String,path:String,body:JsonObject?=null,owner:String?=repository.accountId,epoch:Long=repository.epoch):JsonObject=withContext(Dispatchers.IO){
 repository.execute(method,path,body?.toString()?.toRequestBody("application/json".toMediaType()),headers=mapOf("X-Account-Settings" to "1"),expectedOwner=owner,expectedEpoch=epoch).use{response->
  check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
  val payload=runCatching{repository.json.parseToJsonElement(response.body.string()).jsonObject}.getOrNull()
  check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
  if(!response.isSuccessful){val error=payload?.get("error")as? JsonObject;throw ApiException(response.code,error?.text("code")?:"HTTP_${response.code}",error?.text("message")?:"请求失败 (${response.code})")}
  payload?.get("data")as? JsonObject?:error("服务返回了无效数据")
 }
}
internal fun accountPersonalBody(profile:JsonObject,imports:JsonArray=JsonArray(emptyList()))=buildJsonObject{
 listOf("searchable","aiUseAllowed","bio","major","specialties","preferredRoles","visibility","weeklyAvailableHours").forEach{key->profile[key]?.let{put(key,it)}}
 put("expectedRevision",profile["revision"]?:JsonPrimitive(0));if(imports.isNotEmpty())put("legacyImports",imports)
}
internal fun accountImportFields(profile:JsonObject,candidate:JsonObject,fields:Set<String>):JsonObject{
 val next=profile.toMutableMap();val visibility=profile.obj("visibility").toMutableMap()
 if("major" in fields){next["major"]=candidate["major"]?:JsonPrimitive("");visibility["major"]=JsonPrimitive(false)}
 if("specialties" in fields){next["specialties"]=JsonPrimitive((candidate["skills"]as? JsonArray).orEmpty().joinToString("、"){it.jsonPrimitive.content});visibility["specialties"]=JsonPrimitive(false)}
 if("weeklyAvailableHours" in fields)next["weeklyAvailableHours"]=candidate["weeklyAvailableHours"]?:JsonNull
 next["visibility"]=JsonObject(visibility);if(fields.any{it in listOf("major","specialties")})next["aiUseAllowed"]=JsonPrimitive(false)
 return JsonObject(next)
}

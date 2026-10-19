package cn.buwei.nativeapp.data

import android.net.Uri
import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.serialization.json.*

class NativeAuth(private val repository:ClientRepository) {
    private fun random():String=Base64.encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) },Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    suspend fun begin():String {
        val verifier=random(); val state=random()
        val challenge=Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        val response=repository.networkJson("POST","/auth/native/transactions",buildJsonObject { put("codeChallenge",challenge); put("state",state) })
        repository.secrets.put("pkce",buildJsonObject { put("verifier",verifier); put("state",state); put("started",System.currentTimeMillis()) }.toString())
        val path=response["authorizationPath"]!!.jsonPrimitive.content
        require(path.startsWith("/app/native-authorize?") && !path.contains("://"))
        return repository.origin+path
    }
    suspend fun finish(uri:Uri) {
        require(uri.scheme=="buwei-native-preview" && uri.host=="auth" && uri.path=="/callback") { "无效授权回调" }
        val pending=repository.secrets.get("pkce")?.let { repository.json.parseToJsonElement(it).jsonObject }?:error("授权请求不存在，请重新登录")
        require(System.currentTimeMillis()-pending["started"]!!.jsonPrimitive.long<5*60*1000) { "授权请求已过期" }
        require(MessageDigest.isEqual((uri.getQueryParameter("state")?:"").toByteArray(),pending["state"]!!.jsonPrimitive.content.toByteArray())) { "授权状态不匹配" }
        val code=uri.getQueryParameter("code")?:error("授权已取消，请重新登录")
        try { repository.exchange(code,pending["verifier"]!!.jsonPrimitive.content) }
        finally { repository.secrets.put("pkce",null) }
    }
}

package cn.buwei.nativeapp.data

import android.content.Context
import androidx.room.Room
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import cn.buwei.nativeapp.BuildConfig

class ApiException(val status:Int,val code:String,override val message:String,val requestId:String=""):IOException(message)

class ClientRepository(val context:Context,private val testOrigin:String?=null,namespace:String="") {
    init {
        require((testOrigin==null && namespace.isEmpty()) || BuildConfig.DEBUG) {"测试配置仅允许在 Debug 使用"}
        testOrigin?.let {val uri=java.net.URI(it);require(uri.scheme=="http" && uri.host in setOf("127.0.0.1","localhost") && uri.rawPath.isNullOrEmpty()) {"测试服务必须是 loopback"}}
    }
    val json=Json { ignoreUnknownKeys=true }
    val secrets=SecureStore(context,namespace)
    private val db=Room.databaseBuilder(context,NativeDatabase::class.java,namespace+"native-workspace.db").build()
    val store get()=db.store()
    private val network=OkHttpClient.Builder().connectTimeout(15,TimeUnit.SECONDS).readTimeout(90,TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private val gate=Mutex()
    private val sessionLock=Any()
    private val _account=MutableStateFlow<JsonObject?>(null)
    val account=_account.asStateFlow()
    val accountId:String? get()=_account.value?.get("id")?.jsonPrimitive?.contentOrNull
    val status=MutableStateFlow("")
    @Volatile var epoch:Long=0; private set
    @Volatile private var credential:String?=null
    @Volatile private var initialized=false
    val origin:String get()=testOrigin?:BuildConfig.SERVICE_ORIGIN
    suspend fun restore()=withContext(Dispatchers.IO) {
        synchronized(sessionLock) {
            if(initialized) return@withContext
            val session=secrets.get("session")?.let {json.parseToJsonElement(it).jsonObject}
            credential=session?.get("cookie")?.jsonPrimitive?.content
            _account.value=session?.get("account") as? JsonObject
            initialized=true
        }
        if(credential!=null) try { validateSession() } catch(e:IOException) { if(e is ApiException) throw e else status.value="离线阅读：显示本机已保存内容" }
    }
    fun resolvePath(path:String):String {
        val normalized=if(path.startsWith("/api/")) path else "/api/v1/"+path.trimStart('/')
        require(!normalized.contains("..") && !normalized.contains('\\') && !normalized.contains('#') && !path.contains("://")) { "无效的服务资源路径" }
        return normalized
    }
    suspend fun get(path:String):JsonObject {
        val p=resolvePath(path); val owner=accountId; val generation=epoch
        try {
            val data=networkJson("GET",p,expectedOwner=owner,expectedEpoch=generation)
            assertOwner(owner,generation)
            if(owner!=null && OfflinePolicy.cacheable(p)) withContext(Dispatchers.IO) {
                store.putSnapshot(NativeDatabase.Snapshot().apply { account=owner; this.path=p; body=data.toString(); savedAt=System.currentTimeMillis() })
            }
            assertOwner(owner,generation)
            return data
        } catch(e:IOException) {
            assertOwner(owner,generation)
            if(e is ApiException) {
                if(e.status==401) expire()
                if(owner!=null && e.status in listOf(403,404) && OfflinePolicy.project(p)!=null) revokeIfNeeded(owner,OfflinePolicy.project(p)!!)
                throw e
            }
            assertOwner(owner,generation)
            if(owner!=null && OfflinePolicy.cacheable(p)) {
                val cached=withContext(Dispatchers.IO) { store.snapshot(owner,p) }
                assertOwner(owner,generation)
                if(cached!=null) { status.value="离线缓存 · ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(cached.savedAt))}"; return json.parseToJsonElement(cached.body).jsonObject }
            }
            throw IOException("网络不可用，且此内容尚未保存到本机",e)
        }
    }
    suspend fun request(method:String,path:String,body:JsonElement?=null,idempotencyKey:String?=null,expectedOwner:String?=accountId,expectedEpoch:Long=epoch):JsonObject {
        assertOwner(expectedOwner,expectedEpoch)
        if(method=="GET") return get(path)
        val p=resolvePath(path); val owner=expectedOwner; val generation=expectedEpoch
        // Offline-safe writes are durable before transport. A dropped response retries only the same key.
        if(owner!=null && OfflinePolicy.allowed(method,p)) return gate.withLock {
            val row=NativeDatabase.Operation().apply { id=idempotencyKey?:UUID.randomUUID().toString(); account=owner; project=OfflinePolicy.project(p)!!; this.path=p; this.method=method; this.body=(body?:JsonObject(emptyMap())).toString(); createdAt=System.currentTimeMillis() }
            withContext(Dispatchers.IO) {
                val existing=store.operation(owner,row.id)
                if(existing==null) {
                    row.createdAt=maxOf(row.createdAt,(store.operations(owner).lastOrNull()?.createdAt?:0)+1)
                    store.addOperation(row)
                } else require(existing.path==row.path&&existing.method==row.method&&existing.body==row.body) {"幂等键不能用于不同操作"}
            }
            assertOwner(owner,generation)
            try {
                validateSession()
                assertOwner(owner,generation)
                val preceding=withContext(Dispatchers.IO) {store.operations(owner).filter {it.project==row.project}}
                for(earlier in preceding.takeWhile {it.id!=row.id}) {
                    assertOwner(owner,generation)
                    if(earlier.state!="pending") {
                        status.value="当前项目有待处理的同步冲突；新操作已保存并等待"
                        return@withLock buildJsonObject {put("queued",true);put("operationId",row.id)}
                    }
                    try {sendOperation(earlier,generation);assertOwner(owner,generation);withContext(Dispatchers.IO){store.removeOperation(earlier.id,owner)}}
                    catch(e:ApiException){block(earlier,e);throw e}
                }
                val result=sendOperation(row,generation)
                assertOwner(owner,generation)
                withContext(Dispatchers.IO) { store.removeOperation(row.id,owner) }
                result
            } catch(e:IOException) {
                if(e is ApiException) { block(row,e); throw e }
                status.value="已保存本机待同步记录；联网后同步"
                buildJsonObject { put("queued",true); put("operationId",row.id) }
            }
        }
        val data=networkJson(method,p,body,idempotencyKey?:UUID.randomUUID().toString(),owner,generation)
        assertOwner(owner,generation)
        return data
    }
    suspend fun networkJson(method:String,path:String,body:JsonElement?=null,key:String?=null,expectedOwner:String?=accountId,expectedEpoch:Long=epoch):JsonObject = withContext(Dispatchers.IO) {
        val owner=expectedOwner;val generation=expectedEpoch
        val raw=execute(method,path,body?.toString()?.toRequestBody("application/json".toMediaType()),key,expectedOwner=owner,expectedEpoch=generation)
        raw.use { response ->
            assertOwner(owner,generation)
            val payload=response.body.string().let { runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull() }
            assertOwner(owner,generation)
            if(!response.isSuccessful) {
                val error=payload?.get("error") as? JsonObject
                throw ApiException(response.code,error?.get("code")?.jsonPrimitive?.contentOrNull?:"HTTP_${response.code}",error?.get("message")?.jsonPrimitive?.contentOrNull?:"请求失败 (${response.code})",response.header("X-Request-Id")?:"")
            }
            val value=payload?.get("data")?:throw IOException("服务返回了无效数据")
            return@withContext value as? JsonObject ?: buildJsonObject { put("items",value) }
        }
    }
    suspend fun execute(method:String,path:String,body:RequestBody?=null,key:String?=null,headers:Map<String,String> = emptyMap(),expectedOwner:String?=accountId,expectedEpoch:Long=epoch):Response {
        val p=resolvePath(path)
        val cookie=synchronized(sessionLock) {assertOwner(expectedOwner,expectedEpoch);credential}
        val builder=Request.Builder().url(origin+p).header("X-Request-Id",UUID.randomUUID().toString())
        cookie?.let { builder.header("Cookie",it) }
        key?.let { builder.header("Idempotency-Key",it) }
        headers.forEach { (name,value)->builder.header(name,value) }
        expectedOwner?.let { builder.header("X-Notification-Account",it) }
        builder.method(method,if(method in listOf("GET","HEAD")) null else body?:ByteArray(0).toRequestBody())
        val call=network.newCall(builder.build())
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object:Callback {
                override fun onFailure(call:Call,e:IOException) { if(continuation.isActive) continuation.resumeWithException(e) }
                override fun onResponse(call:Call,response:Response) { if(continuation.isActive) continuation.resume(response) { _,r,_ -> r.close() } else response.close() }
            })
        }
    }
    fun socket(path:String,listener:WebSocketListener,expectedOwner:String?=accountId,expectedEpoch:Long=epoch):WebSocket {
        val cookie=synchronized(sessionLock){assertOwner(expectedOwner,expectedEpoch);credential}
        val builder=Request.Builder().url(origin+resolvePath(path))
        cookie?.let { builder.header("Cookie",it) }
        return network.newWebSocket(builder.build(),listener)
    }
    suspend fun uploadPart(path:String,bytes:ByteArray,expectedOwner:String?=accountId,expectedEpoch:Long=epoch) {
        execute("PUT",path,bytes.toRequestBody("application/octet-stream".toMediaType()),headers=mapOf("X-Part-Size" to bytes.size.toString()),expectedOwner=expectedOwner,expectedEpoch=expectedEpoch).use {
            if(!it.isSuccessful) throw ApiException(it.code,"UPLOAD_FAILED","分片上传失败 (${it.code})，已保留续传记录")
        }
    }
    suspend fun exchange(code:String,verifier:String)=withContext(Dispatchers.IO) {
        val generation=epoch
        val response=execute("POST","/auth/native/exchange",buildJsonObject { put("code",code); put("codeVerifier",verifier) }.toString().toRequestBody("application/json".toMediaType()))
        response.use {
            check(generation==epoch) {"账户上下文已变化，请重新发起授权"}
            check(it.isSuccessful) { "授权兑换失败 (${it.code})，请重新登录" }
            val cookie=it.headers("Set-Cookie").firstOrNull { c->c.startsWith("ai_office_session=") }?.substringBefore(';')?:error("服务未返回登录会话")
            val user=json.parseToJsonElement(it.body.string()).jsonObject["data"]!!.jsonObject["user"]!!.jsonObject
            synchronized(sessionLock) {
                check(generation==epoch){"账户已变化，请重新授权"}
                secrets.put("session",buildJsonObject {put("cookie",cookie);put("account",user)}.toString())
                credential=cookie; epoch++; initialized=true; _account.value=user
            }
        }
    }
    suspend fun validateSession():JsonObject {
        val result=networkJson("GET","/auth/session")["user"]!!.jsonObject
        check(accountId==null || result["id"]?.jsonPrimitive?.content==accountId) { "账户发生变化，已停止操作" }
        return result
    }
    private suspend fun sendOperation(row:NativeDatabase.Operation,generation:Long):JsonObject {
        return networkJson("POST","/projects/${row.project}/offline-sync",buildJsonObject { put("method",row.method); put("tail",OfflinePolicy.tail(row.path)); put("body",json.parseToJsonElement(row.body)) },row.id,row.account,generation)
    }
    private suspend fun block(row:NativeDatabase.Operation,e:ApiException)=withContext(Dispatchers.IO) {
        row.state=if(e.status==409) "conflict" else if(e.status==429||e.status>=500) "pending" else "blocked"; row.reason=e.message; store.updateOperation(row)
        status.value=if(e.status==409) "同步版本冲突：本机草稿已保留，请检查待同步记录" else "待同步操作已停止：${e.message}"
        if(e.status==401) expire()
    }
    suspend fun sync()=gate.withLock {
        val owner=accountId?:return@withLock; val generation=epoch
        validateSession()
        val blocked=mutableSetOf<String>()
        for(row in withContext(Dispatchers.IO) { store.operations(owner) }) {
            assertOwner(owner,generation)
            if(row.state!="pending" || row.project in blocked) { blocked+=row.project; continue }
            try { sendOperation(row,generation); assertOwner(owner,generation); withContext(Dispatchers.IO) { store.removeOperation(row.id,owner) } }
            catch(e:ApiException) { block(row,e); blocked+=row.project; if(e.status==401) break }
        }
    }
    suspend fun pending():List<NativeDatabase.Operation> = withContext(Dispatchers.IO) { accountId?.let { store.operations(it) }?:emptyList() }
    suspend fun discardOperation(id:String)=withContext(Dispatchers.IO) { accountId?.let { store.removeOperation(id,it) } }
    suspend fun reviseOperation(id:String,body:JsonObject)=withContext(Dispatchers.IO) {
        val row=pending().firstOrNull { it.id==id }?:error("草稿不存在")
        // A corrected request is a new intent and must never reuse the previous idempotency key.
        store.addOperation(NativeDatabase.Operation().apply { this.id=UUID.randomUUID().toString(); account=row.account; project=row.project; path=row.path; method=row.method; this.body=body.toString(); createdAt=System.currentTimeMillis() })
        store.removeOperation(id,row.account)
    }
    suspend fun registerPushToken(token:String) {
        if(accountId==null) return
        val installation=secrets.get("installation")?:UUID.randomUUID().toString().also { secrets.put("installation",it) }
        networkJson("POST","/notifications/native-devices",buildJsonObject { put("token",token); put("installationId",installation); put("platform","android") },UUID.randomUUID().toString())
    }
    suspend fun logout() {
        // Do not silently turn a failed server revocation into a successful logout.
        networkJson("DELETE","/auth/session")
        cn.buwei.nativeapp.push.NativePushRegistration.clearNotifications(context)
        expire()
    }
    private fun expire()=synchronized(sessionLock) { secrets.put("session",null);epoch++;credential=null;_account.value=null }
    private fun assertOwner(owner:String?,generation:Long) { check(owner==accountId && generation==epoch) { "账户上下文已变化，操作已停止" } }
    private suspend fun revokeIfNeeded(owner:String,project:String) {
        try { networkJson("GET","/projects/$project") }
        catch(e:ApiException) { if(e.status in listOf(403,404)) withContext(Dispatchers.IO) { store.revokeSnapshots(owner,"/api/v1/projects/$project","/api/v1/projects/$project/%") } }
    }
    suspend fun download(path:String,destination:File) = withContext(Dispatchers.IO) {
        val owner=accountId?:error("请先登录"); val generation=epoch
        execute("GET",path,expectedOwner=owner,expectedEpoch=generation).use { response ->
            check(response.isSuccessful) { "文件读取失败 (${response.code})" }
            destination.parentFile?.mkdirs()
            val temporary=File(destination.path+".partial")
            try { response.body.byteStream().use { input -> temporary.outputStream().use { out -> val buffer=ByteArray(64*1024); while(true) { ensureActive(); assertOwner(owner,generation); val count=input.read(buffer); if(count<0) break; out.write(buffer,0,count) } } }; check(temporary.renameTo(destination)) { "文件保存失败" } }
            finally { temporary.delete() }
        }
    }
}

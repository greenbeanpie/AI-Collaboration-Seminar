package cn.buwei.nativeapp.data

import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Account-private, atomic recovery records. A failed write is visible to the caller. */
class NativeDraftStore(private val repository:ClientRepository) {
    companion object {
        private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
        private val locks=ConcurrentHashMap<String,Mutex>()
        private val versions=ConcurrentHashMap<String,AtomicLong>()
    }
    private fun file(owner:String,key:String):AtomicFile {
        require(UUID.fromString(owner).toString()==owner.lowercase()) {"账户标识无效"}
        val hash=MessageDigest.getInstance("SHA-256").digest(key.toByteArray()).joinToString(""){"%02x".format(it)}
        return AtomicFile(File(repository.context.filesDir,"accounts/$owner/form-drafts/$hash.json"))
    }
    private fun guard(owner:String,epoch:Long) {check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化，本机草稿操作已停止"}}
    fun scheduleSave(key:String,value:JsonObject,owner:String=repository.accountId?:error("请先登录"),epoch:Long=repository.epoch,onFailure:(Throwable)->Unit={}):Job {
        val identity=file(owner,key).baseFile.path
        val counter=versions.computeIfAbsent(identity){AtomicLong()};val token=counter.incrementAndGet()
        return scope.launch {
            try {locks.computeIfAbsent(identity){Mutex()}.withLock {if(counter.get()==token)write(key,value,owner,epoch){counter.get()==token}}}
            catch(failure:Exception){onFailure(failure)}
        }
    }
    suspend fun read(key:String,owner:String=repository.accountId?:error("请先登录"),epoch:Long=repository.epoch):JsonObject?=withContext(Dispatchers.IO) {
        guard(owner,epoch);val target=file(owner,key)
        locks.computeIfAbsent(target.baseFile.path){Mutex()}.withLock {
            val value=if(target.baseFile.exists()||File(target.baseFile.path+".bak").exists())target.openRead().bufferedReader().use {repository.json.parseToJsonElement(it.readText()).jsonObject} else null
            ensureActive();guard(owner,epoch);value
        }
    }
    suspend fun save(key:String,value:JsonObject,owner:String=repository.accountId?:error("请先登录"),epoch:Long=repository.epoch)=withContext(Dispatchers.IO) {
        val identity=file(owner,key).baseFile.path;versions.computeIfAbsent(identity){AtomicLong()}.incrementAndGet()
        locks.computeIfAbsent(identity){Mutex()}.withLock {write(key,value,owner,epoch)}
    }
    private suspend fun write(key:String,value:JsonObject,owner:String,epoch:Long,current:()->Boolean={true})=withContext(Dispatchers.IO) {
        ensureActive();guard(owner,epoch);val target=file(owner,key);check(target.baseFile.parentFile!!.mkdirs()||target.baseFile.parentFile!!.isDirectory)
        val output=target.startWrite()
        try {output.write(value.toString().toByteArray());ensureActive();guard(owner,epoch);if(current())target.finishWrite(output)else target.failWrite(output)}
        catch(failure:Throwable){target.failWrite(output);throw failure}
    }
    suspend fun remove(key:String,owner:String=repository.accountId?:error("请先登录"),epoch:Long=repository.epoch)=withContext(Dispatchers.IO) {
        ensureActive();guard(owner,epoch);val target=file(owner,key);versions.computeIfAbsent(target.baseFile.path){AtomicLong()}.incrementAndGet()
        locks.computeIfAbsent(target.baseFile.path){Mutex()}.withLock {target.delete();guard(owner,epoch)}
    }
}

/** Persists an explicit user's write identity before transport; never retries automatically. */
suspend fun ClientRepository.requestDurably(namespace:String,method:String,path:String,body:JsonObject?=null):JsonObject {
    require(method!="GET"&&method!="HEAD")
    val owner=accountId?:error("请先登录");val generation=epoch
    val payload=(body?:JsonObject(emptyMap())).toString()
    val fingerprint=MessageDigest.getInstance("SHA-256").digest("$method\n${resolvePath(path)}\n$payload".toByteArray()).joinToString(""){"%02x".format(it)}
    val key="intent:$namespace:$fingerprint";val drafts=NativeDraftStore(this)
    val saved=drafts.read(key,owner,generation)
    val idempotency=saved?.get("idempotencyKey")?.jsonPrimitive?.content?:UUID.randomUUID().toString().also {id->
        drafts.save(key,buildJsonObject {put("idempotencyKey",id);put("createdAt",System.currentTimeMillis());put("method",method);put("path",resolvePath(path))},owner,generation)
    }
    val response=request(method,path,body,idempotency,owner,generation)
    drafts.remove(key,owner,generation)
    return response
}

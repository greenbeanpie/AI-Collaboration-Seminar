package cn.buwei.nativeapp.data

import android.util.AtomicFile
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
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

/** In-memory coalescing only. No background scope, retry, or transport outlives its initiating call. */
private object DurableIntentRequests {
    data class Identity(val origin:String,val owner:String,val epoch:Long,val namespace:String,val fingerprint:String)
    class Pending(val result:Deferred<JsonObject>,var waiters:Int=0)
    val lock=Any()
    val pending=mutableMapOf<Identity,Pending>()
}

/** Persists an explicit user's write identity before transport; never retries automatically.
 * Calls that overlap for this exact backend/account epoch/intent await one transport result.
 * Failure releases only the in-memory operation; the persisted idempotency key survives for an
 * explicit retry. Cancelling the initiating caller cancels its child transport, retaining the key.
 */
suspend fun ClientRepository.requestDurably(namespace:String,method:String,path:String,body:JsonObject?=null):JsonObject=coroutineScope {
    require(method!="GET"&&method!="HEAD")
    val owner=accountId?:error("请先登录");val generation=epoch
    val payload=(body?:JsonObject(emptyMap())).toString()
    val fingerprint=MessageDigest.getInstance("SHA-256").digest("$method\n${resolvePath(path)}\n$payload".toByteArray()).joinToString(""){"%02x".format(it)}
    val identity=DurableIntentRequests.Identity(origin,owner,generation,namespace,fingerprint)
    val operation=synchronized(DurableIntentRequests.lock) {
        val current=DurableIntentRequests.pending[identity]
        if(current!=null)current.also {it.waiters++} else {
            val deferred=async(start=CoroutineStart.LAZY) {
                val key="intent:$namespace:$fingerprint";val drafts=NativeDraftStore(this@requestDurably)
                val saved=drafts.read(key,owner,generation)
                val idempotency=saved?.get("idempotencyKey")?.jsonPrimitive?.content?:UUID.randomUUID().toString().also {id->
                    drafts.save(key,buildJsonObject {put("idempotencyKey",id);put("createdAt",System.currentTimeMillis());put("method",method);put("path",resolvePath(path))},owner,generation)
                }
                val response=request(method,path,body,idempotency,owner,generation)
                drafts.remove(key,owner,generation)
                response
            }
            DurableIntentRequests.Pending(deferred,1).also {created->
                DurableIntentRequests.pending[identity]=created
                deferred.invokeOnCompletion {
                    synchronized(DurableIntentRequests.lock) {
                        if(created.waiters==0 && DurableIntentRequests.pending[identity]===created)DurableIntentRequests.pending.remove(identity)
                    }
                }
            }
        }
    }
    try {operation.result.start();val response=operation.result.await();check(accountId==owner&&epoch==generation){"账户已变化，已停止采用操作结果"};response}
    finally {
        synchronized(DurableIntentRequests.lock) {
            operation.waiters--
            if(operation.waiters==0 && operation.result.isCompleted && DurableIntentRequests.pending[identity]===operation)DurableIntentRequests.pending.remove(identity)
        }
    }
}

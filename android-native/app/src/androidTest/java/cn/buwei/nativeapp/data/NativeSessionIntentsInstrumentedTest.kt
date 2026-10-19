package cn.buwei.nativeapp.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Loopback fixtures exercise ownership races and disk-backed request identities, never production. */
class NativeSessionIntentsInstrumentedTest {
 private val context get()=ApplicationProvider.getApplicationContext<Context>()
 private fun user(id:String,name:String)=buildJsonObject{put("id",id);put("displayName",name);put("username","fixture");put("email",JsonNull);put("isAdmin",false);put("role","user")}
 private fun response(data:JsonObject,status:Int=200)=MockResponse().setResponseCode(status).setHeader("Content-Type","application/json").setBody(buildJsonObject{put("data",data)}.toString())
 private fun session(user:JsonObject)=response(buildJsonObject{put("user",user)})
 private fun repository(server:MockWebServer,namespace:String)=ClientRepository(context,server.url("/").toString().trimEnd('/'),namespace)
 private suspend fun login(server:MockWebServer,repository:ClientRepository,user:JsonObject,cookie:String="fixture"){
  server.enqueue(session(user).addHeader("Set-Cookie","ai_office_session=$cookie; HttpOnly"));repository.exchange("fixture-code","fixture-verifier");server.takeRequest()
 }
 @Test fun refreshedAccountPersistsNicknameRetainsCookieAndAvoidsUnchangedWrites()=runBlocking {
  val server=MockWebServer();server.start();val namespace="session-refresh-${UUID.randomUUID()}-";val id=UUID.randomUUID().toString();val repo=repository(server,namespace)
  try{login(server,repo,user(id,"Before"));val epoch=repo.epoch;val before=repo.secrets.get("session")!!.let{repo.json.parseToJsonElement(it).jsonObject};val updated=user(id,"After")
   server.enqueue(session(updated));assertEquals(updated,repo.validateSession());assertEquals(updated,repo.account.value);assertEquals(epoch,repo.epoch)
   val persisted=repo.json.parseToJsonElement(repo.secrets.get("session")!!).jsonObject;assertEquals(before["cookie"],persisted["cookie"]);assertEquals(updated,persisted["account"])
   val ciphertext=context.getSharedPreferences(namespace+"native-secrets",Context.MODE_PRIVATE).getString("session",null)
   server.enqueue(session(updated));repo.validateSession();assertEquals(ciphertext,context.getSharedPreferences(namespace+"native-secrets",Context.MODE_PRIVATE).getString("session",null))
  }finally{server.shutdown()}
 }
 @Test fun delayedSessionResponseCannotOverwriteNewlyAuthorizedAccount()=runBlocking {
  val server=MockWebServer();val first=UUID.randomUUID().toString();val second=UUID.randomUUID().toString();val auth=AtomicInteger();val seen=CountDownLatch(1)
  server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse=if(request.path!!.endsWith("/native/exchange")){val index=auth.incrementAndGet();session(user(if(index==1)first else second,if(index==1)"Old"else"New")).addHeader("Set-Cookie","ai_office_session=cookie-$index")}else{seen.countDown();session(user(first,"Late old response")).setBodyDelay(500,TimeUnit.MILLISECONDS)}};server.start();val repo=repository(server,"session-race-${UUID.randomUUID()}-")
  try{repo.exchange("first","fixture");val old=async(Dispatchers.Default){runCatching{repo.validateSession()}};withContext(Dispatchers.IO){assertTrue(seen.await(5,TimeUnit.SECONDS))};repo.exchange("second","fixture");assertTrue(old.await().exceptionOrNull()is IllegalStateException);assertEquals(second,repo.accountId);assertEquals("New",repo.account.value!!["displayName"]!!.jsonPrimitive.content);val saved=repo.json.parseToJsonElement(repo.secrets.get("session")!!).jsonObject;assertEquals(second,saved["account"]!!.jsonObject["id"]!!.jsonPrimitive.content);assertEquals("ai_office_session=cookie-2",saved["cookie"]!!.jsonPrimitive.content)
  }finally{server.shutdown()}
 }
 @Test fun overlappingIdenticalIntentsShareExactlyOneTransportAndResult()=runBlocking {
  val server=MockWebServer();server.start();val repo=repository(server,"intent-coalesce-${UUID.randomUUID()}-")
  try{login(server,repo,user(UUID.randomUUID().toString(),"Fixture"));server.enqueue(response(buildJsonObject{put("draftId","one-result")}).setBodyDelay(500,TimeUnit.MILLISECONDS));val start=CompletableDeferred<Unit>();val ready=AtomicInteger();val body=buildJsonObject{put("name","Fixture")}
   val pending=(1..12).map{async(Dispatchers.Default){ready.incrementAndGet();start.await();repo.requestDurably("creation","POST","/api/v1/creation-drafts",body)}}
   withTimeout(5000){while(ready.get()<12)delay(5)};start.complete(Unit);val values=pending.awaitAll();assertEquals(1,values.distinct().size);assertEquals("one-result",values.singleOrNull()?.get("draftId")?.jsonPrimitive?.content?:values.first()["draftId"]!!.jsonPrimitive.content);assertEquals(2,server.requestCount);val write=server.takeRequest();assertEquals("POST",write.method);assertNotNull(write.getHeader("Idempotency-Key"));assertTrue(repo.pending().isEmpty())
  }finally{server.shutdown()}
 }
 @Test fun failureDoesNotReplayAndExplicitRetryAfterRepositoryRestartReusesPersistedKey()=runBlocking {
  val server=MockWebServer();server.start();val namespace="intent-retry-${UUID.randomUUID()}-";val account=user(UUID.randomUUID().toString(),"Fixture");val repo=repository(server,namespace);val body=buildJsonObject{put("name","Retry fixture")}
  try{login(server,repo,account);server.enqueue(MockResponse().setResponseCode(503).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"UNAVAILABLE","message":"fixture failure"}}"""));try{repo.requestDurably("creation","POST","/api/v1/creation-drafts",body);fail("Fixture failure must be surfaced")}catch(e:ApiException){assertEquals(503,e.status)};val failed=server.takeRequest();val key=failed.getHeader("Idempotency-Key");delay(150);assertEquals(2,server.requestCount)
   val restarted=repository(server,namespace);server.enqueue(session(account));restarted.restore();assertEquals("GET",server.takeRequest().method);server.enqueue(response(buildJsonObject{put("draftId","restored-result")}));val result=restarted.requestDurably("creation","POST","/api/v1/creation-drafts",body);val retried=server.takeRequest();assertEquals(key,retried.getHeader("Idempotency-Key"));assertEquals("restored-result",result["draftId"]!!.jsonPrimitive.content);assertEquals(4,server.requestCount)
  }finally{server.shutdown()}
 }
 @Test fun coalescedFailureIsSharedWithoutImplicitRetry()=runBlocking {
  val server=MockWebServer();server.start();val repo=repository(server,"intent-failure-${UUID.randomUUID()}-")
  try{login(server,repo,user(UUID.randomUUID().toString(),"Fixture"));server.enqueue(MockResponse().setResponseCode(503).setHeader("Content-Type","application/json").setBody("""{"error":{"code":"UNAVAILABLE","message":"shared failure"}}""").setBodyDelay(500,TimeUnit.MILLISECONDS));val start=CompletableDeferred<Unit>();val ready=AtomicInteger();val body=buildJsonObject{put("name","Failure fixture")}
   val pending=(1..8).map{async(Dispatchers.Default){ready.incrementAndGet();start.await();runCatching{repo.requestDurably("creation","POST","/api/v1/creation-drafts",body)}}};withTimeout(5000){while(ready.get()<8)delay(5)};start.complete(Unit);val results=pending.awaitAll();assertTrue(results.all{it.exceptionOrNull()is ApiException});assertEquals(2,server.requestCount);delay(150);assertEquals(2,server.requestCount)
  }finally{server.shutdown()}
 }
 @Test fun oldIntentResponseIsRejectedAndDifferentAccountDoesNotJoinItsOperation()=runBlocking {
  val server=MockWebServer();val first=UUID.randomUUID().toString();val second=UUID.randomUUID().toString();val auth=AtomicInteger();val posts=AtomicInteger();val firstPost=CountDownLatch(1)
  server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{if(request.path!!.endsWith("/native/exchange")){val index=auth.incrementAndGet();return session(user(if(index==1)first else second,"Account $index")).addHeader("Set-Cookie","ai_office_session=cookie-$index")};val index=posts.incrementAndGet();if(index==1)firstPost.countDown();return response(buildJsonObject{put("draftId","result-$index")}).setBodyDelay(if(index==1)500 else 0,TimeUnit.MILLISECONDS)}};server.start();val repo=repository(server,"intent-account-${UUID.randomUUID()}-");val body=buildJsonObject{put("name","Same body")}
  try{repo.exchange("first","fixture");val old=async(Dispatchers.Default){runCatching{repo.requestDurably("creation","POST","/api/v1/creation-drafts",body)}};withContext(Dispatchers.IO){assertTrue(firstPost.await(5,TimeUnit.SECONDS))};repo.exchange("second","fixture");val fresh=repo.requestDurably("creation","POST","/api/v1/creation-drafts",body);assertEquals("result-2",fresh["draftId"]!!.jsonPrimitive.content);assertTrue(old.await().exceptionOrNull()is IllegalStateException);assertEquals(2,posts.get());assertEquals(second,repo.accountId)
  }finally{server.shutdown()}
 }
}

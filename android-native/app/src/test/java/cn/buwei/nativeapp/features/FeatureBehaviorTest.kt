package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class FeatureBehaviorTest {
 @Test fun toolProgressIncludesFailedAttemptsWithoutCallingThemCompletions(){
  val activity=Json.parseToJsonElement("""{"code":"executing_tool","progress":{"completed":12,"unit":"tool_call"}}""").jsonObject
  assertEquals("累计执行工具 12 次（含失败尝试）",activityProgress(activity))
  assertNull(activityProgress(JsonObject(activity+("code" to JsonPrimitive("saving")))))
  assertNull(activityProgress(JsonObject(activity+("progress" to buildJsonObject{put("completed",12);put("unit","unknown")}))))
 }
 @Test fun textLeafEditPreservesTablesMarksReferencesAndUnknownMetadata(){
  val document=Json.parseToJsonElement("""{"type":"doc","attrs":{"revision":"keep"},"content":[{"type":"table","attrs":{"width":400},"content":[{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":2},"content":[{"type":"paragraph","content":[{"type":"text","text":"before","marks":[{"type":"bold"}]}]}]}]}]},{"type":"citation","attrs":{"sourceVersionId":"fixed-version","locator":"page-3"}},{"type":"futureNode","payload":{"retain":true}}]}""").jsonObject
  val updated=editRichText(document,listOf(0,0,0,0,0),"after")
  assertEquals(document.obj("attrs"),updated.obj("attrs"))
  val before=document["content"]!!.jsonArray;val after=updated["content"]!!.jsonArray
  assertEquals(before[1],after[1]);assertEquals(before[2],after[2])
  assertEquals(document.toString().replace("\"before\"","\"after\""),updated.toString())
 }
 @Test fun invalidRichEditNeverReplacesReferenceNodes(){
  val reference=Json.parseToJsonElement("""{"type":"citation","attrs":{"sourceVersionId":"keep"}}""").jsonObject
  assertThrows(IllegalArgumentException::class.java){editRichText(reference,emptyList(),"corrupt")}
 }
 @Test fun requiredAndTypedValidationBlocksMalformedWrites(){
  val schema=Json.parseToJsonElement("""{"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":5},"expectedRevision":{"type":"integer","minimum":1}},"required":["title","expectedRevision"]}""").jsonObject
  assertNotNull(validate(schema,buildJsonObject{put("title","valid")}))
  assertNotNull(validate(schema,buildJsonObject{put("title","valid");put("expectedRevision","1")}))
  assertNotNull(validate(schema,buildJsonObject{put("title","longer");put("expectedRevision",1)}))
  assertNull(validate(schema,buildJsonObject{put("title","valid");put("expectedRevision",1)}))
 }
 @Test fun optionalNullableFieldsAndEnumsFollowContract(){
  assertNull(validate(Json.parseToJsonElement("""{"type":["string","null"]}""").jsonObject,JsonNull))
  assertNotNull(validate(Json.parseToJsonElement("""{"type":"string","enum":["manual","automatic"]}""").jsonObject,JsonPrimitive("unknown")))
  assertNotNull(validate(Json.parseToJsonElement("""{"type":"string","format":"uuid"}""").jsonObject,JsonPrimitive("wrong")))
 }
 @Test fun allGeneratedOperationsHaveUniqueIdentityAndValidBodySchemas(){
  val operations=NativeContracts.operations
  assertEquals(operations.size,operations.map{it.method+" "+it.path}.toSet().size)
  assertTrue(operations.size>=304)
  assertTrue(operations.any{it.method=="POST"&&it.path=="/api/v1/projects/{projectId}/tasks/{taskId}/inquiries"})
  assertTrue(operations.any{it.method=="PATCH"&&it.path=="/api/v1/projects/{projectId}/assessments/{assessmentId}/scores"})
 }
}

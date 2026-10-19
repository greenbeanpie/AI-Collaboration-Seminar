package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CreationContractTest {
 private fun draft(revision:Int=3,previewRevision:Int=3,state:String="ready",status:String="active")=buildJsonObject{put("status",status);put("revision",revision);put("previewRevision",previewRevision);put("previewState",state);put("previewAttemptId","11111111-1111-4111-8111-111111111111")}
 @Test fun longFileNamesRetainParserExtension(){val name=creationSafeFileName("报告".repeat(120)+".pptx");assertTrue(name.endsWith(".pptx"));assertTrue(name.length<=180);assertFalse(creationSafeFileName("../incompatible:document.docx").contains(':') )}
 @Test fun commitPinsRevisionAndAttempt(){val body=creationCommitBody(draft());assertEquals(3,body["expectedRevision"]!!.jsonPrimitive.int);assertTrue(body["confirmed"]!!.jsonPrimitive.boolean);assertEquals("11111111-1111-4111-8111-111111111111",body["expectedPreviewAttemptId"]!!.jsonPrimitive.content)}
 @Test fun stalePreviewCannotBeCommitted(){assertThrows(IllegalArgumentException::class.java){creationCommitBody(draft(previewRevision=2))}}
 @Test fun pausedOrCancelledCannotBeCommitted(){assertThrows(IllegalArgumentException::class.java){creationCommitBody(draft(state="paused_round_limit"))};assertThrows(IllegalArgumentException::class.java){creationCommitBody(draft(status="cancelled"))}}
 @Test fun editingRetainsUnknownFieldsAndExplicitRemoval(){val original=Json.parseToJsonElement("""{"title":"before","citations":[{"fileId":"retained","quote":"source"}],"future":{"keep":true},"deadlineDate":"2026-10-19"}""").jsonObject;val updated=creationPatch(creationPatch(original,"title",JsonPrimitive("after")),"deadlineDate",null);assertEquals(original["citations"],updated["citations"]);assertEquals(original["future"],updated["future"]);assertFalse(updated.containsKey("deadlineDate"))}
}

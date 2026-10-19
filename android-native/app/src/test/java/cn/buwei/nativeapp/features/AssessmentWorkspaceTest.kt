package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AssessmentWorkspaceTest {
    @Test fun correctionPinsRevisionAndSendsOnlyEditedDimensions() {
        val assessment = Json.parseToJsonElement("""{"revision":7,"report":{"scores":[{"key":"a","score":64,"comment":"原说明"},{"key":"b","score":99,"comment":"人工保留"}]}}""").jsonObject
        val dimensions = listOf(buildJsonObject { put("key", "a") }, buildJsonObject { put("key", "b") })
        val result = assessmentCorrectionBody(assessment, dimensions, mapOf("a" to "80"), emptyMap(), "核对固定材料", "人工反馈")
        assertEquals(7, result["expectedRevision"]!!.jsonPrimitive.int)
        assertEquals(1, result.rows("scores").size)
        assertEquals("a", result.rows("scores")[0].text("key"))
        assertEquals("原说明", result.rows("scores")[0].text("comment"))
        assertThrows(IllegalArgumentException::class.java) { assessmentCorrectionBody(assessment, dimensions, emptyMap(), emptyMap(), "理由", "反馈") }
        assertThrows(IllegalArgumentException::class.java) { assessmentCorrectionBody(assessment, dimensions, mapOf("a" to "Infinity"), emptyMap(), "理由", "反馈") }
    }
    @Test fun standardBodyPreservesFixedCitationsAndMapsGeneratedDimensionKeys() {
        val citation = buildJsonObject { put("sourceVersionId", "fixed-source"); put("fragmentId", "fixed-fragment"); put("pageNumber", 3); put("quote", "调查证据 40分") }
        val result = assessmentStandardBody("项目标准", listOf(AssessmentDimension("evidence", "调查证据", "40", listOf(citation)), AssessmentDimension("delivery", "成果质量", "60")))
        assertEquals(listOf("evidence", "delivery"), result.rows("weights").map { it.text("key") })
        assertEquals("evidence", result.rows("requirements")[0].text("dimensionKey"))
        assertEquals(citation, result.rows("requirements")[0].rows("citations")[0])
        assertEquals("scoring", result.rows("requirements")[0].text("category"))
        assertEquals(JsonNull, result.rows("requirements")[0]["dueDate"])
    }
    @Test fun malformedOrDuplicateDimensionsCannotPublish() {
        listOf(listOf(AssessmentDimension("x", "", "100")), listOf(AssessmentDimension("x", "调查", "NaN")), listOf(AssessmentDimension("x", "调查", "0")), listOf(AssessmentDimension("x", "调查", "101")), listOf(AssessmentDimension("x", "调查", "50"), AssessmentDimension("x", "成果", "50"))).forEach { dimensions -> assertThrows(IllegalArgumentException::class.java) { assessmentStandardBody("项目标准", dimensions) } }
    }
    @Test fun rehearsalCreationFreezesSortedSelectionsAndRequiresMember() {
        val body = rehearsalCreation("member", "member-id", setOf("v2", "v1"), setOf("s1"))
        assertEquals(listOf("v1", "v2"), body["materialVersionIds"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("member-id", body.text("memberId"))
        assertEquals(JsonNull, rehearsalCreation("all", "ignored", emptySet(), emptySet())["memberId"])
        assertThrows(IllegalArgumentException::class.java) { rehearsalCreation("member", "", emptySet(), emptySet()) }
    }
    @Test fun answerRequiresSavedQuestionOwnershipAndNoPendingGeneration() {
        val ready = Json.parseToJsonElement("""{"canOperate":true,"status":"active","processingStatus":null,"turns":[{"role":"assistant","kind":"question","content":"具体证据？"}]}""").jsonObject
        assertTrue(rehearsalCanAnswer(ready))
        assertFalse(rehearsalCanAnswer(JsonObject(ready + ("canOperate" to JsonPrimitive(false)))))
        assertFalse(rehearsalCanAnswer(JsonObject(ready + ("processingStatus" to JsonPrimitive("running")))))
        assertFalse(rehearsalCanAnswer(JsonObject(ready + ("status" to JsonPrimitive("finished")))))
        assertFalse(rehearsalCanAnswer(JsonObject(ready + ("turns" to buildJsonArray { add(buildJsonObject { put("role", "user"); put("kind", "answer") }) }))))
    }
}

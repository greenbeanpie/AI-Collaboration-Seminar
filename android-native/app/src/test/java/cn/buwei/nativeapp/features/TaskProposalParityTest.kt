package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class TaskProposalParityTest {
    private val payload=Json.parseToJsonElement("""{"references":[{"quote":"不可变引用"}],"tasks":[{"title":"任务一","detail":"原说明","criteria":"证据齐全","effortHours":1,"dependsOn":[]},{"key":"second","title":"任务二","detail":"","criteria":"完成","effortHours":2,"dependsOn":["t1"]}],"updates":[{"taskId":"update-id","title":"已有任务","detail":"","criteria":"完成","effortHours":3,"expectedRevision":7}],"assignments":[{"taskId":"assign-id","expectedRevision":9,"assigneeId":null,"reason":"负荷核对"}]}""").jsonObject
    @Test fun omittedSelectionRemainsDefaultAllWhileExplicitEmptyArraysStayEmpty() {
        assertEquals(setOf("expectedRevision"),proposalApplyBody(4,payload).keys)
        val empty=proposalApplyBody(4,payload,proposalSelectionKeys(payload))
        listOf("selectedTaskKeys","selectedUpdateTaskIds","selectedAssignmentTaskIds").forEach{assertEquals(JsonArray(emptyList()),empty[it])}
    }
    @Test fun partialSelectionUsesDistinctNamespacesAndBackendFallbackKeys() {
        val selected=proposalApplyBody(6,payload,setOf("tasks:t1","updates:update-id"))
        assertEquals(listOf("second"),selected.twIds("selectedTaskKeys"));assertTrue(selected.twIds("selectedUpdateTaskIds").isEmpty());assertEquals(listOf("assign-id"),selected.twIds("selectedAssignmentTaskIds"))
        assertThrows(IllegalArgumentException::class.java){proposalApplyBody(6,payload,setOf("tasks:missing"))}
    }
    @Test fun revisionPreservesDependenciesReferencesAndExpectedTaskVersions() {
        val body=proposalRevisionBody(8,payload,"  核对实际依赖  ")
        assertEquals(8,body["expectedRevision"]!!.jsonPrimitive.int);assertEquals("核对实际依赖",body.twText("reason"))
        val saved=body.obj("payload");assertEquals(payload["references"],saved["references"]);assertEquals(listOf("t1"),saved.twRows("tasks")[1].twIds("dependsOn"))
        assertEquals(7,saved.twRows("updates")[0]["expectedRevision"]!!.jsonPrimitive.int);assertEquals(payload["assignments"],saved["assignments"])
    }
    @Test fun invalidHoursAndSelfOrDuplicateDependenciesCannotBeSaved() {
        fun withTask(row:JsonObject)=buildJsonObject{put("tasks",JsonArray(listOf(row)))}
        val base=payload.twRows("tasks")[0]
        listOf("NaN","Infinity","0","201","not a number").forEach{hours->assertThrows(IllegalArgumentException::class.java){proposalRevisionBody(1,withTask(JsonObject(base+("effortHours" to JsonPrimitive(hours)))),"人工修订")}}
        listOf(listOf("t1"),listOf("other","other"),listOf("")).forEach{deps->assertThrows(IllegalArgumentException::class.java){proposalRevisionBody(1,withTask(JsonObject(base+("dependsOn" to JsonArray(deps.map(::JsonPrimitive))))),"人工修订")}}
    }
    @Test fun redoFeedbackTargetsExistingProposalAndDoesNotCreateAiDispatchBody() {
        val body=proposalFeedbackBody("proposal-id","  请核对原始依据  ")
        assertEquals(setOf("targetType","targetId","feedback","requestAiRedo"),body.keys);assertEquals("proposal",body.twText("targetType"));assertEquals("proposal-id",body.twText("targetId"));assertTrue(body.flag("requestAiRedo"))
        assertThrows(IllegalArgumentException::class.java){proposalFeedbackBody("proposal-id"," ")}
    }
    @Test fun dependencyTypingIsNormalizedOnlyWhenSaving() {
        val row=JsonObject(payload.twRows("tasks")[1]+("dependsOn" to JsonPrimitive(" t1, existing-task， ")))
        assertEquals(" t1, existing-task， ",row.twText("dependsOn"))
        val body=proposalRevisionBody(4,buildJsonObject{put("tasks",JsonArray(listOf(row)))},"明确保存依赖")
        assertEquals(listOf("t1","existing-task"),body.obj("payload").twRows("tasks")[0].twIds("dependsOn"))
    }
    @Test fun frozenFeedbackUsesOnlyServerSnapshotAndPreservesClearAndZeroVersions() {
        assertNull(nativeFrozenFeedback(buildJsonObject{put("feedback","当前版本不得代替冻结依据")}))
        listOf(0,3).forEach{version->val snapshot=buildJsonObject{put("version",version);put("feedback","");put("versionId",JsonNull)};assertEquals(snapshot,nativeFrozenFeedback(buildJsonObject{put("feedbackSnapshot",snapshot)}))}
        assertNull(nativeFrozenFeedback(buildJsonObject{put("feedbackSnapshot",buildJsonObject{put("version",-1);put("feedback","错误版本")} )}))
    }
}

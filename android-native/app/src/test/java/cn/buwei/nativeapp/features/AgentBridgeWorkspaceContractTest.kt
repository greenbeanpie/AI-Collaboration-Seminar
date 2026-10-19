package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AgentBridgeWorkspaceContractTest {
 private val actor="11111111-1111-4111-8111-111111111111"
 private fun task(revision:Int=3)=buildJsonObject{put("revision",revision);put("assigneeId",actor)}
 private fun handoff()=buildJsonObject{put("state","ready_for_review");put("taskRevision",3);put("stale",false);put("adoptedSubmissionId",JsonNull);put("result",buildJsonObject{put("summary","Reviewed output");put("artifacts",JsonArray(emptyList()))})}
 @Test fun parsesFullDshConnectionLink(){assertEquals(actor,bridgePairingFromLink("https://office.example/app/agent-bridges/connect?pairing=$actor"))}
 @Test fun rejectsBareIdsWrongPathsAndDuplicatePairings(){listOf(actor,"http://office.example/app/agent-bridges/connect?pairing=$actor","https://office.example/unrelated?pairing=$actor","https://office.example/app/agent-bridges/connect?pairing=$actor&pairing=$actor").forEach{value->assertThrows(IllegalArgumentException::class.java){bridgePairingFromLink(value)}}}
 @Test fun eligibilityRequiresCurrentVersionPositiveConclusionAndHash(){val ready=buildJsonObject{put("status","ready");put("taskRevision",3);put("eligible",true);put("sourceHash","fixed-input")};assertTrue(bridgeEligible(ready,task()));assertFalse(bridgeEligible(ready,task(4)));assertFalse(bridgeEligible(JsonObject(ready+("eligible" to JsonPrimitive(false))),task()));assertFalse(bridgeEligible(JsonObject(ready+("sourceHash" to JsonPrimitive(""))),task()))}
 @Test fun deviceMustBePairedAuthorizedAndBoundToWorkspace(){val device=Json.parseToJsonElement("""{"paired":true,"revoked":false,"protocolVersion":1,"projects":[{"projectId":"project","workspaceLabel":"working"}]}""").jsonObject;assertTrue(bridgeBound(device,"project"));assertFalse(bridgeBound(device,"other"));assertFalse(bridgeBound(JsonObject(device+("revoked" to JsonPrimitive(true))),"project"));assertFalse(bridgeBound(JsonObject(device+("projects" to Json.parseToJsonElement("""[{"projectId":"project","workspaceLabel":null}]"""))),"project"))}
 @Test fun reviewedAdoptionPinsTaskRevision(){val body=bridgeAdoptionBody(handoff(),task(),actor,true);assertTrue(body["reviewed"]!!.jsonPrimitive.boolean);assertEquals(3,body["expectedTaskRevision"]!!.jsonPrimitive.int)}
 @Test fun rejectsUnreviewedOldOrAlreadySubmittedResults(){assertThrows(IllegalArgumentException::class.java){bridgeAdoptionBody(handoff(),task(),actor,false)};assertThrows(IllegalArgumentException::class.java){bridgeAdoptionBody(handoff(),task(4),actor,true)};assertThrows(IllegalArgumentException::class.java){bridgeAdoptionBody(JsonObject(handoff()+("adoptedSubmissionId" to JsonPrimitive("existing"))),task(),actor,true)}}
 @Test fun onlyCurrentAssigneeCanAdopt(){assertThrows(IllegalArgumentException::class.java){bridgeAdoptionBody(handoff(),task(),"different",true)}}
 @Test fun uncertainAndWaitingInputRemainActive(){assertTrue(bridgeActive(buildJsonObject{put("state","dispatch_uncertain")}));assertTrue(bridgeActive(buildJsonObject{put("state","waiting_input")}));assertFalse(bridgeActive(handoff()))}
}

package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import java.net.URI
import java.util.UUID

internal const val bridgeBase="/api/v1/agent-bridges"
internal fun bridgePairingFromLink(value:String):String {
 val uri=URI(value.trim());require(uri.scheme=="https"&&uri.host!=null&&uri.rawUserInfo==null&&uri.path=="/app/agent-bridges/connect"){"请粘贴 DSH 生成的完整 HTTPS 连接授权链接"}
 val values=uri.rawQuery.orEmpty().split('&').map{it.split('=',limit=2)}.filter{it[0]=="pairing"};require(values.size==1&&values[0].size==2){"连接链接缺少配对请求"}
 val id=java.net.URLDecoder.decode(values[0][1],"UTF-8");require(UUID.fromString(id).toString()==id.lowercase()){ "配对请求无效" };return id
}
internal fun bridgeActive(item:JsonObject)=item.text("state") !in listOf("blocked","failed","cancelled","ready_for_review")
internal fun bridgeEligible(eligibility:JsonObject?,task:JsonObject):Boolean=eligibility?.text("status")=="ready"&&eligibility["taskRevision"]==task["revision"]&&eligibility["eligible"]?.jsonPrimitive?.booleanOrNull==true&&eligibility.text("sourceHash").isNotBlank()
internal fun bridgeBound(device:JsonObject,project:String)=device["paired"]?.jsonPrimitive?.booleanOrNull==true&&device["revoked"]?.jsonPrimitive?.booleanOrNull!=true&&device.text("protocolVersion")=="1"&&(device["projects"]as? JsonArray).orEmpty().any{it.jsonObject.text("projectId")==project&&it.jsonObject.text("workspaceLabel").isNotBlank()}
internal fun bridgeAdoptionBody(item:JsonObject,task:JsonObject,owner:String,reviewed:Boolean):JsonObject {
 require(reviewed&&item.text("state")=="ready_for_review"&&item["result"]is JsonObject){"请先核对可采纳的成果"}
 require(item["stale"]?.jsonPrimitive?.booleanOrNull!=true&&item["taskRevision"]==task["revision"]&&item.text("adoptedSubmissionId").isBlank()){ "成果已过期或已经提交" }
 require(task.text("assigneeId")==owner){"仅当前任务执行人可采纳提交"}
 return buildJsonObject{put("expectedTaskRevision",task["revision"]!!);put("reviewed",true)}
}
internal fun bridgeStateLabel(state:String)=mapOf("checking" to "正在判断任务适用性","waiting_device" to "等待 DSH 接收","claimed" to "DSH 已领取任务","running" to "Agent 正在执行","waiting_input" to "请在 DSH 中处理审批或输入","uploading" to "正在同步成果","ready_for_review" to "成果草稿待核对","blocked" to "无法交给 AI 执行","failed" to "执行失败","cancel_requested" to "等待 DSH 确认取消","cancelled" to "已取消","dispatch_uncertain" to "执行状态待核对，请查看 DSH 会话")[state]?:state

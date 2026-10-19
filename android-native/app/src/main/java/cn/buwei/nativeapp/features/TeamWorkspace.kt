package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.NativeAiReferenceBadge
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

@Composable fun TeamWorkspace(repository:ClientRepository,projectId:String){key(projectId,repository.accountId){TeamWorkspaceContent(repository,projectId)}}
@Composable private fun TeamWorkspaceContent(repository:ClientRepository,projectId:String){
 val base=twBase(projectId);var refresh by remember{mutableIntStateOf(0)};var me by remember{mutableStateOf<JsonObject?>(null)};var workload by remember{mutableStateOf<Map<String,Double>>(emptyMap())};var error by remember{mutableStateOf<String?>(null)}
 LaunchedEffect(projectId,repository.accountId,refresh){try{me=repository.get("$base/members/me");workload=repository.get("$base/tasks/graph").twRows().filter{it.twText("status")!="done"}.groupBy{it.twText("assigneeId")}.mapValues{(_,rows)->rows.sumOf{it.twText("effortHours").toDoubleOrNull()?:0.0}};error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 Text("团队成员",style=MaterialTheme.typography.headlineSmall);Text("权限以当前项目成员身份为准，系统管理员身份不授予项目权限。",style=MaterialTheme.typography.bodySmall);error?.let{Text(it,color=MaterialTheme.colorScheme.error)};TextButton({refresh++}){Text("刷新成员与权限")}
 var query by rememberSaveable{mutableStateOf("")};var applied by rememberSaveable{mutableStateOf("")};TaskWorkspaceField("搜索成员姓名",query,{query=it},200);OutlinedButton({applied=query.trim()}){Text("搜索成员")}
 val canManage=me?.twCan("teamManage")==true;val owner=me?.twText("role")=="owner"
 TaskWorkspacePage(repository,"$base/members?limit=100&q=${Uri.encode(applied)}",refresh){rows->rows.forEach{member->key(member.twText("userId")){Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
 Text(member.twText("displayName"),style=MaterialTheme.typography.titleMedium);NativeAiReferenceBadge();Text(if(member.twText("role")=="owner")"项目负责人"else"项目成员");Text(member.twText("username").ifBlank{member.twText("email")});workload[member.twText("userId")]?.let{Text("未完成任务预计投入：$it 小时")};val permissions=member["permissions"] as? JsonObject
 Text(teamPermissionLabels.filter{permissions?.get(it.first)?.jsonPrimitive?.booleanOrNull==true||member.twText("role")=="owner"}.joinToString("、"){it.second}.ifBlank{"未授予管理权限"})
 if(owner&&member.twText("role")!="owner")TeamWorkspacePermissions(repository,base,member){refresh++}
 if(canManage&&member.twText("role")!="owner"&&member.twText("userId")!=repository.accountId)TaskWorkspaceAction(repository,"移除该成员","$base/members/${Uri.encode(member.twText("userId"))}",method="DELETE",confirmation="确定移除 ${member.twText("displayName")}？对方将失去此项目访问权限。",onSuccess={refresh++})
 }}}}}
 if(me!=null&&!owner)TaskWorkspaceAction(repository,"退出项目","$base/members/me",method="DELETE",confirmation="退出后将失去项目访问权限。尚未同步的本机内容不会提交。",onSuccess={me=null;refresh++})
 HorizontalDivider();TeamWorkspaceRequests(repository,base,canManage,refresh){refresh++}
 if(canManage){HorizontalDivider();TeamWorkspaceInvitations(repository,base,refresh){refresh++};HorizontalDivider();TeamWorkspaceUsernameInvitations(repository,base,refresh){refresh++}}
 }
}
internal val teamPermissionLabels=listOf("teamManage" to "团队管理","taskManage" to "任务管理","resourceManage" to "资料管理","scoreInitiate" to "评分发起","scoreCorrect" to "历史评分修正")
@Composable private fun TeamWorkspacePermissions(repository:ClientRepository,base:String,member:JsonObject,onChanged:()->Unit){
 var expanded by remember{mutableStateOf(false)};OutlinedButton({expanded=!expanded}){Text("调整项目权限")};if(!expanded)return
 var values by remember(member.twText("userId"),member.twText("permissionsRevision")){mutableStateOf(teamPermissionLabels.associate{(id,_)->id to ((member["permissions"] as? JsonObject)?.get(id)?.jsonPrimitive?.booleanOrNull==true)})}
 teamPermissionLabels.forEach{(id,label)->Row{Checkbox(values[id]==true,{checked->values=values+(id to checked)});Text(label,Modifier.padding(top=12.dp))}}
 TaskWorkspaceAction(repository,"保存成员权限","$base/members/${Uri.encode(member.twText("userId"))}/permissions",buildJsonObject{put("expectedRevision",member["permissionsRevision"]!!);put("permissions",buildJsonObject{values.forEach{(id,enabled)->put(id,enabled)}})},"PATCH",confirmation="确定调整 ${member.twText("displayName")} 的项目权限？",onSuccess={expanded=false;onChanged()})
}
@Composable private fun TeamWorkspaceRequests(repository:ClientRepository,base:String,manage:Boolean,refresh:Int,onChanged:()->Unit){
 Text("邀请申请",style=MaterialTheme.typography.titleLarge);Text(if(manage)"审核成员提出的邀请申请，批准后向指定用户名发送邀请。"else"填写对方用户名，向项目管理员申请邀请。")
 var username by rememberSaveable{mutableStateOf("")};TaskWorkspaceField("对方用户名",username,{username=it},64);TaskWorkspaceAction(repository,"提交邀请申请","$base/invitation-requests",buildJsonObject{put("username",username.trim())},enabled=username.isNotBlank(),onSuccess={username="";onChanged()})
 TaskWorkspacePage(repository,"$base/invitation-requests",refresh){rows->rows.forEach{row->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(row.twText("username"));Text(mapOf("pending" to "待审批","approved" to "已批准","rejected" to "已拒绝")[row.twText("status")].orEmpty());Text(row.twText("createdAt"));if(manage&&row.twText("status")=="pending")listOf("approve" to "批准申请","reject" to "拒绝申请").forEach{(action,label)->TaskWorkspaceAction(repository,label,"$base/invitation-requests/${Uri.encode(row.twText("id"))}/decide",buildJsonObject{put("expectedRevision",twRevision(row));put("action",action)},confirmation="确定${label} ${row.twText("username")}？",onSuccess={onChanged()})}}}}}
}
@Composable private fun TeamWorkspaceInvitations(repository:ClientRepository,base:String,refresh:Int,onChanged:()->Unit){
 Text("邀请码",style=MaterialTheme.typography.titleLarge);var uses by rememberSaveable{mutableStateOf("")};var days by rememberSaveable{mutableStateOf("7")};var created by remember{mutableStateOf<String?>(null)}
 if(created!=null){Text("邀请码仅在此处显示一次，请保存后发送给受邀者。");SelectionContainer{Text(created!!,style=MaterialTheme.typography.titleMedium)};TextButton({created=null}){Text("创建另一个邀请码")}}
 else{TaskWorkspaceField("使用次数（留空不限，1–100）",uses,{uses=it},3);TaskWorkspaceField("有效天数（1–30）",days,{days=it},2);val count=uses.toIntOrNull();val duration=days.toIntOrNull();TaskWorkspaceAction(repository,"创建邀请码","$base/invitations",buildJsonObject{put("maxUses",count?.let{JsonPrimitive(it)}?:JsonNull);put("expiresInDays",duration?:7)},enabled=(uses.isBlank()||count in 1..100)&&duration in 1..30,onSuccess={created=it.twText("code");onChanged()})}
 TaskWorkspacePage(repository,"$base/invitations",refresh){rows->rows.forEach{invite->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){val active=invite.twText("revokedAt").isBlank()&&runCatching{java.time.Instant.parse(invite.twText("expiresAt")).isAfter(java.time.Instant.now())}.getOrDefault(false);Text(if(active)"有效邀请"else"已撤销或过期");Text("有效期至 ${invite.twText("expiresAt")}");Text("已使用 ${invite.twText("usedCount")} / ${invite.twText("maxUses").ifBlank{"不限"}}");if(invite.twText("revokedAt").isBlank())TaskWorkspaceAction(repository,"撤销邀请码","$base/invitations/${Uri.encode(invite.twText("invitationId"))}",method="DELETE",confirmation="撤销后此邀请码不能继续加入项目。",onSuccess={onChanged()})}}}}
}
@Composable private fun TeamWorkspaceUsernameInvitations(repository:ClientRepository,base:String,refresh:Int,onChanged:()->Unit){
 Text("按用户名邀请",style=MaterialTheme.typography.titleLarge);var username by rememberSaveable{mutableStateOf("")};var days by rememberSaveable{mutableStateOf("7")};TaskWorkspaceField("用户名",username,{username=it},64);TaskWorkspaceField("有效天数（1–30）",days,{days=it},2);TaskWorkspaceAction(repository,"发送用户名邀请","$base/username-invitations",buildJsonObject{put("username",username.trim());put("expiresInDays",days.toIntOrNull()?:7)},enabled=username.isNotBlank()&&days.toIntOrNull() in 1..30,confirmation="将向 $username 发送项目邀请。",onSuccess={username="";onChanged()})
 TeamWorkspaceOffsetPage(repository,"$base/username-invitations",refresh){rows->rows.forEach{row->Text("${row.twText("username")} · ${teamInvitationStatus(row.twText("status"))} · 有效期至 ${row.twText("expiresAt")}");if(row.twText("status")=="pending")TaskWorkspaceAction(repository,"撤销用户名邀请","$base/username-invitations/${Uri.encode(row.twText("id"))}/revoke",confirmation="确定撤销给 ${row.twText("username")} 的邀请？",onSuccess={onChanged()})}}
}
internal fun teamInvitationStatus(value:String)=mapOf("pending" to "待接受","accepted" to "已接受","declined" to "已拒绝","revoked" to "已撤销","expired" to "已过期")[value]?:value
@Composable internal fun TeamWorkspaceOffsetPage(repository:ClientRepository,path:String,refresh:Int,content:@Composable (List<JsonObject>)->Unit){
 var offset by remember(path,repository.accountId){mutableIntStateOf(0)};var rows by remember(path,repository.accountId){mutableStateOf<List<JsonObject>>(emptyList())};var next by remember{mutableStateOf<Int?>(null)};var error by remember{mutableStateOf<String?>(null)};var generation by remember{mutableIntStateOf(refresh)}
 LaunchedEffect(path,refresh,offset){try{if(generation!=refresh){offset=0;generation=refresh};val result=repository.get("$path?offset=$offset");rows=if(offset==0)result.twRows()else(rows+result.twRows()).distinctBy{it.twText("id")};next=result["nextOffset"]?.jsonPrimitive?.intOrNull;error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};content(rows);next?.let{OutlinedButton({offset=it}){Text("加载更多邀请")}}
}

/** Global join entry. Caller may navigate to the returned project after success. */
@Composable fun TeamWorkspaceJoin(repository:ClientRepository,onJoined:(String)->Unit={}){key(repository.accountId){
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
 Text("加入项目",style=MaterialTheme.typography.headlineSmall);var code by rememberSaveable{mutableStateOf("")};var preview by remember{mutableStateOf<JsonObject?>(null)};var previewCode by remember{mutableStateOf("")};var refresh by remember{mutableIntStateOf(0)}
 TaskWorkspaceField("邀请码",code,{code=it;preview=null},200)
 TaskWorkspaceAction(repository,"预览邀请项目","/api/v1/invitations/preview",buildJsonObject{put("code",code.trim())},enabled=code.trim().length>=10,onSuccess={preview=it;previewCode=code.trim()})
 preview?.let{Text(it.twText("name").ifBlank{it.twText("projectName")},style=MaterialTheme.typography.titleLarge);NativeMarkdown(it.twText("description"));TaskWorkspaceAction(repository,"确认加入项目","/api/v1/invitations/accept",buildJsonObject{put("code",previewCode)},enabled=code.trim()==previewCode,confirmation="确定加入预览中的项目？此操作将使用一次邀请码。",onSuccess={code="";preview=null;refresh++;onJoined(it.twText("projectId"))})}
 HorizontalDivider();Text("收到的用户名邀请",style=MaterialTheme.typography.titleLarge)
 TeamWorkspaceOffsetPage(repository,"/api/v1/invitations/inbox",refresh){rows->rows.forEach{row->key(row.twText("id")){Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){Text(row.twText("projectName"),style=MaterialTheme.typography.titleMedium);Text("邀请人：${row.twText("inviterName")} · ${teamInvitationStatus(row.twText("status"))}");Text("有效期至 ${row.twText("expiresAt")}");if(row.twText("status")=="pending"){var invitationPreview by remember{mutableStateOf<JsonObject?>(null)};TaskWorkspaceAction(repository,"查看邀请项目","/api/v1/invitations/inbox/${Uri.encode(row.twText("id"))}/preview",method="GET",onSuccess={invitationPreview=it});invitationPreview?.let{NativeMarkdown(it.twText("description"));TaskWorkspaceAction(repository,"接受邀请","/api/v1/invitations/inbox/${Uri.encode(row.twText("id"))}",buildJsonObject{put("action","accept")},confirmation="确定加入 ${row.twText("projectName")}？",onSuccess={refresh++;onJoined(it.twText("projectId"))})};TaskWorkspaceAction(repository,"拒绝邀请","/api/v1/invitations/inbox/${Uri.encode(row.twText("id"))}",buildJsonObject{put("action","decline")},confirmation="确定拒绝 ${row.twText("projectName")} 的邀请？",onSuccess={refresh++})}}}}}}
 }
}}

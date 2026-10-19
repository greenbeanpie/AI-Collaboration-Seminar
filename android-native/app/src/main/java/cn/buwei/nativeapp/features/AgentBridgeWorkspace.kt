package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.time.Instant

@Composable fun AgentBridgeWorkspace(repository:ClientRepository){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope()
 var devices by remember(owner){mutableStateOf<List<JsonObject>>(emptyList())};var link by rememberSaveable(owner){mutableStateOf("")};var pairing by remember(owner){mutableStateOf<JsonObject?>(null)};var selected by remember{mutableStateOf<Set<String>>(emptySet())};var error by remember{mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)};var confirmation by remember{mutableStateOf<String?>(null)}
 suspend fun get(path:String)=repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)
 suspend fun reload(){devices=(get("$bridgeBase/devices")["items"]as? JsonArray).orEmpty().map{it.jsonObject}}
 fun action(block:suspend ()->Unit){busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}
 LaunchedEffect(owner){try{reload()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text("本地 Agent",style=MaterialTheme.typography.headlineSmall)
  Text("在 DSH 插件管理器安装补位桥接器，然后在插件详情选择“连接网站”。此处授权设备与项目；在 DSH 选择项目工作目录并保持其打开。连接不会自行执行任务。")
  Text("DSH 安装来源",style=MaterialTheme.typography.titleMedium);SelectionContainerBridge("https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.1.tgz")
  OutlinedTextField(link,{link=it;pairing=null;selected=emptySet()},label={Text("粘贴 DSH 完整连接授权链接")},modifier=Modifier.fillMaxWidth())
  OutlinedButton({action{val id=bridgePairingFromLink(link);pairing=get("$bridgeBase/pairings/$id");selected=emptySet()}},enabled=!busy&&link.isNotBlank()){Text("读取设备连接请求")}
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  pairing?.let{value->val expired=runCatching{Instant.parse(value.text("expiresAt"))<=Instant.now()}.getOrDefault(true)
   Card{Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){Text("设备：${value.text("deviceName")}",style=MaterialTheme.typography.titleMedium);Text("有效期：${value.text("expiresAt")}")
    if(value.text("status")=="approved")Text("连接已授权，请回到 DSH 选择项目目录。")else if(expired||value.text("status")=="expired")Text("连接已过期，请在 DSH 重新发起。")else{
     Text("选择允许设备读取任务输入及回传成果的项目：")
     (value["projects"]as? JsonArray).orEmpty().forEach{item->val project=item.jsonObject;Row{Checkbox(project.text("projectId")in selected,{checked->selected=if(checked)selected+project.text("projectId")else selected-project.text("projectId")});Text(project.text("name"))}}
     Button({confirmation="approve"},enabled=!busy&&selected.isNotEmpty()){Text("确认连接并授权项目")}
    }
   }}
  }
  Text("已连接设备",style=MaterialTheme.typography.titleLarge);OutlinedButton({action{reload()}},enabled=!busy){Text("刷新设备")}
  if(devices.isEmpty())Text("尚未连接设备，请从 DSH 插件开始连接。")
  devices.forEach{device->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){
   Text(device.text("deviceName"),style=MaterialTheme.typography.titleMedium);val revoked=device["revoked"]?.jsonPrimitive?.booleanOrNull==true
   Text(if(revoked)"连接已撤销"else if(runCatching{Instant.parse(device.text("lastSeenAt")).isAfter(Instant.now().minusSeconds(90))}.getOrDefault(false))"DSH 在线"else"等待 DSH 上线")
   Text("DSH ${device.text("dshVersion")} · 桥接器 ${device.text("bridgeVersion")}")
   (device["projects"]as? JsonArray).orEmpty().forEach{item->Text("${item.jsonObject.text("name")}：${item.jsonObject.text("workspaceLabel").ifBlank{"请在 DSH 选择工作目录"}}")}
   if(!revoked){AgentBridgeWorkspaceScopes(repository,device){action{reload()}};TextButton({confirmation="revoke:${device.text("deviceId")}"},enabled=!busy){Text("撤销此设备连接")}}
  }}}
 }
 confirmation?.let{chosen->AlertDialog(onDismissRequest={confirmation=null},title={Text(if(chosen=="approve")"授权设备及所选项目？"else"撤销设备连接？")},text={Text(if(chosen=="approve")"允许该设备读取所选项目的任务输入并回传成果，任务仍须在任务页明确发起。"else"撤销设备及项目授权，并停止其未结束交接。")},confirmButton={TextButton({confirmation=null;action{if(chosen=="approve"){val id=pairing!!.text("pairingId");repository.requestDurably("bridge","POST","$bridgeBase/pairings/$id/approve",buildJsonObject{put("projectIds",JsonArray(selected.map(::JsonPrimitive)))});pairing=get("$bridgeBase/pairings/$id")}else repository.requestDurably("bridge","DELETE","$bridgeBase/devices/${chosen.substringAfter(':')}");reload()}}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})}
}
@Composable private fun SelectionContainerBridge(value:String){androidx.compose.foundation.text.selection.SelectionContainer{Text(value)}}

@Composable private fun AgentBridgeWorkspaceScopes(repository:ClientRepository,device:JsonObject,onSaved:()->Unit){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch}
 var options by remember(owner,device.text("deviceId")){mutableStateOf<List<JsonObject>?>(null)};var selected by remember(device.text("deviceId")){mutableStateOf<Set<String>>(emptySet())};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirm by remember{mutableStateOf(false)};val scope=rememberCoroutineScope()
 val path="$bridgeBase/devices/${device.text("deviceId")}/projects"
 TextButton({scope.launch{busy=true;try{options=(repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)["items"]as? JsonArray).orEmpty().map{it.jsonObject};selected=options.orEmpty().filter{it["authorized"]?.jsonPrimitive?.booleanOrNull==true}.map{it.text("projectId")}.toSet()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("管理项目授权")}
 options?.let{projects->Text("取消授权会停止对应项目的未结束交接；目录请在 DSH 修改。")
  projects.forEach{project->Row{Checkbox(project.text("projectId")in selected,{checked->selected=if(checked)selected+project.text("projectId")else selected-project.text("projectId")});Text(project.text("name"))}}
  Button({confirm=true},enabled=!busy){Text("保存项目授权")};TextButton({options=null}){Text("关闭授权编辑")}
 }
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 if(confirm)AlertDialog(onDismissRequest={confirm=false},title={Text("更新设备项目授权？")},text={Text("未选择的项目将撤销授权，并停止对应项目的未结束交接。")},confirmButton={TextButton({confirm=false;busy=true;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};repository.requestDurably("bridge","POST",path,buildJsonObject{put("projectIds",JsonArray(selected.map(::JsonPrimitive)))});options=null;onSaved()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton({confirm=false}){Text("返回")}})
}


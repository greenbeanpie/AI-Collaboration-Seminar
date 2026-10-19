package cn.buwei.nativeapp.features

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import cn.buwei.nativeapp.push.NativePushRegistration
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun NotificationWorkspace(repository:ClientRepository,onNavigate:((String)->Unit)?=null){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope()
 var settings by remember(owner){mutableStateOf<JsonObject?>(null)};var items by remember(owner){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember(owner){mutableStateOf<String?>(null)};var unread by remember(owner){mutableIntStateOf(0)};var showDismissed by remember{mutableStateOf(false)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var permission by remember{mutableStateOf(NotificationManagerCompat.from(repository.context).areNotificationsEnabled())}
 val requestPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){permission=it}
 suspend fun get(path:String)=repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)
 suspend fun page(more:Boolean){val previous=if(more)cursor else null;val page=get("/api/v1/notifications?limit=50"+(previous?.let{"&cursor="+android.net.Uri.encode(it)}?:""));val next=page.text("nextCursor").takeIf{it.isNotBlank()};check(next==null||next!=previous){"通知分页未前进，请重新读取"};items=notificationWorkspaceMerge(if(more)items else emptyList(),(page["items"]as? JsonArray).orEmpty().map{it.jsonObject});cursor=next;unread=page["unreadCount"]?.jsonPrimitive?.intOrNull?:0}
 fun action(block:suspend ()->Unit){if(busy)return;busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){if(e is cn.buwei.nativeapp.data.ApiException&&e.status in listOf(401,403,404)){items=emptyList();cursor=null;unread=0};error=e.message}finally{busy=false}}}
 LaunchedEffect(owner){try{settings=get("/api/v1/notifications/settings");page(false)}catch(e:CancellationException){throw e}catch(e:Exception){if(e is cn.buwei.nativeapp.data.ApiException&&e.status in listOf(401,403,404)){items=emptyList();cursor=null;unread=0};error=e.message}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("推送与通知",style=MaterialTheme.typography.headlineSmall);error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  settings?.let{preferences->listOf("inAppEnabled" to "站内通知","pushEnabled" to "系统推送与后台补查").forEach{(key,label)->Row{Switch(preferences[key]?.jsonPrimitive?.booleanOrNull==true,{enabled->action{settings=repository.requestDurably("notifications","PUT","/api/v1/notifications/settings",buildJsonObject{put(key,enabled)});if(enabled&&key=="pushEnabled")NativePushRegistration.refresh(repository.context,repository,scope)}},enabled=!busy);Text(label)}}}
  Text(if(permission)"安卓系统通知权限已开启"else"安卓系统通知权限未开启")
  Text(if(NativePushRegistration.isAvailable(repository.context))"此设备具备即时通知客户端条件，是否注册成功以连接状态为准。"else"即时通知未配置或设备缺少 Google 服务。仍可查看站内通知，后台约每15分钟补查，可能延迟。")
  val status by repository.status.collectAsState();if(status.isNotBlank())Text(status)
  OutlinedButton({if(Build.VERSION.SDK_INT>=33)requestPermission.launch(Manifest.permission.POST_NOTIFICATIONS)else{val intent=Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,repository.context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);repository.context.startActivity(intent)}},enabled=!busy){Text("设置安卓通知权限")}
  TextButton({action{NativePushRegistration.refresh(repository.context,repository,scope);permission=NotificationManagerCompat.from(repository.context).areNotificationsEnabled();settings=get("/api/v1/notifications/settings");page(false)}},enabled=!busy){Text("刷新通知与连接状态")}
  Text("未读 $unread 条",style=MaterialTheme.typography.titleLarge);Button({action{repository.requestDurably("notifications","POST","/api/v1/notifications/read-all");page(false)}},enabled=!busy&&unread>0){Text("全部标为已读（覆盖所有分页）")}
  Row{Checkbox(showDismissed,{showDismissed=it});Text("显示已收起通知")}
  val visible=items.filter{showDismissed||it.text("dismissedAt").isBlank()};if(visible.isEmpty())Text("暂无通知")
  visible.forEach{item->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
   Text(item.text("title"),style=MaterialTheme.typography.titleMedium);Text(item.text("body"));Text(item.text("createdAt"),style=MaterialTheme.typography.labelSmall);Text(if(item.text("dismissedAt").isNotBlank())"已收起"else if(item.text("readAt").isNotBlank())"已读"else"未读")
   if(item.text("readAt").isBlank())TextButton({action{val updated=repository.requestDurably("notifications","POST","/api/v1/notifications/${item.text("id")}/read");items=notificationWorkspaceMerge(items,listOf(updated));unread=maxOf(0,unread-1)}},enabled=!busy){Text("标为已读")}
   if(item.text("dismissedAt").isBlank())TextButton({action{val updated=repository.requestDurably("notifications","POST","/api/v1/notifications/${item.text("id")}/dismiss");items=notificationWorkspaceMerge(items,listOf(updated));if(item.text("readAt").isBlank())unread=maxOf(0,unread-1)}},enabled=!busy){Text("收起通知")}
   val target=notificationWorkspaceTarget(item.text("url"));if(target!=null&&onNavigate!=null)OutlinedButton({action{if(item.text("readAt").isBlank()){val updated=repository.requestDurably("notifications","POST","/api/v1/notifications/${item.text("id")}/read");items=notificationWorkspaceMerge(items,listOf(updated))};onNavigate(target)}},enabled=!busy){Text("查看相关内容")}
  }}}
  if(cursor!=null)OutlinedButton({action{page(true)}},enabled=!busy){Text("加载更早通知")}
 }
}

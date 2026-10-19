package cn.buwei.nativeapp

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.buwei.nativeapp.data.*
import cn.buwei.nativeapp.features.FeatureScreen
import cn.buwei.nativeapp.features.AiConversationScreen
import cn.buwei.nativeapp.features.ProjectCreationScreen
import cn.buwei.nativeapp.media.MediaWorkspace
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class MainActivity:ComponentActivity() {
    private val repository get()=(application as NativeApplication).repository
    private val auth by lazy { NativeAuth(repository) }
    private val notificationPermission=registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private var fatal by mutableStateOf<String?>(null)
    private var busy by mutableStateOf(true)
    private var section by mutableStateOf("projects")
    private var projectId by mutableStateOf<String?>(null)
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        section=savedInstanceState?.getString("section")?:"projects"; projectId=savedInstanceState?.getString("project")
        lifecycleScope.launch { try { repository.restore(); handleIntent(intent) } catch(e:Exception) { if(e is CancellationException) throw e; fatal=e.message } finally { busy=false } }
        setContent { AppContent() }
    }
    override fun onSaveInstanceState(outState:Bundle) { outState.putString("section",section); outState.putString("project",projectId); super.onSaveInstanceState(outState) }
    override fun onNewIntent(intent:Intent) { super.onNewIntent(intent); setIntent(intent); lifecycleScope.launch { try { handleIntent(intent) } catch(e:Exception) { if(e is CancellationException) throw e; fatal=e.message } } }
    private suspend fun handleIntent(intent:Intent) {
        intent.data?.let { if(it.scheme=="buwei-native-preview") { busy=true; try { auth.finish(it) } finally { busy=false } } }
        val event=intent.getStringExtra("notificationEventId")
        if(event!=null && repository.accountId!=null) {
            // Payloads are hints only. Resolve through authorized server inbox before navigating.
            val account=intent.getStringExtra("notificationAccountId")
            if(account==repository.accountId) { repository.validateSession(); section="notifications"; projectId=null }
        }
    }
    private fun navigate(next:String) { if(cn.buwei.mobile.RecordingService.instance!=null && next=="projects") { fatal="录制期间请先停止并保存，再切换项目"; return }; section=next }
    @Composable private fun AppContent() {
        val user by repository.account.collectAsStateWithLifecycle()
        val status by repository.status.collectAsStateWithLifecycle()
        var theme by remember { mutableStateOf(getPreferences(MODE_PRIVATE).getString("theme","system")?:"system") }
        val dark=theme=="dark" || (theme=="system" && isSystemInDarkTheme())
        val palette=if(dark) darkColorScheme(primary=Color(0xFF9DD2B9),secondary=Color(0xFFB7CCBF)) else lightColorScheme(primary=Color(0xFF356B56),secondary=Color(0xFF52685C),background=Color(0xFFF8FAF6),surface=Color(0xFFF8FAF6))
        MaterialTheme(colorScheme=palette) {
            Surface(Modifier.fillMaxSize()) {
                if(busy) Box(Modifier.fillMaxSize().padding(32.dp)) { CircularProgressIndicator() }
                else if(user==null) LoginView()
                else BoxWithConstraints {
                    val tablet=maxWidth>=720.dp
                    Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                        if(tablet) NavigationRail { listOf("projects" to "项目","notifications" to "通知","profile" to "我的").forEach { (key,title)->NavigationRailItem(selected=section==key,onClick={projectId=null;navigate(key)},icon={Text(title.take(1))},label={Text(title)}) } }
                        Column(Modifier.weight(1f)) {
                            Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=8.dp),horizontalArrangement=Arrangement.SpaceBetween) {
                                TextButton(onClick={ if(projectId!=null && section!="overview") navigate("overview") else { projectId=null;navigate("projects") } }) { Text("补位 · "+(if(projectId==null) "原生预览" else "项目工作区")) }
                                TextButton(onClick={ lifecycleScope.launch { try { repository.sync(); repository.status.value="同步检查完成" } catch(e:Exception) { fatal=e.message } } }) { Text("同步") }
                            }
                            if(status.isNotBlank()) Text(status,Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=4.dp),style=MaterialTheme.typography.bodySmall)
                            if(projectId!=null) ProjectNavigation()
                            Box(Modifier.weight(1f).fillMaxWidth()) {
                                when(section) {
                                    "appearance" -> Column(Modifier.padding(20.dp)) { Text("外观",style=MaterialTheme.typography.headlineMedium); listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach { (key,title)->TextButton(onClick={theme=key;getPreferences(MODE_PRIVATE).edit().putString("theme",key).apply()}) {Text((if(theme==key) "✓ " else "")+title)} } }
                                    "offline" -> OfflineView(repository)
                                    "media" -> MediaWorkspace(repository,projectId)
                                    "create-project" -> ProjectCreationScreen(repository) {id->projectId=id;section="overview"}
                                    "ai-chat" -> projectId?.let {AiConversationScreen(repository,it){next->navigate(next)}}
                                    else -> FeatureScreen(repository,section,projectId,{id->projectId=id;section="overview"},{next->navigate(next)})
                                }
                            }
                            if(!tablet) NavigationBar { listOf("projects" to "项目","notifications" to "通知","profile" to "我的").forEach { (key,title)->NavigationBarItem(selected=section==key,onClick={projectId=null;navigate(key)},icon={Text(title.take(1))},label={Text(title)}) } }
                        }
                    }
                }
                fatal?.let { message->AlertDialog(onDismissRequest={fatal=null},title={Text("操作提示")},text={Text(message)},confirmButton={TextButton(onClick={fatal=null}) {Text("知道了")}}) }
            }
        }
        LaunchedEffect(user?.get("id")) { if(user!=null) {
            if(Build.VERSION.SDK_INT>=33) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            cn.buwei.nativeapp.push.NativePushRegistration.refresh(this@MainActivity,repository,lifecycleScope)
        } }
    }
    @Composable private fun LoginView() {
        Column(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(28.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.Center) {
            Text("补位",style=MaterialTheme.typography.displayMedium,color=MaterialTheme.colorScheme.primary)
            Text("AI 项目办公室",style=MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(24.dp))
            Text("原生安卓预览版",style=MaterialTheme.typography.headlineSmall)
            Text("使用原有账户登录。仅登录验证在系统浏览器完成，项目界面使用安卓原生组件。旧版未同步资料仍保留在旧版中。",Modifier.padding(vertical=16.dp))
            Button(onClick={ lifecycleScope.launch { busy=true; try { val url=auth.begin(); CustomTabsIntent.Builder().build().launchUrl(this@MainActivity,android.net.Uri.parse(url)) } catch(e:Exception) { fatal=e.message } finally { busy=false } } },modifier=Modifier.fillMaxWidth()) {Text("登录 / 注册")}
            Text("首次使用需要网络；登录服务需部署配套原生授权接口。",Modifier.padding(top=16.dp),style=MaterialTheme.typography.bodySmall)
        }
    }
    @Composable private fun ProjectNavigation() {
        var expanded by remember { mutableStateOf(false) }
        // Always-visible primary entries; secondary tools remain one labelled tap away.
        Row(Modifier.fillMaxWidth().padding(horizontal=12.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
            listOf("overview" to "概览","tasks" to "任务","data" to "资料","assessment" to "评估").forEach { (key,title)->TextButton(onClick={navigate(key)}) {Text(title)} }
            Box { TextButton(onClick={expanded=true}) {Text("更多")}; DropdownMenu(expanded,onDismissRequest={expanded=false}) {
                listOf("team" to "团队","ai-chat" to "项目 AI","rehearsals" to "排练","media" to "录制与文件","ledger" to "项目记录","export" to "导出","project-settings" to "项目设置","offline" to "本机待同步").forEach { (key,title)->DropdownMenuItem(text={Text(title)},onClick={expanded=false;navigate(key)}) }
            } }
        }
    }
}

@Composable private fun OfflineView(repository:ClientRepository) {
    var rows by remember { mutableStateOf<List<NativeDatabase.Operation>>(emptyList()) }
    var edit by remember { mutableStateOf<NativeDatabase.Operation?>(null) }
    var text by remember { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    LaunchedEffect(Unit) { rows=repository.pending() }
    Column(Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState())) {
        Text("本机待同步",style=MaterialTheme.typography.headlineMedium)
        Text("冲突会保留原始提交；核对服务端最新版本后编辑并作为新操作提交。")
        rows.forEach { row->Card(Modifier.fillMaxWidth().padding(vertical=8.dp)) { Column(Modifier.padding(12.dp)) {
            Text("${row.method} ${row.path}"); Text("${row.state} ${row.reason}")
            TextButton(onClick={edit=row;text=row.body}) {Text("检查 / 修订草稿")}
        } } }
        if(rows.isEmpty()) Text("没有待同步记录",Modifier.padding(vertical=16.dp))
    }
    edit?.let { row->AlertDialog(onDismissRequest={edit=null},title={Text("检查离线操作")},text={Column { OutlinedTextField(text,{text=it},label={Text("保留字段及 expectedRevision")},modifier=Modifier.heightIn(max=300.dp));error?.let {Text(it)} }},confirmButton={TextButton(onClick={scope.launch { try { repository.reviseOperation(row.id,repository.json.parseToJsonElement(text).jsonObject);rows=repository.pending();edit=null } catch(e:Exception) {error=e.message} }}) {Text("保存修订")}},dismissButton={TextButton(onClick={edit=null}) {Text("保留原稿")}}) }
}

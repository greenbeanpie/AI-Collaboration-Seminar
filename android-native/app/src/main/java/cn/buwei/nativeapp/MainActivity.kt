package cn.buwei.nativeapp

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.net.toUri
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
import cn.buwei.nativeapp.media.ExportWorkspace
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

class MainActivity:ComponentActivity() {
    private val model by viewModels<NativeViewModel>()
    private val repository get()=model.repository
    private val auth get()=model.auth
    private val notificationPermission=registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private var fatal:String? get()=model.fatal;set(value){model.fatal=value}
    private var busy:Boolean get()=model.busy;set(value){model.busy=value}
    private var section:String get()=model.section;set(value){model.section=value}
    private var projectId:String? get()=model.projectId;set(value){model.projectId=value}
    override fun onCreate(savedInstanceState:Bundle?) {
        super.onCreate(savedInstanceState); enableEdgeToEdge()
        section=savedInstanceState?.getString("section")?:"projects"; projectId=savedInstanceState?.getString("project")
        if(savedInstanceState?.containsKey("destinationSection")==true)model.destination=NativeDestination(savedInstanceState.getString("destinationSection")?:section,projectId,savedInstanceState.getString("record"),savedInstanceState.getString("resourceType"),savedInstanceState.getString("version"),savedInstanceState.getString("assessmentSection"),savedInstanceState.getString("taskAction"),savedInstanceState.getInt("pageNumber",0).takeIf{it>0},savedInstanceState.getString("username"))
        lifecycleScope.launch { try { repository.restore(); handleIntent(intent) } catch(e:Exception) { if(e is CancellationException) throw e; fatal=e.message } finally { busy=false } }
        setContent { AppContent() }
    }
    override fun onSaveInstanceState(outState:Bundle) { outState.putString("section",section); outState.putString("project",projectId); model.destination?.let{outState.putString("destinationSection",it.section);outState.putString("record",it.recordId);outState.putString("resourceType",it.resourceType);outState.putString("version",it.versionId);outState.putString("assessmentSection",it.assessmentSection);outState.putString("taskAction",it.taskAction);outState.putInt("pageNumber",it.pageNumber?:0);outState.putString("username",it.username)}; super.onSaveInstanceState(outState) }
    override fun onNewIntent(intent:Intent) { super.onNewIntent(intent); setIntent(intent); lifecycleScope.launch { try { handleIntent(intent) } catch(e:Exception) { if(e is CancellationException) throw e; fatal=e.message } } }
    private suspend fun handleIntent(intent:Intent) {
        intent.data?.let { if(it.scheme=="buwei-native-preview") { busy=true; try { auth.finish(it) } finally { busy=false } } }
        val event=intent.getStringExtra("notificationEventId")
        if(event!=null && repository.accountId!=null) {
            // Payloads are hints only. Resolve through authorized server inbox before navigating.
            val account=intent.getStringExtra("notificationAccountId")
            if(account==repository.accountId) { repository.validateSession(); openGlobal("notifications") }
        }
    }
    private fun canNavigate():Boolean {
        if(cn.buwei.mobile.RecordingService.instance!=null || model.workspaceActive) {fatal="请先停止录制并保存，或等待当前文件上传完成，再切换工作区";return false}
        return true
    }
    private fun navigate(next:String) {
        if(next.startsWith("/app")){openPath(next);return}
        if(next in listOf("/login","/password-forgot","/password-reset")){
            if(!canNavigate())return
            lifecycleScope.launch{try{val url=if(next=="/login")auth.begin()else repository.origin+next;CustomTabsIntent.Builder().build().launchUrl(this@MainActivity,url.toUri())}catch(e:CancellationException){throw e}catch(e:Exception){fatal=e.message}}
            return
        }
        if(!canNavigate())return
        model.navigationGeneration++;model.routeLoading=false;model.destination=null
        if(next in listOf("projects","create-project","join","profile","people","notifications","support","help","bridges","accounts","system","ai-settings","appearance"))projectId=null
        section=next
    }
    private fun openGlobal(next:String) {
        if(!canNavigate())return
        model.navigationGeneration++;model.routeLoading=false;model.destination=null;projectId=null;section=next
    }
    private fun openProject(id:String) {
        if(!canNavigate())return
        model.navigationGeneration++;model.routeLoading=false;model.destination=null;projectId=id;section="overview"
    }
    private fun openPath(path:String) {
        if(!canNavigate())return
        val target=nativeDestination(path)?:run{fatal="此链接暂不能在原生应用中打开";return}
        val owner=repository.accountId?:return;val epoch=repository.epoch;val generation=++model.navigationGeneration
        model.routeLoading=true
        lifecycleScope.launch {try {
            target.projectId?.let {repository.networkJson("GET","/api/v1/projects/$it",expectedOwner=owner,expectedEpoch=epoch)}
            check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
            if(generation==model.navigationGeneration&&canNavigate()){model.destination=target;projectId=target.projectId;section=target.section}
        }catch(e:CancellationException){throw e}catch(e:Exception){if(generation==model.navigationGeneration)fatal=e.message}
        finally{if(generation==model.navigationGeneration)model.routeLoading=false} }
    }
    @Composable private fun AppContent() {
        val user by repository.account.collectAsStateWithLifecycle()
        val status by repository.status.collectAsStateWithLifecycle()
        val appearance=(application as NativeApplication).appearance
        val theme by appearance.mode.collectAsStateWithLifecycle(initialValue="system")
        val dark=theme=="dark" || (theme=="system" && isSystemInDarkTheme())
        BackHandler(user!=null&&section!="projects"){if(projectId!=null&&section!="overview")navigate("overview")else openGlobal("projects")}
        NativeTheme(dark) {
            Surface(Modifier.fillMaxSize()) {
                if(busy) Box(Modifier.fillMaxSize().padding(32.dp)) { CircularProgressIndicator() }
                else if(user==null) LoginView()
                else BoxWithConstraints {
                    val tablet=maxWidth>=720.dp
                    Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
                        if(tablet) NavigationRail { listOf("projects" to "项目","notifications" to "通知","profile" to "我的").forEach { (key,title)->NavigationRailItem(selected=section==key,onClick={openGlobal(key)},icon={Text(title.take(1))},label={Text(title)}) } }
                        Column(Modifier.weight(1f)) {
                            Row(Modifier.fillMaxWidth().padding(horizontal=16.dp,vertical=8.dp),horizontalArrangement=Arrangement.SpaceBetween) {
                                TextButton(onClick={ if(projectId!=null && section!="overview") navigate("overview") else openGlobal("projects") }) { Text("补位 · "+(if(projectId==null) "原生预览" else "项目工作区")) }
                                TextButton(onClick={ lifecycleScope.launch { try { repository.sync(); repository.status.value="同步检查完成" } catch(e:Exception) { fatal=e.message } } }) { Text("同步") }
                            }
                            if(status.isNotBlank()) Text(status,Modifier.fillMaxWidth().padding(horizontal=20.dp,vertical=4.dp),style=MaterialTheme.typography.bodySmall)
                            if(model.routeLoading)LinearProgressIndicator(Modifier.fillMaxWidth())
                            if(projectId!=null) ProjectNavigation()
                            if(section=="profile") AccountNavigation(user!!)
                            Box(Modifier.weight(1f).fillMaxWidth()) { key(repository.accountId,repository.epoch,section,projectId,model.destination) {
                                when(section) {
                                    "appearance" -> Column(Modifier.padding(20.dp)) { Text("外观",style=MaterialTheme.typography.headlineMedium); listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach { (key,title)->TextButton(onClick={lifecycleScope.launch {appearance.setMode(key)}}) {Text((if(theme==key) "✓ " else "")+title)} } }
                                    "offline" -> OfflineView(repository)
                                    "media" -> MediaWorkspace(repository,projectId){model.workspaceActive=it}
                                    "export" -> projectId?.let {ExportWorkspace(repository,it)}
                                    "create-project" -> ProjectCreationScreen(repository) {id->openProject(id)}
                                    "ai-chat" -> projectId?.let {AiConversationScreen(repository,it){path->openPath(path)}}
                                    else -> FeatureScreen(repository,section,projectId,{id->openProject(id)},{next->navigate(next)},model.destination,{path->openPath(path)},{model.workspaceActive=it})
                                }
                            } }
                            if(!tablet) NavigationBar { listOf("projects" to "项目","notifications" to "通知","profile" to "我的").forEach { (key,title)->NavigationBarItem(selected=section==key,onClick={openGlobal(key)},icon={Text(title.take(1))},label={Text(title)}) } }
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
            Button(onClick={ lifecycleScope.launch { busy=true; try { val url=auth.begin(); CustomTabsIntent.Builder().build().launchUrl(this@MainActivity,url.toUri()) } catch(e:Exception) { fatal=e.message } finally { busy=false } } },modifier=Modifier.fillMaxWidth()) {Text("登录 / 注册")}
            Text("首次使用需要网络；登录服务需部署配套原生授权接口。",Modifier.padding(top=16.dp),style=MaterialTheme.typography.bodySmall)
        }
    }
    @Composable private fun ProjectNavigation() {
        var expanded by remember { mutableStateOf(false) }
        // Always-visible primary entries; secondary tools remain one labelled tap away.
        Row(Modifier.fillMaxWidth().padding(horizontal=12.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
            listOf("overview" to "概览","tasks" to "任务","data" to "资料","assessment" to "评估").forEach { (key,title)->TextButton(onClick={navigate(key)}) {Text(title)} }
            Box { TextButton(onClick={expanded=true}) {Text("更多")}; DropdownMenu(expanded,onDismissRequest={expanded=false}) {
                listOf("team" to "团队","ai-chat" to "项目 AI","material-ai" to "AI 补位","rehearsals" to "排练","media" to "录制与文件","ledger" to "项目记录","export" to "导出","project-settings" to "项目设置","offline" to "本机待同步").forEach { (key,title)->DropdownMenuItem(text={Text(title)},onClick={expanded=false;navigate(key)}) }
            } }
        }
    }
    @Composable private fun AccountNavigation(user:JsonObject) {
        var expanded by remember {mutableStateOf(false)}
        var logout by remember {mutableStateOf(false)}
        Row(Modifier.fillMaxWidth().padding(horizontal=12.dp),horizontalArrangement=Arrangement.SpaceEvenly) {
            TextButton(onClick={navigate("appearance")}){Text("外观")}
            TextButton(onClick={navigate("offline")}){Text("离线")}
            TextButton(onClick={navigate("help")}){Text("帮助")}
            Box { TextButton(onClick={expanded=true}){Text("更多")};DropdownMenu(expanded,onDismissRequest={expanded=false}) {
                DropdownMenuItem(text={Text("查找个人资料")},onClick={expanded=false;navigate("people")})
                DropdownMenuItem(text={Text("Agent Bridge")},onClick={expanded=false;navigate("bridges")})
                if(user["isAdmin"]?.jsonPrimitive?.booleanOrNull==true) {
                    DropdownMenuItem(text={Text("账户管理")},onClick={expanded=false;navigate("accounts")})
                    DropdownMenuItem(text={Text("系统管理")},onClick={expanded=false;navigate("system")})
                    if(user["role"]?.jsonPrimitive?.content=="super_admin")DropdownMenuItem(text={Text("AI 配置")},onClick={expanded=false;navigate("ai-settings")})
                }
                DropdownMenuItem(text={Text("退出登录")},onClick={expanded=false;logout=true})
            } }
        }
        if(logout)AlertDialog(onDismissRequest={logout=false},title={Text("退出当前账户？")},text={Text("本机草稿保留在当前账户空间。未联网时无法撤销服务端会话。")},confirmButton={TextButton(onClick={logout=false;lifecycleScope.launch {try {check(cn.buwei.mobile.RecordingService.instance==null&&!model.workspaceActive){"请先停止录制或等待上传完成"};repository.logout();model.destination=null;model.navigationGeneration++;model.routeLoading=false;projectId=null;section="projects"}catch(e:Exception){if(e is CancellationException)throw e;fatal=e.message}}}){Text("确认退出")}},dismissButton={TextButton(onClick={logout=false}){Text("取消")}})
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

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.NativeAiReferenceBadge
import cn.buwei.nativeapp.ReferenceFieldLabel
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun PeopleWorkspace(repository:ClientRepository,initialUsername:String?=null){
 val account by repository.account.collectAsState();val owner=account?.get("id")?.jsonPrimitive?.contentOrNull;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope()
 var username by rememberSaveable(owner,initialUsername){mutableStateOf(initialUsername.orEmpty())};var matches by remember(owner){mutableStateOf<List<JsonObject>?>(null)};var profile by remember(owner){mutableStateOf<JsonObject?>(null)};var detailName by remember(owner){mutableStateOf<String?>(null)};var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var lookup by remember{mutableStateOf<Job?>(null)};var lookupVersion by remember{mutableIntStateOf(0)}
 fun load(value:String,detail:Boolean){
  lookupVersion++;val requestVersion=lookupVersion;lookup?.cancel();profile=null;matches=null;error=null;detailName=if(detail)value.trim()else null;loading=true
  lookup=scope.launch{try{
   check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
   val path=if(detail)peopleWorkspaceDetailPath(value)else peopleWorkspaceSearchPath(value)
   val result=repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)
   ensureActive();check(requestVersion==lookupVersion){"查找已更新"};check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"}
   if(detail)profile=result["profile"]as? JsonObject else matches=(result["items"]as? JsonArray).orEmpty().take(1).mapNotNull{it as? JsonObject}
  }catch(e:CancellationException){throw e}catch(e:Exception){profile=null;matches=null;error=e.message}finally{if(requestVersion==lookupVersion)loading=false}}
 }
 LaunchedEffect(owner,initialUsername){if(!initialUsername.isNullOrBlank())load(initialUsername,true)}
 DisposableEffect(owner){onDispose{lookup?.cancel()}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
  Text(if(detailName==null)"查找用户"else"公开个人资料",style=MaterialTheme.typography.headlineSmall)
  Text("输入完整登录用户名；只显示允许被搜索的账号及其已公开字段。不能使用昵称或模糊关键词查找。")
  OutlinedTextField(username,{lookupVersion++;lookup?.cancel();loading=false;username=it;matches=null;profile=null;detailName=null;error=null},label={Text("完整用户名")},supportingText={Text("3–32位字母、数字、下划线或连字符")},singleLine=true,modifier=Modifier.fillMaxWidth())
  Button({load(username,false)},enabled=!loading&&username.isNotBlank()){Text(if(loading)"查找中…"else"查找")}
  if(loading)LinearProgressIndicator(Modifier.fillMaxWidth());error?.let{Text(it,color=MaterialTheme.colorScheme.error);TextButton({load(detailName?:username,detailName!=null)}){Text("重新读取服务端资料")}}
  matches?.let{results->if(results.isEmpty())Text("未找到可查看的账号")else results.forEach{person->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(14.dp)){Text(person["displayName"]?.jsonPrimitive?.contentOrNull.orEmpty(),style=MaterialTheme.typography.titleMedium);Text("@${person["username"]?.jsonPrimitive?.contentOrNull.orEmpty()}");TextButton({load(person["username"]!!.jsonPrimitive.content,true)},enabled=!loading){Text("查看公开资料")}}}}
  }
  if(detailName!=null&&!loading&&error==null){
   if(profile==null)Text("未找到可查看的账号")else profile?.let{person->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
    Text(person["displayName"]?.jsonPrimitive?.contentOrNull.orEmpty(),style=MaterialTheme.typography.titleLarge);Text("@${person["username"]?.jsonPrimitive?.contentOrNull.orEmpty()}")
    peopleWorkspacePublicFields(person).forEach{(key,label,value)->Text(label,style=MaterialTheme.typography.titleMedium);if(person.flag("aiUseAllowed"))NativeAiReferenceBadge();if(key=="bio"&&value.isNotBlank())HelpWorkspaceMarkdown(value,hideImages=true)else Text(value.ifBlank{"暂未填写"})}
   }}}
   TextButton({load(detailName!!,true)},enabled=!loading){Text("刷新公开资料")}
  }
 }
}

package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import cn.buwei.nativeapp.NativeAiReferenceBadge
import cn.buwei.nativeapp.ReferenceFieldLabel
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable internal fun AccountWorkspacePersonalProfile(repository:ClientRepository){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope();val recovery=remember(repository){NativeDraftStore(repository)}
 var profile by remember(owner){mutableStateOf<JsonObject?>(null)};var saved by remember(owner){mutableStateOf<JsonObject?>(null)};var imports by remember(owner){mutableStateOf(JsonArray(emptyList()))};var recovered by remember(owner){mutableStateOf(false)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var notice by remember{mutableStateOf("")};var confirmation by remember{mutableStateOf<String?>(null)};var candidates by remember{mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember{mutableStateOf<String?>(null)};var selections by remember{mutableStateOf<Map<String,Set<String>>>(emptyMap())};var username by remember{mutableStateOf("")};var publicProfile by remember{mutableStateOf<JsonObject?>(null)}
 fun action(block:suspend ()->Unit){if(busy)return;busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}
 suspend fun reload(){saved=accountWorkspaceRequest(repository,"GET","/api/v1/auth/personal-profile",owner=owner,epoch=epoch);profile=saved;imports=JsonArray(emptyList())}
 LaunchedEffect(owner){try{reload();recovery.read("personal-profile")?.let{draft->profile=draft["profile"]as? JsonObject?:profile;imports=draft["imports"]as? JsonArray?:imports};recovered=true}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;recovered=true}}
 LaunchedEffect(recovered,profile,imports){if(recovered&&profile!=null&&owner!=null)recovery.scheduleSave("personal-profile",buildJsonObject{put("profile",profile!!);put("imports",imports)},owner,epoch){error=it.message}}
 suspend fun loadCandidates(more:Boolean){val next=if(more)cursor else null;val page=accountWorkspaceRequest(repository,"GET","/api/v1/auth/personal-profile/import-candidates?limit=50"+(next?.let{"&cursor="+Uri.encode(it)}?:""),owner=owner,epoch=epoch);val following=page.text("nextCursor").takeIf{it.isNotBlank()};check(following==null||following!=next){"分页未前进，请重新读取"};candidates=(if(more)candidates else emptyList())+(page["items"]as? JsonArray).orEmpty().map{it.jsonObject};cursor=following}
 Text("全局个人资料与隐私",style=MaterialTheme.typography.titleLarge);Text("资料仅按你选择的公开范围展示；AI 使用与公开展示分别授权。")
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(notice.isNotBlank())Text(notice)
 profile?.let{value->
  fun update(key:String,next:JsonElement)=run{profile=JsonObject(value+(key to next))}
  listOf("bio" to "自我介绍（Markdown）","major" to "专业","specialties" to "技能与特长","preferredRoles" to "倾向项目职位").forEach{(key,label)->OutlinedTextField(value.text(key),{update(key,JsonPrimitive(it))},label={ReferenceFieldLabel(label,value.flag("aiUseAllowed"))},modifier=Modifier.fillMaxWidth());Row{Checkbox(value.obj("visibility")[key]?.jsonPrimitive?.booleanOrNull==true,{enabled->update("visibility",JsonObject(value.obj("visibility")+(key to JsonPrimitive(enabled))))});Text("公开$label")}}
  OutlinedTextField(value.text("weeklyAvailableHours"),{text->if(text.isBlank())update("weeklyAvailableHours",JsonNull)else text.toDoubleOrNull()?.takeIf{it in 0.0..168.0}?.let{update("weeklyAvailableHours",JsonPrimitive(it))}},label={ReferenceFieldLabel("每周可投入小时（0–168，可留空）",value.flag("aiUseAllowed"))},modifier=Modifier.fillMaxWidth())
  Row{Checkbox(value["searchable"]?.jsonPrimitive?.booleanOrNull==true,{update("searchable",JsonPrimitive(it))});Text("允许按完整用户名找到我")};Row{Checkbox(value["aiUseAllowed"]?.jsonPrimitive?.booleanOrNull==true,{update("aiUseAllowed",JsonPrimitive(it))});Text("允许项目 AI 使用个人资料")}
  Text("服务端资料版本：${value.text("revision")}");Button({confirmation="save"},enabled=!busy){Text("保存资料与隐私设置")};TextButton({confirmation="reload"},enabled=!busy){Text("读取服务端资料并放弃本机编辑")}
  OutlinedButton({action{loadCandidates(false)}},enabled=!busy){Text("读取旧项目资料导入候选")}
  candidates.forEach{candidate->val id=candidate.text("candidateId");Card{Column(Modifier.padding(10.dp)){
   Text(candidate.text("sourceProjectName"));Text("专业：${candidate.text("major")}");Text("技能：${(candidate["skills"]as? JsonArray).orEmpty().joinToString("、"){it.jsonPrimitive.content}}");Text("每周时长：${candidate.text("weeklyAvailableHours")}")
   listOf("major" to "专业","specialties" to "技能","weeklyAvailableHours" to "每周时长").forEach{(key,label)->Row{Checkbox(key in selections[id].orEmpty(),{checked->selections=selections+(id to if(checked)selections[id].orEmpty()+key else selections[id].orEmpty()-key)});Text("导入$label")}}
   OutlinedButton({confirmation="import:$id"},enabled=!busy&&selections[id].orEmpty().isNotEmpty()){Text("复制所选字段到草稿")}
  }}}
  if(cursor!=null)TextButton({action{loadCandidates(true)}},enabled=!busy){Text("更多旧资料候选")}
 }
 Text("查找公开个人资料",style=MaterialTheme.typography.titleMedium);OutlinedTextField(username,{username=it},label={Text("完整用户名")},modifier=Modifier.fillMaxWidth());Button({action{require(Regex("[A-Za-z0-9_-]{3,32}").matches(username.trim())){"请填写完整用户名"};val result=accountWorkspaceRequest(repository,"GET","/api/v1/profiles/search?username="+Uri.encode(username.trim()),owner=owner,epoch=epoch);val found=(result["items"]as? JsonArray).orEmpty().firstOrNull()?.jsonObject;if(found==null){publicProfile=null;notice="未找到可公开显示的个人资料"}else publicProfile=accountWorkspaceRequest(repository,"GET","/api/v1/profiles/"+Uri.encode(found.text("username")),owner=owner,epoch=epoch)["profile"]as? JsonObject}},enabled=!busy&&username.isNotBlank()){Text("精确查找")}
 publicProfile?.let{person->Card{Column(Modifier.padding(12.dp)){Text(person.text("displayName"));listOf("bio" to "自我介绍","major" to "专业","specialties" to "技能","preferredRoles" to "倾向职位").forEach{(key,label)->if(person.containsKey(key)){Text("$label：${person.text(key)}");if(person.flag("aiUseAllowed"))NativeAiReferenceBadge()}}}}}
 confirmation?.let{chosen->AlertDialog(onDismissRequest={confirmation=null},title={Text(if(chosen.startsWith("import:"))"复制所选旧资料？"else if(chosen=="reload")"放弃本机编辑并重新读取？"else"保存资料及隐私授权？")},text={Text(if(chosen.startsWith("import:"))"所选字段替换当前草稿；导入的专业和技能暂不公开，并关闭 AI 授权。保存后才生效。"else if(chosen=="reload")"将以服务端版本替换本机未保存内容。"else"按当前资料版本保存，保留你选择的公开范围与 AI 使用授权。")},confirmButton={TextButton({confirmation=null;action{when{
  chosen=="save"->{val body=accountPersonalBody(profile!!,imports);val schema=NativeContracts.operations.first{it.method=="PUT"&&it.path=="/api/v1/auth/personal-profile"}.schema;validate(schema,body)?.let{error(it)};profile=accountWorkspaceRequest(repository,"PUT","/api/v1/auth/personal-profile",body,owner,epoch);saved=profile;imports=JsonArray(emptyList());notice="资料与隐私设置已保存"}
  chosen=="reload"->{reload();notice="已读取服务端版本"}
  chosen.startsWith("import:")->{val id=chosen.substringAfter(':');val candidate=candidates.first{it.text("candidateId")==id};val fields=selections[id].orEmpty();profile=accountImportFields(profile!!,candidate,fields);imports=JsonArray(imports.filter{it.jsonObject.text("candidateId")!=id}+buildJsonObject{put("candidateId",id);put("fields",JsonArray(fields.map(::JsonPrimitive)))});notice="已复制到草稿；导入的专业与技能未公开，AI授权已关闭。"}
 }}}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})}
}

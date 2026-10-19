package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.BuildConfig
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun AccountWorkspace(repository:ClientRepository){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope()
 var name by remember(owner){mutableStateOf(repository.account.value?.text("displayName").orEmpty())};var currentPassword by remember(owner){mutableStateOf("")};var newPassword by remember(owner){mutableStateOf("")};var repeatPassword by remember(owner){mutableStateOf("")};var email by remember(owner){mutableStateOf("")};var emailPassword by remember(owner){mutableStateOf("")};var token by remember(owner){mutableStateOf("")};var emailStatus by remember(owner){mutableStateOf<JsonObject?>(null)};var capabilities by remember{mutableStateOf<JsonObject?>(null)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var notice by remember{mutableStateOf("")};var confirm by remember{mutableStateOf<String?>(null)}
 fun action(block:suspend ()->Unit){if(busy)return;busy=true;error=null;notice="";scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}
 suspend fun reloadEmail(){emailStatus=accountWorkspaceRequest(repository,"GET","/api/v1/auth/recovery-email",owner=owner,epoch=epoch)}
 LaunchedEffect(owner){try{reloadEmail();capabilities=repository.networkJson("GET","/api/v1/capabilities",expectedOwner=owner,expectedEpoch=epoch)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 fun browser(path:String){CustomTabsIntent.Builder().build().apply{intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)}.launchUrl(repository.context,Uri.parse(BuildConfig.SERVICE_ORIGIN+path))}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("账户与个人资料",style=MaterialTheme.typography.headlineSmall);Text("登录账号：${repository.account.value?.text("username").orEmpty()}")
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(notice.isNotBlank())Text(notice);if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  OutlinedTextField(name,{name=it},label={Text("昵称（1–64字）")},modifier=Modifier.fillMaxWidth());Button({action{require(name.trim().length in 1..64);accountWorkspaceRequest(repository,"PATCH","/api/v1/auth/profile",buildJsonObject{put("displayName",name.trim())},owner,epoch);repository.validateSession();notice="昵称已保存"}},enabled=!busy&&name.isNotBlank()){Text("保存昵称")}
  AccountWorkspacePersonalProfile(repository)
  Text("修改密码",style=MaterialTheme.typography.titleLarge);Text("新密码需12–128位。成功后全部设备退出，请重新登录；密码不会保存到本机草稿。")
  OutlinedTextField(currentPassword,{currentPassword=it},label={Text("原密码")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),modifier=Modifier.fillMaxWidth())
  OutlinedTextField(newPassword,{newPassword=it},label={Text("新密码")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),modifier=Modifier.fillMaxWidth())
  OutlinedTextField(repeatPassword,{repeatPassword=it},label={Text("确认新密码")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),modifier=Modifier.fillMaxWidth())
  Button({if(newPassword!=repeatPassword)error="两次新密码不一致"else if(newPassword==currentPassword)error="新密码不能与原密码相同"else confirm="password"},enabled=!busy&&currentPassword.isNotBlank()&&newPassword.length in 12..128&&repeatPassword.isNotBlank()){Text("修改密码")}
  Text("恢复邮箱",style=MaterialTheme.typography.titleLarge);emailStatus?.let{Text("当前邮箱：${it.text("email").ifBlank{"未绑定"}} · "+if(it["verified"]?.jsonPrimitive?.booleanOrNull==true)"已验证"else"尚未验证")}
  Text("新邮箱验证前原恢复邮箱保持有效；验证邮件15分钟有效。")
  OutlinedTextField(email,{email=it},label={Text("待验证恢复邮箱")},modifier=Modifier.fillMaxWidth());OutlinedTextField(emailPassword,{emailPassword=it},label={Text("当前密码（核实邮箱操作）")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),modifier=Modifier.fillMaxWidth())
  val challenge=capabilities?.obj("authentication")?.get("turnstileRequired")?.jsonPrimitive?.booleanOrNull==true
  if(challenge){Text("此环境要求网页人机验证，邮箱验证申请在系统浏览器的账户安全页完成。");OutlinedButton({browser("/app/settings/security")},enabled=!busy){Text("打开系统浏览器验证邮箱")}}else Button({confirm="email"},enabled=!busy&&capabilities!=null&&email.contains('@')&&emailPassword.isNotBlank()){Text("发送验证邮件")}
  if(emailStatus?.text("email")?.isNotBlank()==true)TextButton({confirm="remove-email"},enabled=!busy&&emailPassword.isNotBlank()){Text("用当前密码解绑邮箱")}
  OutlinedTextField(token,{token=it},label={Text("邮箱验证代码或完整邮件验证链接")},visualTransformation=PasswordVisualTransformation(),keyboardOptions=KeyboardOptions(keyboardType=KeyboardType.Password),modifier=Modifier.fillMaxWidth());Button({confirm="verify"},enabled=!busy&&token.isNotBlank()){Text("验证恢复邮箱")}
  TextButton({action{reloadEmail();notice="邮箱状态已刷新"}},enabled=!busy){Text("刷新邮箱验证状态")}
  TextButton({browser("/password-forgot")}){Text("忘记密码：在系统浏览器恢复")}
 }
 confirm?.let{chosen->AlertDialog(onDismissRequest={confirm=null},title={Text(if(chosen=="password")"确认修改并退出全部设备？"else if(chosen=="remove-email")"解绑恢复邮箱？"else"确认邮箱操作？")},text={Text(if(chosen=="remove-email")"解绑后之前签发的恢复和验证链接均失效。"else if(chosen=="password")"成功后所有设备的旧会话失效，请使用新密码重新登录。"else"仅执行本次验证申请；结果不明确时先核对邮箱和服务端状态。")},confirmButton={TextButton({confirm=null;action{
  try{when(chosen){
   "password"->{accountWorkspaceRequest(repository,"POST","/api/v1/auth/password",buildJsonObject{put("currentPassword",currentPassword);put("newPassword",newPassword)},owner,epoch);runCatching{repository.get("/api/v1/auth/session")};notice="密码已修改，请重新登录"}
   "email"->{accountWorkspaceRequest(repository,"POST","/api/v1/auth/recovery-email",buildJsonObject{put("email",email.trim());put("currentPassword",emailPassword)},owner,epoch);notice="申请已受理，请检查新邮箱并核对验证链接。";reloadEmail()}
   "remove-email"->{accountWorkspaceRequest(repository,"DELETE","/api/v1/auth/recovery-email",buildJsonObject{put("currentPassword",emailPassword)},owner,epoch);reloadEmail();notice="恢复邮箱已解绑"}
   "verify"->{val code=if(token.trim().startsWith("https://"))Uri.parse(token.trim()).fragment.orEmpty().removePrefix("token=")else token.trim();accountWorkspaceRequest(repository,"POST","/api/v1/auth/recovery-email/verify",buildJsonObject{put("token",code)},owner,epoch);reloadEmail();notice="恢复邮箱已验证"}
  }}finally{currentPassword="";newPassword="";repeatPassword="";emailPassword="";token=""}
 }}){Text("确认")}},dismissButton={TextButton({confirm=null}){Text("返回")}})}
}

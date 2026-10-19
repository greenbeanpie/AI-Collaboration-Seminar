package cn.buwei.nativeapp.features

import androidx.compose.material3.*
import androidx.compose.runtime.*
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

/** Uses the existing owner-authorized jobs contract for draft media; user-triggered writes only. */
@Composable internal fun CreationMediaStatus(repository:ClientRepository,jobId:String){
 var job by remember(jobId){mutableStateOf<JsonObject?>(null)};var error by remember(jobId){mutableStateOf<String?>(null)};var chosen by remember{mutableStateOf<String?>(null)};var busy by remember{mutableStateOf(false)}
 val scope=rememberCoroutineScope()
 suspend fun reload(){job=repository.get("/api/v1/jobs/$jobId")}
 LaunchedEffect(jobId){while(isActive){try{reload();if(job?.text("status")in listOf("succeeded","failed","cancelled","waiting_input"))break}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message;break};delay(3000)}}
 job?.let{current->Text("处理状态：${current.text("status")}");activityProgress(current.obj("activity"))?.let{Text(it)};val execution=current["execution"]as? JsonObject
  (current["error"]as? JsonObject)?.let{Text(it.text("message"),color=MaterialTheme.colorScheme.error)}
  if(execution!=null){if(execution["canContinue"]?.jsonPrimitive?.booleanOrNull==true){TextButton({chosen="continue"},enabled=!busy){Text("继续处理")};TextButton({chosen="output"},enabled=!busy){Text("输出已有处理结果")}};if(execution.text("state")in listOf("running","finalizing","paused"))TextButton({chosen="cancel"},enabled=!busy){Text("取消此附件处理")}}
  if(current.text("status")=="failed")TextButton({chosen="retry"},enabled=!busy){Text("重试失败处理")}
 }
 error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
 TextButton({scope.launch{try{reload();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}},enabled=!busy){Text("刷新处理状态")}
 chosen?.let{action->val uncertain=job?.obj("execution")?.text("pauseReason")=="request_uncertain"
  AlertDialog(onDismissRequest={chosen=null},title={Text(if(action=="cancel")"取消附件处理？"else"确认继续 AI 处理？")},text={Text(if(action=="cancel")"保留已上传原件，停止当前执行。"else if(uncertain)"上次供应商请求结果未知。请先核对供应商记录；确认后仍会再次调用，可能重复计费。"else"该操作使用现有后端配置，可能产生模型费用；客户端不会自动重试。")},confirmButton={TextButton({chosen=null;busy=true;scope.launch{try{if(action=="retry")repository.requestDurably("creation-media","POST","/api/v1/jobs/$jobId/retry")else repository.requestDurably("creation-media","POST","/api/v1/jobs/$jobId/execution/$action",buildJsonObject{put("expectedGeneration",job!!.obj("execution")["generation"]!!);if(uncertain)put("allowUncertainDispatch",true)});reload();error=null}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}){Text("确认")}},dismissButton={TextButton({chosen=null}){Text("返回")}})
 }
}

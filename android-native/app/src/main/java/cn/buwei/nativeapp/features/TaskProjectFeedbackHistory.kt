package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.NativeAiReferenceBadge
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

@Composable internal fun TaskProjectFeedbackHistory(repository:ClientRepository,base:String,refresh:Int,members:List<JsonObject>) {
    val owner=repository.accountId;val epoch=repository.epoch
    var open by remember(base,owner,epoch){mutableStateOf(false)};var rows by remember(base,owner,epoch){mutableStateOf<List<JsonObject>>(emptyList())}
    var loading by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var reload by remember{mutableIntStateOf(0)}
    LaunchedEffect(open,refresh,reload,base,owner,epoch){if(open){loading=true;try{
        val result=repository.networkJson("GET","$base/collaboration/feedback/history",expectedOwner=owner,expectedEpoch=epoch)
        check(result["items"] is JsonArray){"反馈历史响应无效，请重试读取"};rows=result.twRows();error=null
    }catch(e:CancellationException){throw e}catch(e:Exception){rows=emptyList();error=e.message}finally{loading=false}}}
    OutlinedButton({open=!open}){Text("持续反馈版本历史")}
    if(open){
        TextButton({reload++},enabled=!loading){Text("刷新反馈历史")};if(loading)LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        if(!loading&&error==null&&rows.isEmpty())Text("尚无已保存的持续反馈版本")
        rows.forEach{row->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){
            Text("反馈版本 ${row.twText("version")} · ${row.twText("createdAt")}",style=MaterialTheme.typography.titleSmall)
            NativeAiReferenceBadge()
            members.firstOrNull{it.twText("userId")==row.twText("actorId")}?.let{Text("修改者：${it.twText("displayName")}",style=MaterialTheme.typography.bodySmall)}
            SelectionContainer{Text(row.twText("feedback").ifBlank{"已清空持续反馈"})}
        }}}
    }
}

/** Only server-provided frozen evidence is shown; current feedback is never substituted. */
internal fun nativeFrozenFeedback(job:JsonObject):JsonObject? {
    val snapshot=job["feedbackSnapshot"] as? JsonObject?:return null
    return snapshot.takeIf{(it["version"] as? JsonPrimitive)?.intOrNull?.let{version->version>=0}==true&&(it["feedback"] as? JsonPrimitive)?.isString==true}
}

@Composable internal fun NativeJobFeedbackSnapshot(job:JsonObject) {
    val snapshot=nativeFrozenFeedback(job)?:return
    var expanded by remember(job.twText("jobId"),snapshot){mutableStateOf(false)}
    TextButton({expanded=!expanded}){Text("本次采用的持续反馈 · v${snapshot.twText("version")}")}
    if(expanded){
        NativeAiReferenceBadge()
        snapshot.twText("createdAt").takeIf(String::isNotBlank)?.let{Text("保存时间：$it",style=MaterialTheme.typography.bodySmall)}
        SelectionContainer{Text(snapshot.twText("feedback").ifBlank{if(snapshot.twText("version")=="0")"本次作业未设置持续反馈"else"本次采用已清空的持续反馈"})}
        Text("此内容由后台作业固定；后续反馈修改不会替换本轮依据。",style=MaterialTheme.typography.bodySmall)
    }
}

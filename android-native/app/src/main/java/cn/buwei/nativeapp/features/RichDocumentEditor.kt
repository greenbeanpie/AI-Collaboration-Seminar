package cn.buwei.nativeapp.features

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import cn.buwei.nativeapp.NativeAiReferenceBadge
import cn.buwei.nativeapp.ReferenceFieldLabel
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal data class RichSelection(val path:List<Int>,val range:TextRange)

@Composable internal fun NativeRichMaterialEditor(repository:ClientRepository,path:String,material:JsonObject) {
    val owner=repository.accountId?:return;val epoch=repository.epoch
    val store=remember(repository){NativeDraftStore(repository)};val draftKey="material:$path";val scope=rememberCoroutineScope()
    val original=material.obj("currentVersion").obj("doc").takeIf{it.text("type")=="doc"}?:richNode("doc")
    var serialized by rememberSaveable(owner,epoch,path){mutableStateOf(original.toString())}
    val document=remember(serialized){Json.parseToJsonElement(serialized).jsonObject}
    var revision by rememberSaveable(owner,epoch,path){mutableIntStateOf(material["revision"]?.jsonPrimitive?.intOrNull?:1)}
    var editing by rememberSaveable(owner,epoch,path){mutableStateOf(false)}
    var recovery by remember(owner,epoch,path){mutableStateOf<JsonObject?>(null)}
    var conflict by remember(owner,epoch,path){mutableStateOf<JsonObject?>(null)}
    var conflictOperationId by rememberSaveable(owner,epoch,path){mutableStateOf<String?>(null)}
    var busy by remember(owner,epoch,path){mutableStateOf(false)}
    var message by remember(owner,epoch,path){mutableStateOf<String?>(null)}
    var error by remember(owner,epoch,path){mutableStateOf<String?>(null)}
    var queued by remember(owner,epoch,path){mutableStateOf(false)}
    var history by remember(owner,epoch,path){mutableStateOf<List<JsonObject>>(emptyList())}
    var future by remember(owner,epoch,path){mutableStateOf<List<JsonObject>>(emptyList())}
    var selection by remember(owner,epoch,path){mutableStateOf<RichSelection?>(null)}
    var linkDialog by remember{mutableStateOf(false)};var link by remember{mutableStateOf("")};var discard by remember{mutableStateOf(false)}
    fun envelope(value:JsonObject=document)=buildJsonObject {put("doc",value);put("revision",revision);put("updatedAt",System.currentTimeMillis());put("queued",queued);put("conflictOperationId",conflictOperationId?.let(::JsonPrimitive)?:JsonNull)}
    fun persist(value:JsonObject) {store.scheduleSave(draftKey,envelope(value),owner,epoch){failure->error="本机草稿保存失败，请保留此页面并尽快保存：${failure.message.orEmpty()}"}}
    fun change(value:JsonObject) {if(busy||queued)return;history=(history+document).takeLast(20);future=emptyList();serialized=value.toString();persist(value);message=null}
    suspend fun leave() {store.save(draftKey,envelope(),owner,epoch);editing=false;message="编辑已保存在当前账户的本机草稿中"}
    LaunchedEffect(owner,epoch,path) {try{recovery=store.read(draftKey,owner,epoch)}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
    BackHandler(editing) {scope.launch {try{leave()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}
    recovery?.let {saved->Card(Modifier.fillMaxWidth()) {Column(Modifier.padding(12.dp)) {
        Text("找到本机材料草稿",style=MaterialTheme.typography.titleMedium)
        Text("基于版本 ${saved.text("revision")}；当前材料版本 ${material.text("revision")}")
        Row {
            TextButton(onClick={serialized=saved.obj("doc").toString();revision=saved["revision"]?.jsonPrimitive?.intOrNull?:revision;queued=saved.flag("queued");conflictOperationId=saved.text("conflictOperationId").takeIf{it.isNotBlank()};recovery=null;editing=true;message=if(queued)"此草稿已排队等待同步，请同步并核对后继续编辑"else"已恢复本机编辑，保存仍按原版本核对"}){Text("恢复本机编辑")}
            TextButton(onClick={discard=true}){Text("删除本机草稿")}
        }
    }}}
    if(discard)AlertDialog(onDismissRequest={discard=false},title={Text("删除本机草稿？")},text={Text("仅删除此账户的本机编辑；已保存的服务端版本不受影响。")},confirmButton={TextButton(onClick={discard=false;scope.launch{try{store.remove(draftKey,owner,epoch);recovery=null;serialized=original.toString();revision=material["revision"]?.jsonPrimitive?.intOrNull?:1;queued=false;editing=false}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}}){Text("删除本机草稿")}},dismissButton={TextButton(onClick={discard=false}){Text("保留")}})
    if(!editing) {OutlinedButton(onClick={editing=true},enabled=recovery==null&&!queued){Text("编辑正文")};message?.let{Text(it)};error?.let{Text(it,color=MaterialTheme.colorScheme.error)};return}
    Text("编辑版本 $revision",style=MaterialTheme.typography.bodySmall);NativeAiReferenceBadge()
    Text("选中文字可设置格式；内容块可调整顺序。引用、附件和历史版本继续保留。",style=MaterialTheme.typography.bodySmall)
    FlowRow(horizontalArrangement=Arrangement.spacedBy(6.dp)) {
        OutlinedButton(onClick={val previous=history.last();future=(future+document).takeLast(20);history=history.dropLast(1);serialized=previous.toString();persist(previous);selection=null},enabled=history.isNotEmpty()&&!busy&&!queued){Text("撤销")}
        OutlinedButton(onClick={val next=future.last();history=(history+document).takeLast(20);future=future.dropLast(1);serialized=next.toString();persist(next);selection=null},enabled=future.isNotEmpty()&&!busy&&!queued){Text("重做")}
        listOf("bold" to "粗体","italic" to "斜体","strike" to "删除线","code" to "行内代码").forEach {(kind,title)->TextButton(onClick={selection?.let{selected->change(richFormatSelection(document,selected.path,selected.range.min,selected.range.max,kind));selection=null}},enabled=selection?.range?.collapsed==false&&!busy&&!queued){Text(title)}}
        TextButton(onClick={link="";linkDialog=true},enabled=selection?.range?.collapsed==false&&!busy&&!queued){Text("链接")}
    }
    RichBlockEditor(document,emptyList(),!busy&&!queued,{change(it)},{selection=it})
    message?.let{Text(it)};error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
    conflict?.let {latest->Card(Modifier.fillMaxWidth()) {Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text("服务端版本已变化",style=MaterialTheme.typography.titleMedium)
        Text("本机编辑仍基于版本 $revision；最新版本 ${latest.text("revision")}。请对照最新正文后决定是否以本机编辑保存新版本。")
        NativeMarkdown(latest.obj("currentVersion").text("markdown"))
        TextButton(onClick={if(!busy){busy=true;scope.launch{try{
            // Keep an atomic draft before removing only this reviewed, failed material intent.
            store.save(draftKey,envelope(),owner,epoch)
            conflictOperationId?.let{repository.acknowledgeMaterialConflict(it,path,owner,epoch)}
            revision=latest["revision"]!!.jsonPrimitive.int;conflict=null;conflictOperationId=null;queued=false
            store.save(draftKey,envelope(),owner,epoch);message="已按你确认的最新版本继续，尚未提交"
        }catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}}},enabled=!busy){Text("已核对，保留本机编辑继续")}
    }}}
    if(queued)OutlinedButton(onClick={scope.launch{busy=true;try{repository.sync();if(repository.pending().any{it.path==repository.resolvePath(path)})message="此材料仍有待同步或冲突记录，请打开本机待同步核对"else {conflict=repository.get(path);queued=false;message="同步已完成，请核对服务端最新正文"}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}finally{busy=false}}},enabled=!busy){Text("同步并核对")}
    FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
        Button(onClick={busy=true;error=null;scope.launch{try {
            require(serialized.toByteArray().size<=200*1024){"正文超过 200 KiB 保存上限，请拆分材料；本机草稿继续保留"}
            store.save(draftKey,envelope(),owner,epoch)
            val response=repository.requestDurably("material:$path","PUT",path,buildJsonObject {
                put("expectedRevision",revision);put("doc",document)
                put("attachmentIds",JsonArray((material.obj("currentVersion")["attachments"]as? JsonArray).orEmpty().mapNotNull{it.jsonObject["fileId"]}))
            })
            if(response.flag("queued")){queued=true;store.save(draftKey,envelope(),owner,epoch);message="已保存到本机，等待联网同步；服务端版本尚未更新"}
            else {revision=response["revision"]?.jsonPrimitive?.intOrNull?:revision;store.remove(draftKey,owner,epoch);editing=false;message="已保存新版本";history=emptyList();future=emptyList()}
        }catch(e:CancellationException){throw e}catch(e:Exception){
            error=(e.message?:"保存失败")+"；本机编辑已保留"
            if(e is ApiException&&e.status==409)try{
                conflictOperationId=repository.pending().filter{it.path==repository.resolvePath(path)&&it.method=="PUT"&&it.state=="conflict"}.firstOrNull{row->
                    val body=repository.json.parseToJsonElement(row.body).jsonObject
                    body["expectedRevision"]?.jsonPrimitive?.intOrNull==revision&&body["doc"]==document
                }?.id
                store.save(draftKey,envelope(),owner,epoch);conflict=repository.networkJson("GET",path,expectedOwner=owner,expectedEpoch=epoch)
            }catch(read:CancellationException){throw read}catch(_:Exception){message="无法读取最新版本，请联网后刷新核对"}
        }finally{busy=false}}},enabled=!busy&&!queued&&conflict==null){Text("保存新版本")}
        TextButton(onClick={scope.launch{try{leave()}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}},enabled=!busy){Text("暂存编辑并返回")}
    }
    if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
    if(linkDialog)AlertDialog(onDismissRequest={linkDialog=false},title={Text("设置链接")},text={Column {OutlinedTextField(link,{link=it},label={Text("https:// 或项目内路径")});Text("留空可移除所选文字的链接")}},confirmButton={TextButton(onClick={
        val valid=link.isBlank()||link.startsWith("https://")||link.startsWith("http://")||(link.startsWith('/')&&!link.startsWith("//"))
        if(!valid){error="链接仅支持 http、https 或项目内路径";return@TextButton}
        selection?.let{selected->change(richFormatSelection(document,selected.path,selected.range.min,selected.range.max,"link",if(link.isBlank())null else buildJsonObject{put("href",link);put("target","_blank");put("rel","noopener noreferrer nofollow")},remove=link.isBlank()))};selection=null;linkDialog=false
    }){Text("应用链接")}},dismissButton={TextButton(onClick={linkDialog=false}){Text("取消")}})
}

internal fun editRichText(node:JsonObject,indices:List<Int>,text:String):JsonObject {
    if(indices.isEmpty()){require(node.text("type")=="text"){"Only text nodes can be changed"};return JsonObject(node+("text" to JsonPrimitive(text)))}
    return richChangeAt(node,indices){editRichText(it,emptyList(),text)}
}

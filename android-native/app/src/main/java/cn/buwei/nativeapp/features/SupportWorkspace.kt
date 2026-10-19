package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ApiException
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.NativeDraftStore
import kotlinx.coroutines.*
import kotlinx.serialization.json.*

@Composable fun SupportWorkspace(repository:ClientRepository,initialTicketId:String?=null){
 val owner=repository.accountId;val epoch=remember(owner){repository.epoch};val scope=rememberCoroutineScope();val recovery=remember(repository){NativeDraftStore(repository)}
 var title by remember(owner){mutableStateOf("")};var body by remember(owner){mutableStateOf("")};var urgency by remember(owner){mutableStateOf("normal")};var category by remember(owner){mutableStateOf("other")};var images by remember(owner){mutableStateOf(JsonArray(emptyList()))};var savedTicket by remember(owner){mutableStateOf("")};var uncertain by remember(owner){mutableStateOf(false)};var loaded by remember(owner){mutableStateOf(false)}
 var tickets by remember(owner){mutableStateOf<List<JsonObject>>(emptyList())};var cursor by remember(owner){mutableStateOf<String?>(null)};var filter by remember(owner){mutableStateOf("")};var active by remember(owner,epoch,initialTicketId){mutableStateOf(initialTicketId)};var busy by remember{mutableStateOf(false)};var error by remember{mutableStateOf<String?>(null)};var confirmation by remember{mutableStateOf<String?>(null)}
 fun recoveryValue()=buildJsonObject{put("title",title);put("body",body);put("urgency",urgency);put("category",category);put("images",images);put("savedTicket",savedTicket);put("uncertain",uncertain)}
 suspend fun persist(){recovery.save("support-create",recoveryValue(),owner?:error("请登录"),epoch)}
 suspend fun loadTickets(more:Boolean){val previous=if(more)cursor else null;val page=repository.networkJson("GET","/api/v1/support/tickets?limit=20"+(if(filter.isBlank())""else"&status=$filter")+(previous?.let{"&cursor="+Uri.encode(it)}?:""),expectedOwner=owner,expectedEpoch=epoch);val next=page.text("nextCursor").takeIf{it.isNotBlank()};check(next==null||next!=previous){"分页未前进，请重新读取"};tickets=notificationWorkspaceMerge(if(more)tickets else emptyList(),(page["items"]as? JsonArray).orEmpty().map{it.jsonObject});cursor=next}
 fun action(block:suspend ()->Unit){if(busy)return;busy=true;error=null;scope.launch{try{check(repository.accountId==owner&&repository.epoch==epoch){"账户已变化"};block()}catch(e:CancellationException){throw e}catch(e:Exception){if(e is ApiException&&e.status in listOf(401,403,404)){tickets=emptyList();cursor=null};error=e.message}finally{busy=false}}}
 LaunchedEffect(owner){try{recovery.read("support-create")?.let{saved->title=saved.text("title");body=saved.text("body");urgency=saved.text("urgency").ifBlank{"normal"};category=saved.text("category").ifBlank{"other"};images=saved["images"]as? JsonArray?:images;savedTicket=saved.text("savedTicket");uncertain=saved["uncertain"]?.jsonPrimitive?.booleanOrNull==true};loaded=true;loadTickets(false)}catch(e:CancellationException){throw e}catch(e:Exception){loaded=true;error=e.message}}
 LaunchedEffect(owner,loaded,title,body,urgency,category,images,savedTicket,uncertain){if(loaded&&owner!=null)recovery.scheduleSave("support-create",recoveryValue(),owner,epoch){error=it.message}}
 val picker=rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){uris->if(uris.isNotEmpty())action{require(images.size+uris.size<=4){"每份工单最多4张图片"};for(uri in uris){images=JsonArray(images+supportStageImage(repository,uri,owner?:error("请登录"),epoch));persist()}}}
 Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
  Text("站内支持",style=MaterialTheme.typography.headlineSmall);Text("提交问题或求助，与管理员沟通。请勿在工单或截图中提供密码、验证码和密钥。")
  error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
  if(active!=null){TextButton({active=null;action{loadTickets(false)}}){Text("返回工单列表")};SupportWorkspaceConversation(repository,active!!);return@Column}
  Text("提交工单",style=MaterialTheme.typography.titleLarge)
  OutlinedTextField(title,{title=it},label={Text("问题标题（最多160字）")},modifier=Modifier.fillMaxWidth(),enabled=!busy&&savedTicket.isBlank());OutlinedTextField(body,{body=it},label={Text("问题描述（最多8000字）")},modifier=Modifier.fillMaxWidth(),enabled=!busy&&savedTicket.isBlank())
  if(savedTicket.isBlank()){CreationChoice("紧急度",urgency,supportUrgencies){urgency=it};CreationChoice("问题分类",category,supportCategories){category=it}}
  Text("最多4张 PNG、JPEG 或静态 WebP，每张≤5 MiB。原图在本机私有目录保留，失败图片可以重试。")
  OutlinedButton({picker.launch(arrayOf("image/png","image/jpeg","image/webp"))},enabled=!busy&&images.size<4){Text("选择问题图片")}
  images.forEachIndexed{index,element->val image=element.jsonObject;Text("图片 ${index+1} · "+when(image.text("state")){"uploaded"->"已上传";else->"待上传或失败，可重试"});TextButton({images=JsonArray(images.filterIndexed{i,_->i!=index})},enabled=!busy&&image.text("state")!="uploaded"){Text("从待上传列表移除此图")}}
  if(savedTicket.isNotBlank()){Text("工单文字已保存，继续按钮仅上传尚未成功的图片。");TextButton({active=savedTicket}){Text("查看已保存工单")}}
  if(uncertain){Text("上次文字创建结果未知。请先刷新并查看工单列表，避免重复提交。",color=MaterialTheme.colorScheme.error);TextButton({confirmation="unlock"},enabled=!busy){Text("已核对工单列表，允许再次提交")}}
  Button({confirmation="create"},enabled=!busy&&!uncertain&&(savedTicket.isNotBlank()||(title.isNotBlank()&&body.isNotBlank()))){Text(if(savedTicket.isBlank())"提交工单"else"继续上传未成功图片")}
  if(savedTicket.isNotBlank())TextButton({confirmation="new"},enabled=!busy){Text("新建另一份工单")}
  Text("工单列表",style=MaterialTheme.typography.titleLarge)
  CreationChoice("筛选状态",filter,listOf("" to "全部")+supportStatuses){filter=it;action{loadTickets(false)}}
  TextButton({action{loadTickets(false)}},enabled=!busy){Text("刷新工单列表")}
  tickets.forEach{ticket->Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){Text(ticket.text("title"),style=MaterialTheme.typography.titleMedium);Text(supportStatuses.firstOrNull{it.first==ticket.text("status")}?.second.orEmpty()+" · "+ticket.text("ownerName"));Text(ticket.text("updatedAt"));OutlinedButton({active=ticket.text("id")},enabled=!busy){Text("查看工单对话")}}}}
  if(cursor!=null)OutlinedButton({action{loadTickets(true)}},enabled=!busy){Text("加载更多工单")}
 }
 confirmation?.let{chosen->AlertDialog(onDismissRequest={confirmation=null},title={Text(when(chosen){"unlock"->"确认已核对没有重复工单？";"new"->"新建另一份工单？";else->"提交文字及所选图片？"})},text={Text(when(chosen){"unlock"->"当前后端不支持工单文字幂等去重。确认再次提交可能产生重复工单，请先核对列表和详情。";"new"->"保留已提交工单及图片，清空当前新建输入。";else->"文字保存成功后再逐张上传图片；图片失败保留固定标识，不重新创建工单。"})},confirmButton={TextButton({confirmation=null;action{when(chosen){
  "unlock"->{uncertain=false;persist()}
  "new"->{title="";body="";urgency="normal";category="other";images=JsonArray(emptyList());savedTicket="";uncertain=false;persist()}
  else->{if(savedTicket.isBlank()){val payload=supportCreateBody(title,body,urgency,category);uncertain=true;persist();try{savedTicket=repository.networkJson("POST","/api/v1/support/tickets",payload,expectedOwner=owner,expectedEpoch=epoch).obj("ticket").text("id");check(savedTicket.isNotBlank());uncertain=false;persist()}catch(e:ApiException){if(e.status in 400..499){uncertain=false;persist()};throw e}}
   for(index in images.indices){val image=images[index].jsonObject;if(image.text("state")!="uploaded"){supportUploadImage(repository,savedTicket,image,owner?:error("请登录"),epoch);images=JsonArray(images.toMutableList().apply{set(index,JsonObject(image+("state" to JsonPrimitive("uploaded"))))});persist()}}
   loadTickets(false);active=savedTicket
  }
 }}}){Text("确认")}},dismissButton={TextButton({confirmation=null}){Text("返回")}})}
}

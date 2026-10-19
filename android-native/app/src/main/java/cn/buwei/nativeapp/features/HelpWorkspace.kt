package cn.buwei.nativeapp.features

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import cn.buwei.nativeapp.BuildConfig
import kotlinx.coroutines.*

private data class HelpWorkspaceDisplay(val key:String,val chapter:HelpWorkspaceChapter?=null,val block:HelpWorkspaceBlock?=null)
@Composable fun HelpWorkspace(onNavigate:(String)->Unit){
 val context=LocalContext.current;val scope=rememberCoroutineScope();val list=rememberLazyListState()
 var kind by rememberSaveable{mutableStateOf("user")};var query by rememberSaveable{mutableStateOf("")};var contentsOpen by rememberSaveable{mutableStateOf(false)};var publicOpen by rememberSaveable{mutableStateOf(false)};var selectedChapter by rememberSaveable(kind){mutableStateOf<String?>(null)};var content by remember(kind){mutableStateOf<String?>(null)};var error by remember{mutableStateOf<String?>(null)};var notice by remember{mutableStateOf("")};var download by remember{mutableStateOf<Pair<String,String>?>(null)}
 val source=helpWorkspaceSources.first{it.key==kind}
 LaunchedEffect(kind){try{content=withContext(Dispatchers.IO){source.content{context.assets.open(it)}}}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}}
 val document=remember(kind,content){helpWorkspaceChapters(content.orEmpty(),kind)};val visible=remember(document,query){helpWorkspaceSearch(document.sections,query)}
 val selected=visible.firstOrNull{it.id==selectedChapter}?:visible.firstOrNull()
 val display=remember(selected){listOfNotNull(selected).flatMap{chapter->listOf(HelpWorkspaceDisplay(chapter.id,chapter=chapter))+helpWorkspaceBlocks(chapter.content).mapIndexed{index,block->HelpWorkspaceDisplay("${chapter.id}-block-$index",block=block)}}}
 fun navigate(target:String){val uri=target.toUri();if(uri.path in listOf("/app/help","/app/support/help")){kind=uri.getQueryParameter("doc")?.takeIf{it in listOf("user","technical","database")}?:"user";query=uri.getQueryParameter("q").orEmpty();selectedChapter=null}else onNavigate(target)}
 fun anchor(id:String){val chapter=visible.firstOrNull{it.id==id||it.title==id}?:return;selectedChapter=chapter.id;scope.launch{list.animateScrollToItem(1+(if(contentsOpen)visible.size else 0))}}
 val save=rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")){uri->val snapshot=download;if(uri!=null&&snapshot!=null)scope.launch{try{withContext(Dispatchers.IO){context.contentResolver.openOutputStream(uri,"wt")!!.bufferedWriter(Charsets.UTF_8).use{it.write(snapshot.second)}};notice="完整文档已下载：${snapshot.first}"}catch(e:CancellationException){throw e}catch(e:Exception){error=e.message}};download=null}
 LaunchedEffect(kind,query){list.scrollToItem(0)}
 LazyColumn(Modifier.fillMaxSize().padding(horizontal=16.dp),state=list,verticalArrangement=Arrangement.spacedBy(10.dp),contentPadding=PaddingValues(vertical=16.dp)){
  item("toolbar"){Column(verticalArrangement=Arrangement.spacedBy(8.dp)){
   Text("帮助文档",style=MaterialTheme.typography.headlineSmall);Text("使用说明介绍操作流程；技术实现与数据库字典记录系统结构和运行机制。")
   Row(horizontalArrangement=Arrangement.spacedBy(6.dp)){helpWorkspaceSources.forEach{entry->FilterChip(kind==entry.key,{kind=entry.key;query="";notice=""},label={Text(entry.title)})}}
   OutlinedTextField(query,{query=it},label={Text("搜索当前文档，如：任务、版本")},modifier=Modifier.fillMaxWidth())
   OutlinedButton({val full=content?:return@OutlinedButton;download=source.filename to full;save.launch(source.filename)},enabled=content!=null){Text("下载完整 Markdown 文档")}
   TextButton({contentsOpen=!contentsOpen}){Text(if(contentsOpen)"收起章节目录"else"展开章节目录（${visible.size}个章节）")}
   Button({onNavigate("support")}){Text("仍有疑问？提交支持工单")}
   TextButton({publicOpen=!publicOpen}){Text(if(publicOpen)"收起注册与账户帮助"else"注册与账户帮助")}
   if(publicOpen)HelpWorkspacePublicHelp(onNavigate)
   error?.let{Text(it,color=MaterialTheme.colorScheme.error)};if(notice.isNotBlank())Text(notice)
  }}
  if(contentsOpen)items(visible,key={"toc-${it.id}"}){chapter->TextButton({anchor(chapter.id)}){Text(chapter.title)}}
  item("document-intro"){Column(verticalArrangement=Arrangement.spacedBy(8.dp)){Text(source.title,style=MaterialTheme.typography.titleLarge);Text(source.detail);if(content==null)LinearProgressIndicator(Modifier.fillMaxWidth())else if(query.isBlank())HelpWorkspaceMarkdown(document.intro,onNavigate=::navigate,onAnchor=::anchor)else Text("找到 ${visible.size} 个相关章节");selected?.let{chapter->val position=visible.indexOf(chapter);Text("当前章节：${chapter.title}（${position+1}/${visible.size}）");Row{TextButton({anchor(visible[position-1].id)},enabled=position>0){Text("上一章")};TextButton({anchor(visible[position+1].id)},enabled=position<visible.lastIndex){Text("下一章")}}}}}
  if(visible.isEmpty()&&content!=null)item("empty"){Column{Text("未找到相关章节",style=MaterialTheme.typography.titleMedium);Text("试试更短的关键词，或切换另一份文档。");TextButton({query=""}){Text("清除搜索")}}}
  items(display,key={it.key}){item->if(item.chapter!=null){HorizontalDivider();Text(item.chapter.title,style=MaterialTheme.typography.headlineSmall)}else item.block?.let{HelpWorkspaceBlockView(it,onNavigate=::navigate,onAnchor=::anchor)}}
 }
}
@Composable private fun HelpWorkspacePublicHelp(onNavigate:(String)->Unit){
 val context=LocalContext.current
 OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
  Text("注册与账户帮助",style=MaterialTheme.typography.titleLarge);Text("注册需要系统管理员提供的16位一次性注册邀请码。项目邀请用于加入团队；请先注册或登录，再回到邀请预览确认加入。")
  Text("忘记密码",style=MaterialTheme.typography.titleMedium);Text("优先使用已绑定且验证的恢复邮箱。注册时填写但未验证的邮箱无法用于恢复；登录后可在账户安全设置验证邮箱。")
  TextButton({onNavigate("/password-forgot")}){Text("通过邮件恢复密码")}
  Text("管理员人工恢复（后备）",style=MaterialTheme.typography.titleMedium);Text("无法使用已验证邮箱时，请联系以下邮箱，提供登录用户名及可核实的账户归属说明。不要发送密码、API密钥或完整项目资料。")
  SelectionContainer{Text("2945531970@qq.com")};Text("超级管理员人工核实后，可提供30分钟有效的一次性恢复代码。")
  TextButton({onNavigate("/password-reset")}){Text("使用管理员提供的恢复代码")};TextButton({onNavigate("/login")}){Text("返回登录")}
  TextButton({context.startActivity(Intent(Intent.ACTION_VIEW,(BuildConfig.SERVICE_ORIGIN+"/guest/index.html").toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}){Text("在系统浏览器查看游客演示")}
 }}
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.NativeDestination
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.media.ExportWorkspace
import cn.buwei.nativeapp.media.MediaWorkspace
import kotlinx.serialization.json.*

/** App destinations resolve to business workspaces, with server-owned permissions and versions. */
@Composable
fun FeatureScreen(repository:ClientRepository,section:String,projectId:String?,onProject:(String)->Unit,onNavigate:(String)->Unit,initialDestination:NativeDestination?=null,onOpenPath:((String)->Unit)?=null,onActivityChange:(Boolean)->Unit={}) {
    when(section) {
        "projects"->{ProjectDashboardWorkspace(repository,onProject,onNavigate);return}
        "create-project"->{ProjectCreationScreen(repository,onProject);return}
        "profile"->{AccountWorkspace(repository);return}
        "people"->{PeopleWorkspace(repository,initialDestination?.username);return}
        "notifications"->{NotificationWorkspace(repository,onOpenPath);return}
        "support"->{SupportWorkspace(repository,initialDestination?.recordId);return}
        "bridges"->{AgentBridgeWorkspace(repository);return}
        "join"->{TeamWorkspaceJoin(repository,onProject);return}
        "accounts","system","ai-settings"->{AdminWorkspace(repository,section);return}
        "help"->{HelpWorkspace(onNavigate);return}
    }
    if(projectId!=null)when(section) {
        "overview"->ProjectOverviewWorkspace(repository,projectId,onNavigate)
        "ledger"->ProjectLedgerWorkspace(repository,projectId)
        "tasks"->TaskWorkspace(repository,projectId,initialDestination?.recordId,initialDestination?.taskAction)
        "data"->DataWorkspace(repository,projectId,initialDestination,onActivityChange){onNavigate("material-ai")}
        "material-ai"->MaterialAiWorkspace(repository,projectId)
        "team"->TeamWorkspace(repository,projectId)
        "assessment"->AssessmentWorkspace(repository,projectId,initialDestination?.recordId,initialDestination?.assessmentSection)
        "rehearsals"->RehearsalWorkspace(repository,projectId,initialAssessmentId=initialDestination?.recordId)
        "project-settings"->ProjectSettingsWorkspace(repository,projectId)
        "ai-chat"->AiConversationScreen(repository,projectId){onOpenPath?.invoke(it)}
        "export"->ExportWorkspace(repository,projectId)
        "media"->MediaWorkspace(repository,projectId,onActivityChange)
        else->UnavailableWorkspace(onNavigate)
    } else UnavailableWorkspace(onNavigate)
}

@Composable private fun UnavailableWorkspace(onNavigate:(String)->Unit){Column(Modifier.padding(20.dp)){Text("请返回项目列表选择工作区");TextButton({onNavigate("projects")}){Text("返回项目列表")}}}

internal fun pathParameterNames(path:String):List<String> = Regex("\\{([^}]+)\\}").findAll(path).map{it.groupValues[1]}.toList()

@Composable
internal fun StructuredValue(value:JsonElement,depth:Int=0){
 if(depth>8)return
 when(value){
  is JsonObject->{
   if(value.text("type")=="doc"){ReadOnlyRichDocument(value);return}
   val markdown=value.text("markdown")
   val document=value["doc"]as? JsonObject
   val metadata=value.entries.filter{(key,v)->businessFieldVisible(key)&&key!="markdown"&&v!=JsonNull&&!(v is JsonPrimitive&&v.contentOrNull.isNullOrBlank())&&!(v is JsonArray&&v.isEmpty())&&!(v is JsonObject&&v.isEmpty())}
   val priority=listOf("title","name","displayName","status","lifecycleState","revision","version","purpose","kind")
   Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(10.dp)){
    metadata.filter{it.value is JsonPrimitive}.sortedBy{priority.indexOf(it.key).takeIf{i->i>=0}?:priority.size}.forEach{(key,v)->
     val text=businessValue(key,v.jsonPrimitive)
     if(key in listOf("body","content","text","summary","report","feedback","answer","question")){
      Text(label(key),style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.onSurfaceVariant)
      NativeMarkdown(text)
     }else SelectionContainer{Text("${label(key)}：$text",style=if(key in listOf("title","name"))MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium)}
    }
    if(markdown.isNotBlank()||document!=null){
     Text("正文",style=MaterialTheme.typography.titleMedium)
     if(markdown.isNotBlank())NativeMarkdown(markdown)else document?.let{ReadOnlyRichDocument(it)}
    }
    metadata.filter{it.value !is JsonPrimitive}.forEach{(key,v)->
     if(key=="currentVersion"){
      HorizontalDivider();Text("当前版本",style=MaterialTheme.typography.titleSmall)
      StructuredValue(v,depth+1)
     }else{
      var open by remember(key){mutableStateOf(key in listOf("attachments","messages","turns","report","result","ticket","goal","preview","requirements","scores","references"))}
      TextButton({open=!open},contentPadding=PaddingValues(0.dp)){Text(label(key)+(if(v is JsonArray)" · ${v.size}"else"")+if(open)" −"else" +")}
      if(open)Column(Modifier.fillMaxWidth().padding(start=8.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){StructuredValue(v,depth+1)}
     }
    }
   }
  }
  is JsonArray->value.forEach{v->if(v!=JsonNull){if(v is JsonPrimitive)SelectionContainer{Text(v.contentOrNull.orEmpty())}else Card(Modifier.fillMaxWidth()){Column(Modifier.padding(12.dp)){StructuredValue(v,depth+1)}}}}
  is JsonPrimitive->SelectionContainer{Text(value.contentOrNull?:"—")}
 }
}

/** Native content presentation never exposes the editor's JSON schema or node attributes. */
@Composable
private fun ReadOnlyRichDocument(node:JsonObject,depth:Int=0){
 if(depth>30)return
 val children=(node["content"]as? JsonArray).orEmpty().mapNotNull{it as? JsonObject}
 val text=richDocumentText(node)
 when(node.text("type")){
  "doc"->Column(verticalArrangement=Arrangement.spacedBy(8.dp)){children.forEach{ReadOnlyRichDocument(it,depth+1)}}
  "heading"->if(text.isNotBlank())SelectionContainer{Text(text,style=if((node.obj("attrs")["level"]as? JsonPrimitive)?.intOrNull==1)MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium)}
  "paragraph","text"->if(text.isNotBlank())SelectionContainer{Text(text)}
  "codeBlock"->if(text.isNotBlank())Surface(color=MaterialTheme.colorScheme.surfaceContainer,shape=MaterialTheme.shapes.small){SelectionContainer{Text(text,Modifier.padding(10.dp),fontFamily=androidx.compose.ui.text.font.FontFamily.Monospace)}}
  "table"->if(text.isNotBlank())Surface(color=MaterialTheme.colorScheme.surfaceContainer,shape=MaterialTheme.shapes.small){SelectionContainer{Text(text,Modifier.padding(10.dp))}}
  "bulletList","orderedList"->Column(verticalArrangement=Arrangement.spacedBy(6.dp)){children.forEachIndexed{i,child->Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){Text(if(node.text("type")=="orderedList")"${i+1}."else"•");Column(Modifier.weight(1f)){ReadOnlyRichDocument(child,depth+1)}}}}
  "blockquote"->Column(Modifier.padding(start=12.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){children.forEach{ReadOnlyRichDocument(it,depth+1)}}
  "citation","reference","sourceCitation"->{val attrs=node.obj("attrs");val quote=attrs.text("quote");val title=attrs.text("label").ifBlank{attrs.text("title")};Text(if(title.isBlank())"引用资料"else"引用：$title",style=MaterialTheme.typography.labelLarge,color=MaterialTheme.colorScheme.primary);if(quote.isNotBlank())SelectionContainer{Text(quote,style=MaterialTheme.typography.bodySmall)}}
  "image"->{val attrs=node.obj("attrs");Text(attrs.text("alt").ifBlank{attrs.text("title")}.let{if(it.isBlank())"图片附件"else"图片：$it"},style=MaterialTheme.typography.bodySmall)}
  "horizontalRule"->HorizontalDivider()
  "hardBreak"->Spacer(Modifier.height(4.dp))
  else->if(children.isNotEmpty())Column(verticalArrangement=Arrangement.spacedBy(6.dp)){children.forEach{ReadOnlyRichDocument(it,depth+1)}}
 }
}

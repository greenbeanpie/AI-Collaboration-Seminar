package cn.buwei.nativeapp.features

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

internal fun helpWorkspaceOpenLink(context:Context,target:String,onNavigate:((String)->Unit)?=null,onAnchor:((String)->Unit)?=null){
 val safe=helpWorkspaceLink(target)?:return
 when{safe.startsWith('#')->onAnchor?.invoke(safe.drop(1));safe.startsWith("/app")->onNavigate?.invoke(safe);else->context.startActivity(Intent(Intent.ACTION_VIEW,safe.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}
}
@Composable internal fun HelpWorkspaceInline(text:String,hideImages:Boolean=false,onNavigate:((String)->Unit)?=null,onAnchor:((String)->Unit)?=null){
 val context=LocalContext.current;val linkColor=MaterialTheme.colorScheme.primary
 val annotated=remember(text,hideImages,onNavigate,onAnchor,linkColor){buildAnnotatedString{
  val pattern=Regex("""(`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]*\]\([^\s)]*\))""")
  var offset=0
  pattern.findAll(text).forEach{match->append(text.substring(offset,match.range.first));val part=match.value
   when{
    part.startsWith("![")->append(if(hideImages)"[图片已隐藏]"else part)
    part.startsWith('`')->withStyle(SpanStyle(fontFamily=FontFamily.Monospace)){append(part.drop(1).dropLast(1))}
    part.startsWith("**")->withStyle(SpanStyle(fontWeight=FontWeight.Bold)){append(part.drop(2).dropLast(2))}
    else->{val link=Regex("""^\[([^\]]*)\]\(([^)]*)\)$""").matchEntire(part);if(link==null)append(part)else{val title=link.groupValues[1];val target=link.groupValues[2];val safe=helpWorkspaceLink(target);if(safe!=null&&(!safe.startsWith("/app")||onNavigate!=null)&&(!safe.startsWith('#')||onAnchor!=null))withStyle(SpanStyle(color=linkColor)){withLink(LinkAnnotation.Clickable(safe,linkInteractionListener={helpWorkspaceOpenLink(context,safe,onNavigate,onAnchor)})){append(title)}}else append(title)}}
   };offset=match.range.last+1
  };append(text.substring(offset))
 }}
 SelectionContainer{Text(annotated,modifier=Modifier.fillMaxWidth(),softWrap=true)}
}
@Composable internal fun HelpWorkspaceBlockView(block:HelpWorkspaceBlock,hideImages:Boolean=false,onNavigate:((String)->Unit)?=null,onAnchor:((String)->Unit)?=null){
 when(block.kind){
  "heading"->{Text(block.text,style=when(block.level){1->MaterialTheme.typography.headlineSmall;2->MaterialTheme.typography.titleLarge;else->MaterialTheme.typography.titleMedium})}
  "code"->Surface(Modifier.fillMaxWidth(),color=MaterialTheme.colorScheme.surfaceContainerHighest,shape=MaterialTheme.shapes.small){Column(Modifier.padding(10.dp)){block.labels.firstOrNull()?.takeIf{it.isNotBlank()}?.let{Text("$it 示例",style=MaterialTheme.typography.labelMedium)};SelectionContainer{Text(block.text,modifier=Modifier.fillMaxWidth(),fontFamily=FontFamily.Monospace,style=MaterialTheme.typography.bodySmall,softWrap=true)}}}
  "table-row"->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){block.cells.forEachIndexed{index,cell->Text(block.labels.getOrNull(index).orEmpty().ifBlank{"列 ${index+1}"},style=MaterialTheme.typography.labelLarge);HelpWorkspaceInline(cell,hideImages,onNavigate,onAnchor)}}}
  else->HelpWorkspaceInline(block.text,hideImages,onNavigate,onAnchor)
 }
}
@Composable internal fun HelpWorkspaceMarkdown(value:String,hideImages:Boolean=false,onNavigate:((String)->Unit)?=null,onAnchor:((String)->Unit)?=null){
 val blocks=remember(value){helpWorkspaceBlocks(value)}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)){blocks.forEach{HelpWorkspaceBlockView(it,hideImages,onNavigate,onAnchor)}}
}

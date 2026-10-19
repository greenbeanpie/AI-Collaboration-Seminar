package cn.buwei.nativeapp.features

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

/** Fits an existing scroll container. Long documents remain available through explicit finite batches. */
@Composable fun NativeMarkdownContent(markdown:String,onNavigate:((String)->Unit)?=null){
 val blocks=remember(markdown){parseNativeMarkdown(markdown)};var shown by remember(markdown){mutableIntStateOf(16)}
 Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)){
  blocks.take(shown).forEach{block->NativeMarkdownBlockContent(block,onNavigate)}
  if(shown<blocks.size){Text("长文已显示 ${minOf(shown,blocks.size)} / ${blocks.size} 个文本块，后续内容保留待展开。",style=MaterialTheme.typography.labelMedium);OutlinedButton({shown=minOf(shown+16,blocks.size)}){Text("显示后续内容（还有 ${blocks.size-shown} 个文本块）")}}
 }
}
@Composable private fun NativeMarkdownBlockContent(block:NativeMarkdownBlock,onNavigate:((String)->Unit)?){
 when(block.kind){
  "heading"->NativeMarkdownInlineContent(block.inline,onNavigate,heading=block.level)
  "rule"->HorizontalDivider(Modifier.padding(vertical=6.dp))
  "code"->Surface(Modifier.fillMaxWidth().testTag("native-markdown-code"),color=MaterialTheme.colorScheme.surfaceContainerHighest,shape=MaterialTheme.shapes.small){Column(Modifier.padding(12.dp)){if(block.language.isNotBlank())Text(block.language,style=MaterialTheme.typography.labelSmall);SelectionContainer{Text(block.code,Modifier.fillMaxWidth(),fontFamily=FontFamily.Monospace,style=MaterialTheme.typography.bodySmall,softWrap=true)}}}
  "quote"->Surface(Modifier.fillMaxWidth().padding(start=minOf(block.depth-1,5).coerceAtLeast(0).times(8).dp),color=MaterialTheme.colorScheme.surfaceContainer,shape=MaterialTheme.shapes.small){Row(Modifier.padding(10.dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){Text("❯",color=MaterialTheme.colorScheme.primary);Box(Modifier.weight(1f)){NativeMarkdownInlineContent(block.inline,onNavigate)}}}
  "list"->Row(Modifier.fillMaxWidth().padding(start=(block.depth*12).dp),horizontalArrangement=Arrangement.spacedBy(8.dp)){Text(block.marker);Box(Modifier.weight(1f)){NativeMarkdownInlineContent(block.inline,onNavigate)}}
  "table-header"->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){Text("表格列",style=MaterialTheme.typography.labelLarge);block.cells.forEach{NativeMarkdownInlineContent(it,onNavigate,forceBold=true)}}}
  "table-row"->OutlinedCard(Modifier.fillMaxWidth()){Column(Modifier.padding(10.dp),verticalArrangement=Arrangement.spacedBy(6.dp)){block.cells.forEachIndexed{index,cell->block.headers.getOrNull(index)?.let{NativeMarkdownInlineContent(it,onNavigate,forceBold=true)};NativeMarkdownInlineContent(cell,onNavigate)}}}
  else->NativeMarkdownInlineContent(block.inline,onNavigate)
 }
}
@Composable private fun NativeMarkdownInlineContent(runs:List<NativeMarkdownInline>,onNavigate:((String)->Unit)?,heading:Int=0,forceBold:Boolean=false){
 val context=LocalContext.current;val color=MaterialTheme.colorScheme.primary;val codeBackground=MaterialTheme.colorScheme.surfaceContainerHighest
 val text=remember(runs,onNavigate,color,codeBackground,forceBold){buildAnnotatedString{
  runs.forEachIndexed{index,run->
   val style=SpanStyle(fontWeight=if(run.bold||forceBold)FontWeight.Bold else null,fontStyle=if(run.italic)FontStyle.Italic else null,textDecoration=if(run.strike)TextDecoration.LineThrough else null,fontFamily=if(run.code)FontFamily.Monospace else null,background=if(run.code)codeBackground else Color.Unspecified)
   val href=run.href;val target=href?.let(::nativeMarkdownHref);val clickable=target!=null&&(!target.startsWith("/app")||onNavigate!=null)
   withStyle(style){if(clickable){withStyle(SpanStyle(color=color,textDecoration=TextDecoration.Underline)){withLink(LinkAnnotation.Clickable(target,linkInteractionListener={
    if(target.startsWith("/app"))onNavigate?.invoke(target)else runCatching{context.startActivity(Intent(Intent.ACTION_VIEW,target.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}.onFailure{Toast.makeText(context,"未找到可打开链接的浏览器",Toast.LENGTH_SHORT).show()}
   })){append(run.text)}}}else append(run.text)}
   // Preserve destination visibility, including blocked protocols, without making them executable.
   if(href!=null&&runs.getOrNull(index+1)?.href!=href){val label=runs.take(index+1).takeLastWhile{it.href==href}.joinToString(""){it.text};if(label!=href)withStyle(SpanStyle(color=color)){append("（$href）")}}
  }
 }}
 SelectionContainer{Text(text,Modifier.fillMaxWidth(),style=when(heading){1->MaterialTheme.typography.headlineSmall;2->MaterialTheme.typography.titleLarge;in 3..6->MaterialTheme.typography.titleMedium;else->MaterialTheme.typography.bodyMedium},softWrap=true)}
}

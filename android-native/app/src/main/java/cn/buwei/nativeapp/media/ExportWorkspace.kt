package cn.buwei.nativeapp.media

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.text.StaticLayout
import android.text.TextPaint
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.features.nativeMarkdownChunks
import cn.buwei.nativeapp.features.nativeRichDocumentBlocks
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.io.File
import java.util.UUID

private val exportJson=Json {prettyPrint=true}

/** Export consumes the server's permission-filtered bundle; it does not reconstruct private data. */
@Composable fun ExportWorkspace(repository:ClientRepository,project:String) {
    val scope=rememberCoroutineScope();val context=LocalContext.current
    val owner=repository.accountId;val epoch=repository.epoch
    var bundle by remember(owner,epoch,project) {mutableStateOf<JsonObject?>(null)}
    var preview by remember(owner,epoch,project) {mutableStateOf<List<String>>(emptyList())}
    var refresh by remember(owner,epoch,project){mutableIntStateOf(0)}
    var error by remember(owner,epoch,project) {mutableStateOf<String?>(null)};var busy by remember(owner,epoch,project) {mutableStateOf(false)}
    LaunchedEffect(owner,epoch,project,refresh) {busy=true;error=null;try {
        check(owner!=null){"请登录"}
        val fresh=repository.networkJson("GET","/projects/$project/export-bundle",expectedOwner=owner,expectedEpoch=epoch)
        val lines=withContext(Dispatchers.Default){exportText(fresh).lineSequence().flatMap{nativeMarkdownChunks(it).asSequence()}.toList()}
        check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，停止读取导出"}
        bundle=fresh;preview=lines
    }catch(e:Exception){if(e is CancellationException)throw e;error=e.message?:"导出读取失败"}finally{busy=false}}
    fun export(format:String) {scope.launch {busy=true;error=null;try {
        val owner=repository.accountId?:error("请登录");val epoch=repository.epoch
        val fresh=repository.networkJson("GET","/projects/$project/export-bundle",expectedOwner=owner,expectedEpoch=epoch)
        val file=withContext(Dispatchers.IO) {
            val directory=File(context.cacheDir,"exports/$owner/${UUID.randomUUID()}").apply {mkdirs()}
            File(directory,"项目成果.$format").also {output->when(format){"pdf"->writeExportPdf(exportText(fresh),output);"json"->output.writeText(exportJson.encodeToString(JsonObject.serializer(),fresh));else->output.writeText(exportText(fresh))}}
        }
        check(owner==repository.accountId&&epoch==repository.epoch){"账户已变化，停止导出"}
        shareExport(context,file,when(format){"pdf"->"application/pdf";"json"->"application/json";else->"text/markdown"})
    }catch(e:Exception){if(e is CancellationException)throw e;error=e.message?:"导出失败"}finally{busy=false}} }
    Column(Modifier.fillMaxSize().padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("成果导出",style=MaterialTheme.typography.headlineMedium)
        Text("导出当前有权查看的项目成果，附件原文件可在资料库逐个下载。")
        Text("导出前会重新核对权限并读取最新数据。刷新可更新下方预览。",style=MaterialTheme.typography.bodySmall)
        OutlinedButton(onClick={refresh++},enabled=!busy){Text(if(busy)"正在读取"else"刷新数据")}
        if(busy)LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let {Text(it,color=MaterialTheme.colorScheme.error)}
        if(error!=null&&bundle!=null)Text("以下保留上次读取的预览；请刷新核对最新版本。",style=MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){listOf("pdf" to "PDF","md" to "正文","json" to "完整数据").forEach {(format,title)->OutlinedButton(onClick={export(format)},enabled=!busy&&bundle!=null){Text(title)}}}
        bundle?.get("generatedAt")?.jsonPrimitive?.contentOrNull?.let{Text("预览生成于：$it",style=MaterialTheme.typography.bodySmall)}
        LazyColumn(Modifier.weight(1f)) {items(preview){line->androidx.compose.foundation.text.selection.SelectionContainer{Text(line,Modifier.fillMaxWidth().padding(vertical=3.dp),style=MaterialTheme.typography.bodyMedium)}}}
    }
}

internal fun exportText(bundle:JsonElement):String {
    val names=mapOf("project" to "项目","name" to "名称","title" to "标题","description" to "说明","tasks" to "任务","materials" to "成果材料","requirements" to "项目要求","standards" to "标准","sources" to "来源","members" to "团队","submissions" to "提交","markdown" to "正文","detail" to "任务内容","criteria" to "验收要求","createdAt" to "创建时间","revision" to "版本","status" to "状态","reviews" to "预审","assessments" to "评估")
    val output=StringBuilder("# 补位 · 项目成果\n\n")
    fun append(value:JsonElement,level:Int) {
        when(value) {
            is JsonObject -> value.forEach {(key,item)->if(item!=JsonNull){
                if(key=="doc"){
                    if((value["markdown"]as? JsonPrimitive)?.contentOrNull.isNullOrBlank()&&item is JsonObject&&item["type"]==JsonPrimitive("doc")){
                        nativeRichDocumentBlocks(item).forEach{block->
                            if(block.marker.isNotBlank())output.append(block.marker).append(' ')
                            if(block.kind=="code")output.append("```\n").append(block.code).append("\n```\n")
                            else block.inline.forEach{run->output.append(run.text);run.href?.let{output.append(" (").append(it).append(')')}}
                            output.append('\n')
                        }
                    }
                }else if(item is JsonPrimitive)output.append(names[key]?:key).append("：").append(item.content).append('\n') else {output.append('\n').append("#".repeat((level+2).coerceAtMost(6))).append(' ').append(names[key]?:key).append('\n');append(item,level+1)}
            }}
            is JsonArray -> value.forEachIndexed {index,item->output.append('\n').append(index+1).append(". ");append(item,level)}
            is JsonPrimitive -> output.append(value.content).append('\n')
        }
    }
    append(bundle,0);return output.toString()
}

internal fun writeExportPdf(text:String,destination:File) {
    require(text.length<=1_000_000){"内容较大，请导出正文或完整数据，避免 PDF 排版占用过多内存"}
    val paint=TextPaint(Paint.ANTI_ALIAS_FLAG).apply {color=Color.BLACK;textSize=12f}
    val document=PdfDocument()
    try {
        var pageNumber=0
        var page=document.startPage(PdfDocument.PageInfo.Builder(595,842,++pageNumber).create())
        var y=36
        for(paragraph in text.lineSequence()) {
            val layout=StaticLayout.Builder.obtain(paragraph.ifBlank{" "},0,paragraph.ifBlank{" "}.length,paint,523).setIncludePad(false).setLineSpacing(3f,1f).build()
            for(line in 0 until layout.lineCount) {
                val height=layout.getLineBottom(line)-layout.getLineTop(line)
                if(y+height>806) {document.finishPage(page);page=document.startPage(PdfDocument.PageInfo.Builder(595,842,++pageNumber).create());y=36}
                val content=paragraph.ifBlank{" "}.substring(layout.getLineStart(line),layout.getLineEnd(line)).trimEnd()
                page.canvas.drawText(content,36f,(y-layout.getLineAscent(line)).toFloat(),paint);y+=height
            }
        }
        document.finishPage(page);destination.outputStream().use {document.writeTo(it)}
    }finally{document.close()}
}

private fun shareExport(context:Context,file:File,mime:String) {
    val uri=FileProvider.getUriForFile(context,"${context.packageName}.files",file)
    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"保存 / 分享项目成果"))
}

package cn.buwei.nativeapp.features

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import kotlinx.serialization.json.*
import java.util.Locale

private val processingActive=setOf("queued","running","processing")
internal fun nativeFileProcessingActive(state:JsonObject):Boolean = state.dataFlag("waitingForConcurrency") ||
 if(state.containsKey("jobStatus"))state.twText("jobStatus") in processingActive
 else listOf("textStatus","summaryStatus","requirementsStatus").any{state.twText(it) in processingActive}
internal fun nativeFileProcessingPaused(state:JsonObject)=state.twText("jobStatus")=="waiting_input" && (state["needsImages"] as? JsonPrimitive)?.intOrNull==0
internal fun nativeFileProcessingRetry(state:JsonObject)=listOf("jobStatus","textStatus","summaryStatus","requirementsStatus").any{state.twText(it) in setOf("failed","cancelled")}
internal fun nativeSourceProcessingActive(state:JsonObject):Boolean {
 val media=state["media"] as? JsonObject
 return listOf("textStatus","requirementsStatus","summaryStatus").any{state.twText(it) in processingActive} ||
  (media!=null&&media.obj("audio").twText("phase")!="waiting_config"&&media.twText("stage") in setOf("pending","uploading","processing","generating"))
}
internal fun nativeSummaryCanStart(state:JsonObject)=state.twText("textStatus")=="ready" && state.twText("summaryStatus") !in setOf("ready","queued","running") && !(state.twText("summaryStatus")=="failed"&&state.twText("summaryJobId").isNotBlank())
internal fun nativeAudioPhase(value:String)=mapOf("cancelled" to "任务已取消","pending" to "等待转录","transcribing" to "Whisper 转录中","checking" to "检查转录质量","transcribed" to "转录完成，等待质量检查","checked" to "质量检查通过，等待摘要","summarized" to "摘要分段完成","merging" to "合并摘要","unknown" to "请求状态待核对","quality_check" to "检查转录质量","summarizing" to "生成文本摘要","fallback" to "Gemini 回退","gemini_fallback" to "Gemini 回退","waiting_config" to "等待 Gemini 配置","ready" to "摘要完成","failed" to "处理失败")[value]?:value

@Composable internal fun NativeAudioPipelineStatus(audio:JsonObject){
 Text("音频转录质量与回退",style=MaterialTheme.typography.titleMedium)
 Text(nativeAudioPhase(audio.twText("phase")))
 (audio["qualityScore"] as? JsonPrimitive)?.doubleOrNull?.takeIf{it.isFinite()}?.let{Text("转录质量评分：${String.format(Locale.ROOT,"%.2f",it)} · 通过门槛 0.85")}
 if(audio.dataFlag("transcriptAvailable"))Text("机器转录已私有保存，可继续处理。")
 audio.twIds("reasons").forEach{NativeMarkdown(it)}
 Text("质量评分是 AI 检查结果，不是原音准确率保证。",style=MaterialTheme.typography.bodySmall)
}
@Composable internal fun NativeMediaSummaryContent(summary:JsonObject){
 Text("音视频 AI 摘要（并非逐字原文）",style=MaterialTheme.typography.titleMedium)
 if(!summary.dataFlag("complete"))Text("部分摘要，尚未完整覆盖，请结合原文件核对。",color=MaterialTheme.colorScheme.error)
 if(summary.twText("title").isNotBlank())Text(summary.twText("title"),style=MaterialTheme.typography.titleMedium)
 NativeMarkdown(summary.twText("summary"))
 listOf("keyPoints" to "重点","conclusions" to "结论","actionItems" to "行动事项","caveats" to "注意事项").forEach{(field,title)->val rows=summary.twIds(field);if(rows.isNotEmpty()){Text(title,style=MaterialTheme.typography.labelLarge);rows.forEach{NativeMarkdown("• $it")}}}
 summary.twRows("timestamps").forEach{Text("${it.twText("seconds")} 秒：${it.twText("description")}")}
}

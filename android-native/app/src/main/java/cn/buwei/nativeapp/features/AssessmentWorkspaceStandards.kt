package cn.buwei.nativeapp.features

import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.data.requestDurably
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

@Composable
internal fun AssessmentStandardEditor(repository: ClientRepository, projectId: String, current: JsonObject?, history: List<JsonObject>, canEdit: Boolean, busy: Boolean, onSave: (String, List<AssessmentDimension>, JsonObject?) -> Unit, onGenerate: () -> Unit, generatedJobId: String) {
    var editing by remember { mutableStateOf(false) }; var original by remember { mutableStateOf<JsonObject?>(null) }; var title by remember { mutableStateOf("项目标准") }; var dimensions by remember { mutableStateOf(listOf(AssessmentDimension())) }; var error by remember { mutableStateOf<String?>(null) }
    AssessmentDraft(repository, "standard-editor:$projectId", buildJsonObject { put("editing", editing); put("title", title); put("original", original ?: JsonNull); put("dimensions", JsonArray(dimensions.map { d -> buildJsonObject { put("key", d.key); put("label", d.label); put("weight", d.weight); put("citations", JsonArray(d.citations)) } })) }, restore = { saved -> if (saved.flag("editing")) { editing = true; title = saved.text("title"); original = saved["original"] as? JsonObject; dimensions = saved.rows("dimensions").map { AssessmentDimension(it.text("key"), it.text("label"), it.text("weight"), it.rows("citations")) } } }, failure = { error = it })
    var selectedHistory by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    Text("项目级标准 · ${current?.text("title") ?: "尚未建立"} · v${current?.text("version").orEmpty()}", style = MaterialTheme.typography.titleMedium)
    current?.obj("rubric")?.rows("weights")?.forEach { Text("${it.text("label")} · 权重 ${it.text("weight")}%") }
    current?.rows("requirements")?.forEach { requirement -> requirement.rows("citations").forEach { Text("来源原文：${it.text("quote")}", style = MaterialTheme.typography.bodySmall) } }
    if (canEdit) {
        TextButton({ original = null; title = "项目标准"; dimensions = listOf(AssessmentDimension()); editing = true }, enabled = !busy) { Text("新建项目标准") }
        current?.let { version -> TextButton({ original = version; title = version.text("title"); dimensions = version.obj("rubric").rows("weights").map { weight -> val key = weight.text("key"); val requirementIds = version.rows("mappings").filter { it.text("dimensionKey") == key }.map { it.text("requirementId") }; AssessmentDimension(key, weight.text("label"), weight.text("weight"), version.rows("requirements").filter { it.text("requirementId") in requirementIds }.flatMap { it.rows("citations") }.map { citation -> JsonObject(citation.filterKeys { it in setOf("sourceVersionId", "fragmentId", "pageNumber", "quote") }) }) }; editing = true }, enabled = !busy) { Text("修订生效标准") } }
        TextButton(onGenerate, enabled = !busy) { Text("AI 生成标准草稿") }
        if (generatedJobId.isNotBlank()) TextButton({ scope.launch { try { val job = repository.networkJson("GET", "/api/v1/jobs/${Uri.encode(generatedJobId)}"); check(job.text("status") == "succeeded") { "生成尚未完成，请先查看执行状态" }; val result = job.obj("result"); check(result.text("scoringOutputVersion") == "2") { "生成格式不兼容，请重新生成" }; val draft = result.obj("draft"); check(draft.text("notes").isBlank()) { "生成结果不符合评分标准格式" }; dimensions = draft.rows("weights").map { weight -> AssessmentDimension(weight.text("key"), weight.text("label"), weight.text("weight"), draft.rows("requirements").filter { it.text("dimensionKey") == weight.text("key") }.flatMap { it.rows("citations") }) }; title = draft.text("title"); original = null; editing = true } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } } }) { Text("读取并核对生成草稿") }
    }
    if (editing) {
        OutlinedTextField(title, { if (it.length <= 200) title = it }, Modifier.fillMaxWidth(), label = { Text("标准名称") })
        dimensions.forEachIndexed { index, dimension -> key(dimension.key) { Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("评分维度 ${index + 1}")
            OutlinedTextField(dimension.label, { value -> dimensions = dimensions.map { if (it.key == dimension.key) it.copy(label = value.take(60)) else it } }, Modifier.fillMaxWidth(), label = { Text("维度名称") })
            OutlinedTextField(dimension.weight, { value -> dimensions = dimensions.map { if (it.key == dimension.key) it.copy(weight = value) else it } }, Modifier.fillMaxWidth(), label = { Text("权重（0–100%）") })
            AssessmentCitationPicker(repository, projectId, dimension) { citations -> dimensions = dimensions.map { if (it.key == dimension.key) it.copy(citations = citations) else it } }
            TextButton({ dimensions = dimensions.filter { it.key != dimension.key } }, enabled = dimensions.size > 1) { Text("移除此维度") }
        } } } }
        TextButton({ dimensions = dimensions + AssessmentDimension() }, enabled = dimensions.size < 10) { Text("添加评分维度") }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button({ try { assessmentStandardBody(title, dimensions); onSave(title, dimensions, original) } catch (e: Exception) { error = e.message } }, enabled = !busy) { Text("保存并生效") }
        TextButton({ editing = false }) { Text("取消编辑") }
    }
    AssessmentChoice("历史标准（只读）", selectedHistory, history.map { it.text("standardsVersionId") to "${it.text("title")} · v${it.text("version")}" }) { selectedHistory = it }
    history.find { it.text("standardsVersionId") == selectedHistory }?.let { version -> version.obj("rubric").rows("weights").forEach { Text("${it.text("label")} · ${it.text("weight")}%") }; version.rows("requirements").forEach { Text(it.text("title")); it.rows("citations").forEach { c -> Text("引用：${c.text("quote")}") } } }
}

@Composable
private fun AssessmentCitationPicker(repository: ClientRepository, projectId: String, dimension: AssessmentDimension, onChange: (List<JsonObject>) -> Unit) {
    var open by remember { mutableStateOf(false) }; var sources by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var selected by remember { mutableStateOf("") }; var fragments by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var fragmentId by remember { mutableStateOf("") }; var quote by remember { mutableStateOf("") }; var error by remember { mutableStateOf<String?>(null) }
    val base = assessmentBase(projectId); val source = sources.find { it.text("sourceId") == selected }; val fragment = fragments.find { it.text("fragmentId") == fragmentId }
    LaunchedEffect(open) { if (open) try { sources = assessmentPages(repository, "$base/sources?limit=100") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    LaunchedEffect(selected) { fragments = emptyList(); fragmentId = ""; quote = ""; if (source != null) try { fragments = assessmentPages(repository, "$base/sources/${Uri.encode(selected)}/versions/${Uri.encode(source.text("currentVersionId"))}/fragments?limit=100") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    TextButton({ open = !open }) { Text("来源引用 · ${dimension.citations.size} 条") }
    if (open) {
        dimension.citations.forEachIndexed { index, citation -> Text(citation.text("quote")); TextButton({ onChange(dimension.citations.filterIndexed { n, _ -> n != index }) }) { Text("移除此引用") } }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        AssessmentChoice("引用资料", selected, sources.filter { it.text("currentVersionId").isNotBlank() }.map { it.text("sourceId") to it.text("title") }) { selected = it }
        AssessmentChoice("原文片段", fragmentId, fragments.mapIndexed { index, row -> row.text("fragmentId") to "${if (row.text("pageNumber").isBlank()) "正文" else "第 ${row.text("pageNumber")} 页"} · 片段 ${index + 1}" }) { fragmentId = it; quote = "" }
        fragment?.let { Text(it.text("content")); OutlinedTextField(quote, { v -> quote = v.take(2000) }, Modifier.fillMaxWidth(), label = { Text("节选评分项原文（含维度名及分值）") }) }
        Button({ onChange(dimension.citations + buildJsonObject { put("sourceVersionId", source!!.text("currentVersionId")); put("fragmentId", fragment!!.text("fragmentId")); put("pageNumber", fragment["pageNumber"] ?: JsonNull); put("quote", quote.trim()) }); quote = "" }, enabled = source != null && fragment != null && quote.isNotBlank() && fragment.text("content").contains(quote.trim()) && quote.contains(dimension.label) && Regex("[0-9]+(?:\\.[0-9]+)?\\s*(?:%|％|分|点)").containsMatchIn(quote) && dimension.citations.size < 10) { Text("绑定原文引用") }
    }
}

/** Legacy requirement sets cannot be created directly by the backend: they originate from source extraction or a standard. */
@Composable
internal fun AssessmentLegacyStandards(repository: ClientRepository, projectId: String, canEdit: Boolean, refresh: Int, onChanged: () -> Unit) {
    val base = assessmentBase(projectId); val scope = rememberCoroutineScope(); var open by remember { mutableStateOf(false) }; var sets by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var rubrics by remember { mutableStateOf<List<JsonObject>>(emptyList()) }; var error by remember { mutableStateOf<String?>(null) }; var selected by remember { mutableStateOf("") }; var edited by remember { mutableStateOf<JsonObject?>(null) }; var requirementTitle by remember { mutableStateOf("") }; var detail by remember { mutableStateOf("") }; var category by remember { mutableStateOf("other") }; var dueDate by remember { mutableStateOf("") }; var confirmation by remember { mutableStateOf<Pair<String, JsonObject?>?>(null) }
    var rubricEdit by remember { mutableStateOf<JsonObject?>(null) }; var rubricOpen by remember { mutableStateOf(false) }; var weights by remember { mutableStateOf(listOf(AssessmentDimension())) }; var notes by remember { mutableStateOf("") }; var busy by remember { mutableStateOf(false) }
    val owner = repository.accountId; val epoch = repository.epoch
    fun write(method: String, tail: String, body: JsonObject?) { if (busy) return; busy = true; scope.launch { try { check(repository.accountId == owner && repository.epoch == epoch); repository.requestDurably("legacy-standard:$projectId:$tail", method, base + tail, body); edited = null; rubricOpen = false; onChanged() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { busy = false } } }
    LaunchedEffect(open, refresh) { if (open) try { sets = assessmentPages(repository, "$base/requirement-sets"); rubrics = assessmentPages(repository, "$base/rubrics") } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } }
    TextButton({ open = !open }) { Text("要求集与独立评分标准") }
    if (open) {
        Text("要求集来自资料提取或项目标准；后端没有独立创建要求集接口。已确认或绑定到项目标准的版本不可修改。", style = MaterialTheme.typography.bodySmall)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        AssessmentChoice("要求集", selected, sets.mapIndexed { i, set -> set.text("requirementSetId") to "要求集 ${i + 1} · r${set.text("revision")} · ${set.text("status")}" }) { selected = it; edited = null }
        sets.find { it.text("requirementSetId") == selected }?.let { set ->
            set.rows("requirements").forEach { req -> Text(req.text("title"), style = MaterialTheme.typography.titleSmall); Text(req.text("detail")); Text("${req.text("category")} · ${req.text("dueDate")}"); req.rows("citations").forEach { Text("原文：${it.text("quote")}") }; if (canEdit && set.text("status") == "draft") TextButton({ edited = req; requirementTitle = req.text("title"); detail = req.text("detail"); category = req.text("category"); dueDate = req.text("dueDate") }) { Text("编辑要求") } }
            if (canEdit && set.text("status") == "draft") Button({ confirmation = "/requirement-sets/${Uri.encode(selected)}/confirm" to buildJsonObject { put("expectedRevision", set["revision"] ?: JsonPrimitive(1)) } }, enabled = !busy) { Text("确认要求集") }
        }
        edited?.let { req -> OutlinedTextField(requirementTitle, { requirementTitle = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("要求标题") }); OutlinedTextField(detail, { detail = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("要求说明") }); AssessmentChoice("分类", category, listOf("deadline" to "截止时间", "deliverable" to "交付成果", "format" to "格式", "scoring" to "评分", "team" to "团队", "other" to "其他")) { category = it }; OutlinedTextField(dueDate, { dueDate = it }, Modifier.fillMaxWidth(), label = { Text("截止日期 YYYY-MM-DD（可空）") }); Button({ write("PATCH", "/requirements/${Uri.encode(req.text("requirementId"))}", buildJsonObject { put("title", requirementTitle.trim()); put("detail", detail); put("category", category); put("dueDate", dueDate.takeIf { it.isNotBlank() }?.let(::JsonPrimitive) ?: JsonNull); put("duePrecision", if (dueDate.isBlank()) "unknown" else "date") }) }, enabled = !busy && requirementTitle.isNotBlank() && (dueDate.isBlank() || Regex("\\d{4}-\\d{2}-\\d{2}").matches(dueDate))) { Text("保存要求") } }
        rubrics.forEach { rubric -> Text("评分标准 v${rubric.text("version")} · ${rubric.text("status")}", style = MaterialTheme.typography.titleMedium); rubric.rows("weights").forEach { Text("${it.text("label")} · ${it.text("weight")}%") }; if (canEdit && rubric.text("status") == "draft") { TextButton({ rubricEdit = rubric; weights = rubric.rows("weights").map { AssessmentDimension(it.text("key"), it.text("label"), it.text("weight")) }; notes = rubric.text("notes"); rubricOpen = true }) { Text("编辑评分标准") }; TextButton({ confirmation = "/rubrics/${Uri.encode(rubric.text("rubricId"))}/confirm" to null }, enabled = !busy) { Text("确认评分标准") } } }
        if (canEdit) TextButton({ rubricEdit = null; weights = listOf(AssessmentDimension()); notes = ""; rubricOpen = true }) { Text("新建独立评分标准") }
        if (rubricOpen) {
            weights.forEach { dimension -> key(dimension.key) { OutlinedTextField(dimension.label, { v -> weights = weights.map { if (it.key == dimension.key) it.copy(label = v.take(60)) else it } }, Modifier.fillMaxWidth(), label = { Text("维度名称") }); OutlinedTextField(dimension.weight, { v -> weights = weights.map { if (it.key == dimension.key) it.copy(weight = v) else it } }, Modifier.fillMaxWidth(), label = { Text("权重（0–100）") }); TextButton({ weights = weights.filter { it.key != dimension.key } }, enabled = weights.size > 1) { Text("移除维度") } } }
            TextButton({ weights = weights + AssessmentDimension() }, enabled = weights.size < 10) { Text("添加维度") }; OutlinedTextField(notes, { notes = it.take(2000) }, Modifier.fillMaxWidth(), label = { Text("备注") })
            Button({ try { val body = assessmentStandardBody("评分标准", weights); write(if (rubricEdit == null) "POST" else "PATCH", "/rubrics" + (rubricEdit?.let { "/${Uri.encode(it.text("rubricId"))}" } ?: ""), buildJsonObject { put("weights", body["weights"]!!); put("notes", notes); if (rubricEdit == null) put("source", "custom") }) } catch (e: Exception) { error = e.message } }, enabled = !busy) { Text("保存评分标准草稿") }
        }
    }
    confirmation?.let { (tail, body) -> AlertDialog(onDismissRequest = { confirmation = null }, title = { Text("确认并锁定此版本？") }, text = { Text("确认后将不能继续编辑此要求集或评分版本。") }, confirmButton = { TextButton({ confirmation = null; write("POST", tail, body) }) { Text("确认") } }, dismissButton = { TextButton({ confirmation = null }) { Text("取消") } }) }
}

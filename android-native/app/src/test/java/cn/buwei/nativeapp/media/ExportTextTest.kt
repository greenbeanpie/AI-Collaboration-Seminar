package cn.buwei.nativeapp.media

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ExportTextTest {
    @Test fun docOnlyMaterialsKeepBodyLinksAndTablesInReadableExport(){
        val bundle=Json.parseToJsonElement("""{"materials":[{"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"original body","marks":[{"type":"link","attrs":{"href":"https://example.test/evidence"}}]}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"original cell"}]}]}]}]}]}}]}""")
        val text=exportText(bundle);listOf("original body","original cell","https://example.test/evidence").forEach{assertTrue(text.contains(it))}
    }
    @Test fun existingMarkdownRemainsTheExportBodyWithoutDuplicatingJsonFallback(){
        val bundle=Json.parseToJsonElement("""{"markdown":"existing markdown","doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"fallback body"}]}]}}""")
        val text=exportText(bundle);assertTrue(text.contains("existing markdown"));assertFalse(text.contains("fallback body"))
    }
}

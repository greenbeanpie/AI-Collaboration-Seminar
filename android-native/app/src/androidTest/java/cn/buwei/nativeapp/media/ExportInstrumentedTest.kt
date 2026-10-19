package cn.buwei.nativeapp.media

import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ExportInstrumentedTest {
    @Test fun nativePdfExportsChineseAndPaginatesWithoutWebRendering() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val file=File.createTempFile("native-export-",".pdf",context.cacheDir)
        try {
            writeExportPdf((1..100).joinToString("\n"){"项目成果第 $it 项：中文内容与任务验收记录"},file)
            ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY).use {fd->PdfRenderer(fd).use {assertTrue(it.pageCount>=2)}}
            assertTrue(file.length()>1000)
        }finally{file.delete()}
    }
    @Test fun exportKeepsBusinessTextAndOriginalIdentifiersInCompleteData() {
        val json=buildJsonObject {put("project",buildJsonObject {put("name","中文项目")});put("tasks",buildJsonArray {add(buildJsonObject {put("taskId","stable-task");put("detail","原始正文")})})}
        val text=exportText(json)
        assertTrue(text.contains("中文项目"));assertTrue(text.contains("原始正文"));assertTrue(text.contains("stable-task"))
    }
}

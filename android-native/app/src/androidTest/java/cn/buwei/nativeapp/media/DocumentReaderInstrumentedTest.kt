package cn.buwei.nativeapp.media

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@RunWith(AndroidJUnit4::class)
class DocumentReaderInstrumentedTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    private val p="http://schemas.openxmlformats.org/presentationml/2006/main"
    private val a="http://schemas.openxmlformats.org/drawingml/2006/main"
    private fun archive(extension:String,parts:Map<String,String>):File {
        val file=File.createTempFile("office-fixture-", ".$extension",context.cacheDir)
        ZipOutputStream(file.outputStream()).use { zip->
            (mapOf("[Content_Types].xml" to "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>")+parts).forEach {(name,text)->zip.putNextEntry(ZipEntry(name));zip.write(text.toByteArray());zip.closeEntry()}
        }
        return file
    }
    private fun relation(id:String,type:String,target:String)="<Relationship Id=\"$id\" Type=\"$r/$type\" Target=\"$target\"/>"
    private fun rels(vararg values:String)="<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">${values.joinToString("")}</Relationships>"
    private fun paragraph(text:String)="<a:p><a:r><a:t>$text</a:t></a:r></a:p>"
    @Test fun presentationUsesQualifiedRelationshipIdsAndIncludesNotes()=runBlocking {
        val file=archive("pptx",mapOf(
            "ppt/presentation.xml" to "<p:presentation xmlns:p=\"$p\" xmlns:r=\"$r\"><p:sldIdLst><p:sldId r:id=\"slide-r\" id=\"256\"/></p:sldIdLst></p:presentation>",
            "ppt/_rels/presentation.xml.rels" to rels(relation("slide-r","slide","slides/slide7.xml")),
            "ppt/slides/slide7.xml" to "<p:sld xmlns:p=\"$p\" xmlns:a=\"$a\" show=\"0\"><p:spTree><p:sp>${paragraph("正文 &amp; 内容")}</p:sp></p:spTree></p:sld>",
            "ppt/slides/_rels/slide7.xml.rels" to rels(relation("notes-r","notesSlide","../notesSlides/notes2.xml")),
            "ppt/notesSlides/notes2.xml" to "<p:notes xmlns:p=\"$p\" xmlns:a=\"$a\"><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"body\"/></p:nvPr></p:nvSpPr>${paragraph("讲稿内容")}</p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type=\"sldNum\"/></p:nvPr></p:nvSpPr>${paragraph("999")}</p:sp></p:notes>"
        ))
        try {
            val blocks=mutableListOf<DocumentBlock>();val result=DocumentReader.read(context,file){blocks+=it}
            assertNull(result.pages);assertTrue(blocks.all {it.page==null})
            assertEquals(listOf("正文 & 内容","讲稿内容"),blocks.map {it.text})
            assertTrue(blocks[0].headingPath[0].contains("隐藏"));assertEquals("演讲备注",blocks[1].headingPath[1])
            assertTrue(result.warnings.any {it.contains("隐藏幻灯片")})
        } finally {file.delete()}
    }
    @Test fun spreadsheetPreservesSparseAddressesDatesFormulaWarningsAndHiddenLabels()=runBlocking {
        val file=archive("xlsx",mapOf(
            "xl/workbook.xml" to "<workbook xmlns:r=\"$r\"><sheets><sheet name=\"财务\" sheetId=\"1\" r:id=\"sheet-r\" state=\"hidden\"/></sheets></workbook>",
            "xl/_rels/workbook.xml.rels" to rels(relation("sheet-r","worksheet","worksheets/sheet8.xml")),
            "xl/styles.xml" to "<styleSheet><cellXfs><xf numFmtId=\"0\"/><xf numFmtId=\"14\"/></cellXfs></styleSheet>",
            "xl/sharedStrings.xml" to "<sst><si><r><t>姓名 &amp; 角色</t></r><rPh><t>不应导入的拼音</t></rPh></si></sst>",
            "xl/worksheets/sheet8.xml" to "<worksheet><sheetData><row r=\"7\" hidden=\"1\"><c r=\"A7\" t=\"s\"><v>0</v></c><c r=\"D7\" s=\"1\"><v>45292</v></c><c r=\"F7\"><f>A1+1</f></c><c r=\"G7\"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>"
        ))
        try {
            val blocks=mutableListOf<DocumentBlock>();val result=DocumentReader.read(context,file){blocks+=it}
            assertNull(result.pages);assertTrue(blocks.all {it.page==null})
            assertEquals(listOf("A7（隐藏行／列）","D7（隐藏行／列）","F7（隐藏行／列）","G7（隐藏行／列）"),blocks.map {it.headingPath[1]})
            assertEquals("姓名 & 角色",blocks[0].text);assertEquals("2024-01-01",blocks[1].text)
            assertTrue(blocks[2].text.contains("无已保存结果"));assertEquals("3",blocks[3].text)
            assertTrue(result.warnings.any {it.contains("缓存值可能过期")});assertTrue(result.warnings.any {it.contains("隐藏工作表")})
        } finally {file.delete()}
    }
    @Test fun docxTablesRetainCellLocationsAndEmptyBodyWarns()=runBlocking {
        val file=archive("docx",mapOf("word/document.xml" to "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>"))
        try {
            val blocks=mutableListOf<DocumentBlock>();DocumentReader.read(context,file){blocks+=it}
            assertEquals(listOf("名称","数量"),blocks.map {it.text})
            assertEquals("行 1 列 1",blocks[0].headingPath.last());assertEquals("行 1 列 2",blocks[1].headingPath.last())
        } finally {file.delete()}
        val empty=archive("docx",mapOf("word/document.xml" to "<document><body/></document>"))
        try {assertTrue(DocumentReader.read(context,empty){}.warnings.any {it.contains("未提取到")})}finally{empty.delete()}
    }
    @Test fun missingRequiredPartsAndDoctypeFailExplicitly()=runBlocking {
        for(parts in listOf(emptyMap(),mapOf("word/document.xml" to "<!DOCTYPE document [<!ENTITY secret SYSTEM 'file:///private'>]><document>&secret;</document>"))) {
            val file=archive("docx",parts)
            try {
                try {DocumentReader.read(context,file){};fail("Malformed OOXML was accepted")}catch(expected:Exception){assertTrue(expected.message.orEmpty().isNotBlank())}
            } finally {file.delete()}
        }
    }
    @Test fun blankPdfPageStillEmitsCoverageBlock()=runBlocking {
        PDFBoxResourceLoader.init(context)
        val file=File.createTempFile("blank-", ".pdf",context.cacheDir)
        try {
            PDDocument().use {it.addPage(PDPage());it.save(file)}
            val blocks=mutableListOf<DocumentBlock>();val result=DocumentReader.read(context,file){blocks+=it}
            assertEquals(1,result.pages);assertEquals(1,blocks.size);assertEquals(1,blocks.single().page);assertTrue(blocks.single().text.isBlank())
            assertTrue(result.warnings.any {it.contains("没有可提取正文")})
        } finally {file.delete()}
    }
}

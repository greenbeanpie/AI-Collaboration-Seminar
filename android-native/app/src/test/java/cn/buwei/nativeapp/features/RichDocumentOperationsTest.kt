package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RichDocumentOperationsTest {
    private fun objectOf(value:String)=Json.parseToJsonElement(value).jsonObject
    @Test fun rangeFormattingSplitsOnlySelectedTextAndPreservesExistingMarksAndUnknownMetadata() {
        val text=objectOf("""{"type":"text","text":"before selection after","marks":[{"type":"futureMark","attrs":{"retain":true}}],"opaque":{"retain":1}}""")
        val parts=richMarkRange(text,7,16,"bold")
        assertEquals(listOf("before ","selection"," after"),parts.map{it.text("text")})
        parts.forEach{assertEquals(text["opaque"],it["opaque"]);assertTrue(it["marks"]!!.jsonArray.contains(text["marks"]!!.jsonArray[0]))}
        assertTrue(parts[1]["marks"]!!.jsonArray.any{it.jsonObject.text("type")=="bold"})
        assertEquals(text["marks"],parts[0]["marks"])
    }
    @Test fun unlinkNeverAddsAnEmptyLinkAndPreservesOtherMarks() {
        val text=objectOf("""{"type":"text","text":"linked","marks":[{"type":"bold"},{"type":"link","attrs":{"href":"https://example.test"}}]}""")
        assertEquals(buildJsonArray{add(buildJsonObject{put("type","bold")})},richMarkRange(text,0,6,"link",remove=true).single()["marks"])
        val plain=objectOf("""{"type":"text","text":"plain"}""")
        assertEquals(JsonArray(emptyList()),richMarkRange(plain,0,5,"link",remove=true).single()["marks"])
    }
    @Test fun structuralMovesAndNewTableKeepReferenceAndUnknownBlocksUnchanged() {
        val reference=objectOf("""{"type":"citation","attrs":{"sourceVersionId":"fixed"}}""")
        val unknown=objectOf("""{"type":"futureNode","opaque":{"x":true}}""")
        val doc=richNode("doc",listOf(richParagraph("A"),reference,unknown))
        val moved=richMoveChild(doc,2,-1)
        assertEquals(listOf(richChildren(doc)[0],unknown,reference),richChildren(moved))
        val table=richTableAddRow(richTableAddColumn(richBlock("table")))
        assertEquals(4,richChildren(table).size);richChildren(table).forEach{assertEquals(4,richChildren(it).size)}
    }
    @Test fun removingAllLeafTextProducesValidEmptyParagraphRatherThanEmptyTextNode() {
        val doc=richNode("doc",listOf(richParagraph("delete")))
        val edited=editRichText(doc,listOf(0,0),"")
        assertTrue(richChildren(richChildren(edited)[0]).isEmpty())
    }
    @Test fun selectionFormatWithinTableRetainsCellSpanAndUnselectedSibling() {
        val text=objectOf("""{"type":"text","text":"hello world"}""")
        val cell=richNode("tableCell",listOf(richNode("paragraph",listOf(text))),objectOf("""{"colspan":2,"future":"retain"}"""))
        val doc=richNode("doc",listOf(richNode("table",listOf(richNode("tableRow",listOf(cell)))),richParagraph("outside")))
        val edited=richFormatSelection(doc,listOf(0,0,0,0,0),0,5,"italic")
        assertEquals(richChildren(doc)[1],richChildren(edited)[1])
        assertEquals(cell["attrs"],richChildren(richChildren(richChildren(edited)[0])[0])[0]["attrs"])
    }
}

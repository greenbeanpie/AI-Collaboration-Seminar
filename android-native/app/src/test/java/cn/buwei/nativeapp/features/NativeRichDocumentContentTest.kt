package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeRichDocumentContentTest {
    private fun doc(value:String)=Json.parseToJsonElement(value).jsonObject
    private fun text(blocks:List<NativeMarkdownBlock>)=blocks.joinToString(""){block->block.code+block.inline.joinToString(""){it.text}}
    @Test fun richTextRetainsSimultaneousMarksAndLiteralSyntaxWithoutReparsing(){
        val node=doc("""{"type":"paragraph","content":[{"type":"text","text":"**literal**","marks":[{"type":"bold"},{"type":"italic"},{"type":"strike"},{"type":"underline"},{"type":"code"},{"type":"link","attrs":{"href":"/app/profile"}}]},{"type":"hardBreak"},{"type":"text","text":"next"}]}""")
        val runs=nativeRichDocumentInline(node);val first=runs.first()
        assertEquals("**literal**",first.text);assertTrue(first.bold&&first.italic&&first.strike&&first.underline&&first.code);assertEquals("/app/profile",first.href)
        assertEquals("**literal**\nnext",runs.joinToString(""){it.text})
    }
    @Test fun tableBoundariesHeadersMergedCellsAndSeparateParagraphsRemainVisible(){
        val node=doc("""{"type":"doc","content":[{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":2,"rowspan":3},"content":[{"type":"paragraph","content":[{"type":"text","text":"Head"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]},{"type":"paragraph","content":[{"type":"text","text":"two","marks":[{"type":"italic"}]}]}]}]}]}]}""")
        val blocks=nativeRichDocumentBlocks(node)
        assertTrue(text(blocks).contains("合并 2 列、合并 3 行"));assertTrue(text(blocks).contains("第 2 行"));assertTrue(text(blocks).contains("one\ntwo"));assertTrue(blocks.flatMap{it.inline}.single{it.text=="Head"}.bold);assertTrue(blocks.flatMap{it.inline}.single{it.text=="two"}.italic)
    }
    @Test fun nestedListsRespectOrderedStartAndNestedItemIndent(){
        val node=doc("""{"type":"doc","content":[{"type":"orderedList","attrs":{"start":7},"content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"outer"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"nested"}]}]}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}]}]}""")
        val blocks=nativeRichDocumentBlocks(node);assertEquals(listOf("7.","•","8."),blocks.map{it.marker});assertEquals(listOf(0,1,0),blocks.map{it.depth});assertEquals("outernestedsecond",text(blocks))
    }
    @Test fun deepUnknownWrappersAndUnsupportedLeavesAreNotSilentlyDiscarded(){
        var node=doc("""{"type":"text","text":"deep retained text"}""")
        repeat(120){node=buildJsonObject{put("type","futureContainer");put("content",JsonArray(listOf(node)))}}
        assertEquals("deep retained text",text(nativeRichDocumentBlocks(node)))
        assertTrue(text(nativeRichDocumentBlocks(doc("""{"type":"futureMedia","opaque":{"keep":true}}"""))).contains("原始内容仍保留"))
    }
    @Test fun citationsRetainFixedVersionQuoteAndLocationAndImagesDoNotLoadRemoteTracking(){
        val node=doc("""{"type":"doc","content":[{"type":"sourceCitation","attrs":{"title":"Evidence","sourceVersionId":"fixed-v3","locator":"page 9","quote":"original quote","href":"javascript:alert(1)"}},{"type":"image","attrs":{"alt":"chart","src":"https://tracker.test/pixel"}}]}""")
        val blocks=nativeRichDocumentBlocks(node);val rendered=text(blocks)
        listOf("Evidence","fixed-v3","page 9","original quote","chart").forEach{assertTrue(rendered.contains(it))}
        assertFalse(rendered.contains("tracker.test"));assertNull(nativeMarkdownHref(blocks.flatMap{it.inline}.first().href!!))
    }
    @Test fun longCodeAndStyledParagraphsHaveFiniteChunksWithoutLosingSurrogatePairs(){
        val body="内容🙂".repeat(5000);val node=buildJsonObject{put("type","paragraph");put("content",buildJsonArray{add(buildJsonObject{put("type","text");put("text",body);put("marks",buildJsonArray{add(buildJsonObject{put("type","bold")})})})})}
        val blocks=nativeRichDocumentBlocks(node);assertTrue(blocks.size>1);assertEquals(body,text(blocks));assertTrue(blocks.flatMap{it.inline}.all{it.bold&&it.text.length<=4000&&!it.text.last().isHighSurrogate()})
        val code=buildJsonObject{put("type","codeBlock");put("attrs",buildJsonObject{put("language","kotlin")});put("content",buildJsonArray{add(buildJsonObject{put("type","text");put("text","  **literal**\n$body")})})}
        assertEquals("  **literal**\n$body",text(nativeRichDocumentBlocks(code)));assertTrue(nativeRichDocumentBlocks(code).all{it.kind=="code"&&it.language=="kotlin"})
    }
}

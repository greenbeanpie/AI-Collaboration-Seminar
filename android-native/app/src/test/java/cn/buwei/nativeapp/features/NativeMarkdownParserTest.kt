package cn.buwei.nativeapp.features

import org.junit.Assert.*
import org.junit.Test

class NativeMarkdownParserTest {
 private fun plain(runs:List<NativeMarkdownInline>)=runs.joinToString(""){it.text}
 @Test fun nestedBoldAndItalicRenderWithoutShowingMarkdownDelimiters(){
  val runs=parseNativeMarkdownInline("开始 **bold and *nested italic***，以及 *italic **nested bold*** / ~~旧稿~~。")
  assertEquals("开始 bold and nested italic，以及 italic nested bold / 旧稿。",plain(runs))
  assertTrue(runs.any{it.text=="nested italic"&&it.bold&&it.italic});assertTrue(runs.any{it.text=="nested bold"&&it.bold&&it.italic});assertTrue(runs.any{it.text=="旧稿"&&it.strike})
 }
 @Test fun backtickSpansProtectFormattingAndSupportLiteralBackticks(){
  val runs=parseNativeMarkdownInline("Use `**literal** | code` and ``a `quoted` value`` with **real bold**.")
  assertTrue(runs.any{it.code&&it.text=="**literal** | code"&&!it.bold});assertTrue(runs.any{it.code&&it.text=="a `quoted` value"});assertTrue(runs.any{it.bold&&it.text=="real bold"})
 }
 @Test fun escapedSyntaxAndMalformedTextStayReadable(){assertEquals("*literal* and foo_bar_baz",plain(parseNativeMarkdownInline("\\*literal\\* and foo_bar_baz")));assertEquals("Unclosed **markup [link",plain(parseNativeMarkdownInline("Unclosed **markup [link")))}
 @Test fun chineseAndEnglishLinkLabelsRetainNestedMarksAndDestinations(){
  val runs=parseNativeMarkdownInline("[**项目**与*report*](https://example.com/中文?q=1) and [Docs](/app/support/help?doc=user)")
  assertEquals("项目与report and Docs",plain(runs));assertTrue(runs.any{it.bold&&it.text=="项目"&&it.href=="https://example.com/中文?q=1"});assertTrue(runs.any{it.italic&&it.text=="report"});assertEquals("/app/support/help?doc=user",runs.last().href)
 }
 @Test fun balancedParenthesesRemainPartOfLinkUrl(){val runs=parseNativeMarkdownInline("[Guide](https://example.com/path_(guide))");assertEquals("https://example.com/path_(guide)",runs.single().href);assertEquals("Guide",plain(runs))}
 @Test fun tablePipesInsideEscapedTextOrCodeDoNotCreateExtraCells(){
  val rows=parseNativeMarkdown("| 列一 | Details |\n| --- | :---: |\n| **值** \\| 保留 | `a|b` |")
  val row=rows.first{it.kind=="table-row"};assertEquals(2,row.cells.size);assertEquals("值 | 保留",plain(row.cells[0]));assertEquals("a|b",plain(row.cells[1]));assertTrue(row.cells[1].single().code);assertTrue(row.cells[0].any{it.bold});assertEquals(listOf("列一","Details"),row.headers.map(::plain))
 }
 @Test fun headerOnlyTablesKeepTheirColumnNames(){val blocks=parseNativeMarkdown("| Name | Value |\n| --- | --- |");assertEquals(listOf("Name","Value"),blocks.single().cells.map(::plain))}
 @Test fun quotesListsHeadingsAndRulesHaveNativeBlockSemantics(){val blocks=parseNativeMarkdown("## **标题**\n\n> 引用 *事实*\n\n3. 第三步\n4. 第四步\n  - 子项\n\n---");assertEquals(listOf("heading","quote","list","list","list","rule"),blocks.map{it.kind});assertEquals(2,blocks[0].level);assertEquals("3.",blocks[2].marker);assertEquals(1,blocks[4].depth);assertTrue(blocks[1].inline.any{it.italic})}
 @Test fun fencedCodeKeepsIndentationAndLiteralHtml(){val blocks=parseNativeMarkdown("```sql\nSELECT **literal**, id\n  FROM jobs;\n<script>literal</script>\n```");assertEquals("SELECT **literal**, id\n  FROM jobs;\n<script>literal</script>",blocks.single().code);assertEquals("sql",blocks.single().language)}
 @Test fun largeTextAndCodeAreSplitWithoutLosingCharactersOrSurrogatePairs(){val body="**"+"项目🙂".repeat(5000)+"**";val blocks=parseNativeMarkdown(body);assertTrue(blocks.size>1);assertEquals("项目🙂".repeat(5000),blocks.flatMap{it.inline}.joinToString(""){it.text});assertTrue(blocks.flatMap{it.inline}.all{it.bold&&it.text.length<=4000&&!it.text.last().isHighSurrogate()});val code="  x🙂 = "+"value ".repeat(3000);assertEquals(code,parseNativeMarkdown("```\n$code\n```").joinToString(""){it.code})}
 @Test fun largeTableCellsAreFiniteChunksWithoutContentLoss(){val value="文字🙂".repeat(3000);val rows=parseNativeMarkdown("| A | B |\n| --- | --- |\n| $value | preserved |");val body=rows.filter{it.kind=="table-row"};assertTrue(body.size>1);assertEquals(value+"preserved",body.flatMap{it.cells}.flatten().joinToString(""){it.text});assertTrue(body.all{row->row.cells.size<=4&&row.cells.flatten().sumOf{it.text.length}<=4000})}
 @Test fun urlPolicyAllowsOnlyTrustedBrowserProtocolsOrAppRoutes(){listOf("javascript:alert(1)","data:text/html,evil","file:///private","https://user:pass@example.com/","//evil.example/","/app/%2e%2e/api/secrets","/app/%5cevil").forEach{assertNull(nativeMarkdownHref(it))};assertEquals("https://example.com/%E4%B8%AD%E6%96%87",nativeMarkdownHref("https://example.com/中文"));assertEquals("/app/projects/example/tasks",nativeMarkdownHref("/app/projects/example/tasks"));assertNotNull(nativeMarkdownHref("https://例子.测试/文档"))}
 @Test fun longUnmatchedDelimiterRunsRemainLiteralWithoutCharacterLoss(){val ticks="before "+"`".repeat(12000)+" after";assertEquals(ticks,plain(parseNativeMarkdownInline(ticks)));val stars="before "+"*".repeat(12000)+" after";assertEquals(stars,plain(parseNativeMarkdownInline(stars)))}
 @Test fun imageSyntaxAndBareUrlsNeverTriggerImageRequests(){val runs=parseNativeMarkdownInline("![tracking](https://evil.example/pixel) https://example.com/path");assertTrue(plain(runs).contains("![tracking](https://evil.example/pixel)"));assertTrue(runs.any{it.text=="https://example.com/path"&&it.href==it.text})}
}

package cn.buwei.nativeapp.features

import org.junit.Assert.*
import org.junit.Test

class DataWorkspaceDiffTest {
 @Test fun identicalContentHasNoDifference(){assertTrue(dataWorkspaceDiff("同一原文","同一原文").isEmpty())}
 @Test fun addedAndRemovedLinesRemainVisible(){val result=dataWorkspaceDiff("标题\n旧证据\n结尾","标题\n新证据\n结尾");assertTrue(result.any{it.kind=="-"&&it.text.contains("旧证据")});assertTrue(result.any{it.kind=="+"&&it.text.contains("新证据")});assertEquals(2,result.count{it.kind=="="})}
 @Test fun distantInsertionDoesNotDropDocumentTail(){val before=(1..1000).joinToString("\n"){"原文$it"};val after="新增开头\n$before\n新增结尾";val result=dataWorkspaceDiff(before,after);assertTrue(result.any{it.kind=="+"&&it.text.contains("新增开头")});assertTrue(result.any{it.kind=="+"&&it.text.contains("新增结尾")});assertTrue(result.none{it.kind=="-"})}
 @Test fun emptySideStillShowsAllChangedLines(){assertEquals(3,dataWorkspaceDiff("","a\nb").count{it.kind!="="});assertTrue(dataWorkspaceDiff("a\nb","").any{it.kind=="-"&&it.text.endsWith("b")})}
}

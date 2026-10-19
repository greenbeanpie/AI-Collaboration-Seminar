package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DataDocumentParityTest {
 private fun version(text:String,underline:Boolean=false)=buildJsonObject {put("markdown","same lossy export");put("doc",buildJsonObject{put("type","doc");put("content",buildJsonArray{add(buildJsonObject{put("type","paragraph");put("content",buildJsonArray{add(buildJsonObject{put("type","text");put("text",text);if(underline)put("marks",buildJsonArray{add(buildJsonObject{put("type","underline")})})})})})})})}
 @Test fun canonicalTextChangeIsComparedEvenWhenMarkdownIsUnchanged(){
  val comparison=dataWorkspaceVersionComparison(version("before"),version("after"))
  assertTrue(comparison.lines.any{it.kind=="-"&&it.text.contains("before")});assertTrue(comparison.lines.any{it.kind=="+"&&it.text.contains("after")})
 }
 @Test fun formattingOnlyChangeIsNotCalledIdentical(){
  val comparison=dataWorkspaceVersionComparison(version("same"),version("same",true))
  assertTrue(comparison.lines.isEmpty());assertTrue(comparison.structureChanged)
 }
 @Test fun unchangedCanonicalDocumentsIgnoreObsoleteMarkdown(){
  val original=version("same");val comparison=dataWorkspaceVersionComparison(original,JsonObject(original+("markdown" to JsonPrimitive("unrelated stale export"))))
  assertTrue(comparison.lines.isEmpty());assertFalse(comparison.structureChanged)
 }
 @Test fun codeBlockTextRemainsPartOfComparison(){
  fun code(value:String)=buildJsonObject{put("doc",buildJsonObject{put("type","doc");put("content",buildJsonArray{add(buildJsonObject{put("type","codeBlock");put("content",buildJsonArray{add(buildJsonObject{put("type","text");put("text",value)})})})})})}
  val comparison=dataWorkspaceVersionComparison(code("old code"),code("new code"));assertTrue(comparison.lines.any{it.text.contains("new code")})
 }
 @Test fun legacyMarkdownStillComparesWhenCanonicalDocumentsAreAbsent(){
  val comparison=dataWorkspaceVersionComparison(buildJsonObject{put("markdown","old")},buildJsonObject{put("markdown","new")});assertEquals(listOf("-","+"),comparison.lines.map{it.kind})
 }
}

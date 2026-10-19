package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import cn.buwei.nativeapp.NativeTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class NativeMarkdownContentInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 @Test fun nativeTextActuallyReceivesNestedStylesAndKeepsCodeAndTableLiteralContent(){
  val markdown="## 展示样本\n\n**Bold *嵌套*** and ~~old~~ [官网](https://example.com/中文)\n\n> 引用 **事实**\n\n| 列 | Value |\n| --- | --- |\n| 内容 | `a|b` |\n\n```sql\n  SELECT **literal** | raw;\n  保留缩进\n```"
  compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){NativeMarkdownContent(markdown)}}}}
  val formatted=compose.onNodeWithText("Bold 嵌套 and old",substring=true);formatted.performScrollTo().assertIsDisplayed()
  val text=formatted.fetchSemanticsNode().config[SemanticsProperties.Text].single()
  assertFalse(text.text.contains("**"));assertTrue(text.spanStyles.any{it.item.fontWeight==FontWeight.Bold});assertTrue(text.spanStyles.any{it.item.fontStyle==FontStyle.Italic});assertTrue(text.spanStyles.any{it.item.textDecoration==TextDecoration.LineThrough});assertTrue(text.text.contains("https://example.com/中文"))
  compose.onNodeWithText("a|b").performScrollTo().assertIsDisplayed();compose.onNodeWithText("  SELECT **literal** | raw;\n  保留缩进").performScrollTo().assertIsDisplayed()
 }
 @Test fun finiteRenderingCanRevealEveryLaterParagraphWithoutTruncating(){
  val markdown=(1..50).joinToString("\n\n"){"完整段落 $it"}
  compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){NativeMarkdownContent(markdown)}}}}
  compose.onNodeWithText("完整段落 50").assertDoesNotExist()
  repeat(3){compose.onNodeWithText("显示后续内容",substring=true).performScrollTo().performClick()}
  compose.onNodeWithText("完整段落 50").performScrollTo().assertIsDisplayed();compose.onNodeWithText("完整段落 1").performScrollTo().assertIsDisplayed();compose.onNodeWithText("显示后续内容",substring=true).assertDoesNotExist()
 }
 @Test fun appLinkInvokesOnlyProvidedNativeNavigationCallback(){
  val path=AtomicReference<String?>(null)
  compose.setContent{NativeTheme{Surface{NativeMarkdownContent("[资料](/app/profile)"){path.set(it)}}}}
  val link=compose.onNodeWithText("资料（/app/profile）");val layouts=mutableListOf<TextLayoutResult>()
  link.performSemanticsAction(SemanticsActions.GetTextLayoutResult){action->assertTrue(action(layouts))};val firstCharacter=layouts.single().getBoundingBox(0)
  link.performTouchInput{click(firstCharacter.center)};compose.runOnIdle{assertEquals("/app/profile",path.get())}
 }
}

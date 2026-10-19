package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import cn.buwei.nativeapp.NativeTheme
import androidx.test.espresso.Espresso.closeSoftKeyboard
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class HelpWorkspaceInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 @Test fun nativeHelpFiltersChaptersClearsSearchAndOpensSupport(){
  val destination=AtomicReference<String?>(null)
  compose.setContent{NativeTheme{Surface(Modifier.fillMaxSize()){HelpWorkspace{destination.set(it)}}}}
  compose.waitUntil(15000){compose.onAllNodesWithText("当前章节：1. 登录与个人设置（1/10）").fetchSemanticsNodes().isNotEmpty()||compose.onAllNodesWithText("下一章").fetchSemanticsNodes().isNotEmpty()}
  val list=compose.onNode(hasScrollToIndexAction())
  list.performScrollToNode(hasText("搜索当前文档，如：任务、版本"))
  compose.onNodeWithText("搜索当前文档，如：任务、版本").performTextInput("missing-native-help-keyword-12345")
  closeSoftKeyboard();compose.waitForIdle()
  list.performScrollToNode(hasText("未找到相关章节"));compose.onNodeWithText("未找到相关章节").assertIsDisplayed()
  list.performScrollToNode(hasText("清除搜索"));compose.onNodeWithText("清除搜索").performClick();compose.waitForIdle()
  list.performScrollToNode(hasText("下一章"));compose.onNodeWithText("下一章").assertIsDisplayed()
  list.performScrollToNode(hasText("仍有疑问？提交支持工单"));compose.onNodeWithText("仍有疑问？提交支持工单").performClick();assertEquals("support",destination.get())
 }
}

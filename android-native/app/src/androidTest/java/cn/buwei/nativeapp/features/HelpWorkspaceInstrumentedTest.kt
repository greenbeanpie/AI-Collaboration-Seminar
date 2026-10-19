package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import cn.buwei.nativeapp.NativeTheme
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
  compose.onNodeWithText("搜索当前文档，如：任务、版本").performTextInput("missing-native-help-keyword-12345")
  compose.waitUntil(15000){compose.onAllNodesWithText("未找到相关章节").fetchSemanticsNodes().isNotEmpty()};compose.onNodeWithText("清除搜索").performScrollTo().performClick()
  compose.onNodeWithText("仍有疑问？提交支持工单").performScrollTo().performClick();assertEquals("support",destination.get())
 }
}

package cn.buwei.nativeapp.features

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import cn.buwei.nativeapp.NativeTheme
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference
import java.io.File

class NativeRichDocumentContentInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    @Test fun structuredBodyWinsOverLossyMarkdownAndActuallyDisplaysStyledTableCells(){
        val value=Json.parseToJsonElement("""{"markdown":"lossy old markdown","doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"styled body","marks":[{"type":"bold"},{"type":"underline"}]}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"Header"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"preserved cell"}]}]}]}]}]}}""")
        compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){StructuredValue(value)}}}}
        compose.onNodeWithText("lossy old markdown").assertDoesNotExist()
        val text=compose.onNodeWithText("styled body").fetchSemanticsNode().config[SemanticsProperties.Text].single()
        assertTrue(text.spanStyles.any{it.item.fontWeight==FontWeight.Bold&&it.item.textDecoration==TextDecoration.Underline})
        compose.onNodeWithText("Header").performScrollTo().assertIsDisplayed();compose.onNodeWithText("preserved cell").performScrollTo().assertIsDisplayed()
        val output=File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),"native-rich-document.png")
        output.outputStream().use{compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
    }
    @Test fun commonWorkspaceNavigationOpensRichAndMarkdownLinksThroughTheSameNativeCallback(){
        val path=AtomicReference<String?>(null)
        val node=Json.parseToJsonElement("""{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Account","marks":[{"type":"link","attrs":{"href":"/app/profile"}}]}]}]}""").jsonObject
        compose.setContent{NativeTheme{Surface{CompositionLocalProvider(LocalNativeContentNavigation provides {path.set(it)}){Column{ReadOnlyRichDocument(node);NativeMarkdown("[Support](/app/support)")}}}}}
        fun clickLink(label:String){val link=compose.onNodeWithText(label);val layouts=mutableListOf<TextLayoutResult>();link.performSemanticsAction(SemanticsActions.GetTextLayoutResult){assertTrue(it(layouts))};link.performTouchInput{click(layouts.single().getBoundingBox(0).center)}}
        clickLink("Account（/app/profile）");compose.runOnIdle{assertEquals("/app/profile",path.get())}
        clickLink("Support（/app/support）");compose.runOnIdle{assertEquals("/app/support",path.get())}
    }
    @Test fun longDocumentsCanRevealFinalParagraphWithoutNestedScrollOrTruncation(){
        val node=buildJsonObject{put("type","doc");put("content",buildJsonArray{repeat(35){index->add(richParagraph("完整正文 ${index+1}"))}})}
        compose.setContent{NativeTheme{Surface{Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())){ReadOnlyRichDocument(node)}}}}
        compose.onNodeWithText("完整正文 35").assertDoesNotExist();repeat(2){compose.onNodeWithText("显示后续内容",substring=true).performScrollTo().performClick()}
        compose.onNodeWithText("完整正文 35").performScrollTo().assertIsDisplayed();compose.onNodeWithText("完整正文 1").performScrollTo().assertIsDisplayed()
    }
}

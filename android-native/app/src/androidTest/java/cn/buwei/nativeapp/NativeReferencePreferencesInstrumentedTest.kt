package cn.buwei.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.data.ClientRepository
import cn.buwei.nativeapp.features.ProjectSettingsWorkspace
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import org.junit.*
import org.junit.Assert.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

class NativeReferencePreferencesInstrumentedTest {
    @get:Rule val compose=createComposeRule()
    @Test fun failedSaveKeepsTemporaryChoiceAndReportsFailure() {
        compose.setContent { NativeTheme { NativeReferencePreferenceContent("a",{flowOf(true)},{throw IOException("fixture")}) { NativeAppearanceSettings("system"){} } } }
        compose.onNode(isToggleable()).performScrollTo().performClick()
        compose.onNodeWithText("已在当前页面生效，但本机未能保存此偏好。").performScrollTo().assertIsDisplayed()
        compose.onNode(isToggleable()).assertIsOff()
    }
    @Test fun switchingAccountNeverUsesPreviousAccountsChoice() {
        val preferences=AppearancePreferences(InstrumentationRegistry.getInstrumentation().targetContext)
        val a=UUID.randomUUID().toString();val b=UUID.randomUUID().toString()
        runBlocking {preferences.setReferenceBadges(a,false);preferences.setReferenceBadges(b,true)}
        val owner=mutableStateOf(a)
        compose.setContent { NativeTheme { NativeReferencePreferences(preferences,owner.value) { Text(if(LocalReferenceBadges.current.visible)"visible"else"hidden");NativeAiReferenceBadge() } } }
        compose.waitUntil(5000){compose.onAllNodesWithText("hidden").fetchSemanticsNodes().isNotEmpty()}
        compose.runOnIdle {owner.value=b}
        compose.waitUntil(5000){compose.onAllNodesWithText("visible").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithText("AI 会引用").assertExists()
        compose.runOnIdle {owner.value=a}
        compose.waitUntil(5000){compose.onAllNodesWithText("hidden").fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithText("AI 会引用").assertDoesNotExist()
    }
    @Test fun hidingBadgesOnNarrowScreenDoesNotWriteProjectOrChangeFields() {
        val writes=AtomicInteger();val user=UUID.randomUUID().toString();val project=UUID.randomUUID().toString()
        val server=MockWebServer()
        server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
            val data=when {
                request.path=="/api/v1/auth/native/exchange"->"""{"user":{"id":"$user"}}"""
                request.path?.endsWith("/goal")==true->"""{"title":"原目标","detail":"原说明","revision":1}"""
                request.path?.endsWith("/settings")==true->"""{"revision":1,"aiCollaborationEnabled":true}"""
                else->"""{"name":"原项目","description":"原说明","myRole":"owner","revision":1,"status":"active"}"""
            }
            if(request.method!="GET"&&request.path!="/api/v1/auth/native/exchange")writes.incrementAndGet()
            return MockResponse().setHeader("Content-Type","application/json").addHeader("Set-Cookie","ai_office_session=fixture").setBody("{\"data\":$data}")
        }};server.start()
        try {
            val context=InstrumentationRegistry.getInstrumentation().targetContext
            val repository=ClientRepository(context,server.url("/").toString().trimEnd('/'),"reference-${UUID.randomUUID()}-")
            runBlocking {repository.exchange("fixture","fixture")}
            val preferences=AppearancePreferences(context);runBlocking{preferences.setReferenceBadges(user,true)}
            val settings=mutableStateOf(true)
            compose.setContent {NativeTheme {NativeReferencePreferences(preferences,user) {Column(Modifier.width(280.dp).fillMaxHeight()) {
                TextButton({settings.value=!settings.value}){Text("切换页面")}
                if(settings.value)NativeAppearanceSettings("system"){} else ProjectSettingsWorkspace(repository,project)
            }}}}
            compose.onNode(isToggleable()).performScrollTo().performClick()
            compose.waitUntil(5000){runBlocking{!preferences.referenceBadges(user).first()}}
            compose.onNodeWithText("切换页面").performClick()
            compose.waitUntil(10000){compose.onAllNodesWithText("原项目").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithText("项目名称").assertExists()
            compose.onNodeWithText("原项目").assertExists()
            compose.onNodeWithText("AI 会引用").assertDoesNotExist()
            assertEquals(0,writes.get())
        } finally {server.shutdown()}
    }
}

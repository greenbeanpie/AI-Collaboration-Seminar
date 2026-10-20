package cn.buwei.nativeapp
import android.graphics.Bitmap
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.*
import org.junit.Assert.*
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class PrototypeThemeInstrumentedTest {
 @get:Rule val compose=createComposeRule()
 private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
 private val file by lazy{File(context.cacheDir,"theme-${UUID.randomUUID()}.preferences_pb")}
 private lateinit var ioScope:CoroutineScope
 private fun preferences():AppearancePreferences {ioScope=CoroutineScope(SupervisorJob()+Dispatchers.IO);return AppearancePreferences(PreferenceDataStoreFactory.create(scope=ioScope,produceFile={file}))}
 @After fun cleanup(){if(::ioScope.isInitialized)runBlocking{ioScope.coroutineContext[Job]!!.cancelAndJoin()};file.delete()}
 private fun await(text:String){compose.waitUntil(10000){compose.onAllNodesWithText(text,substring=true).fetchSemanticsNodes().isNotEmpty()}}
 private fun screenshot(name:String){compose.mainClock.advanceTimeBy(700);compose.waitForIdle();val output=File(context.getExternalFilesDir(null),name);output.outputStream().use{compose.onRoot().captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG,100,it)}}
 @Test fun choicesSurviveStoreRecreationAndInvalidDesignCannotOverwriteThem()=runBlocking{
  val first=preferences();assertEquals(NativeAppearance(),first.settings.first());first.setMode("dark");first.setDesign("prototype")
  try{first.setDesign("unknown");fail("invalid design accepted")}catch(_:IllegalArgumentException){}
  ioScope.coroutineContext[Job]!!.cancelAndJoin()
  val restored=preferences();assertEquals(NativeAppearance("dark","prototype"),restored.settings.first());restored.setMode("system");assertEquals("prototype",restored.settings.first().design)
 }
 @Test fun pickerImmediatelyChangesGlobalPaletteAndSupportsBothModes(){
  val prefs=preferences();val palette=AtomicReference<Color>()
  compose.setContent{val saved by prefs.settings.collectAsState(initial=NativeAppearance());NativeTheme(saved.mode=="dark",saved.design){val primary=MaterialTheme.colorScheme.primary;SideEffect{palette.set(primary)};Surface(Modifier.width(390.dp).fillMaxHeight(),color=MaterialTheme.colorScheme.background){NativeAppearanceSettings(saved.mode,saved.design,{prefs.setDesign(it)}){prefs.setMode(it)}}}}
  compose.onNodeWithTag("theme-design:prototype").performScrollTo().performClick()
  compose.waitUntil(10000){palette.get()==Color(0xFF2563EB)};compose.onNodeWithTag("theme-design:prototype").assertIsSelected()
  compose.onNodeWithText("外观").performScrollTo();screenshot("prototype-theme-light.png")
  compose.onNodeWithText("深色",substring=false).performScrollTo().performClick()
  compose.waitUntil(10000){palette.get()==Color(0xFF60A5FA)}
  compose.onNodeWithText("外观").performScrollTo();screenshot("prototype-theme-dark.png")
  compose.onNodeWithTag("theme-design:classic").performScrollTo().performClick();compose.waitUntil(10000){palette.get()==Color(0xFF9DD2B9)}
  assertEquals("dark",runBlocking{prefs.settings.first().mode})
 }
 @Test fun failedDesignSaveLeavesPreviousSelectionAndAllowsRetry(){
  val design=mutableStateOf("classic");var fail=true
  compose.setContent{NativeTheme(design=design.value){Surface{NativeAppearanceSettings("light",design.value,{if(fail)throw IOException("fixture");design.value=it}){}}}}
  compose.onNodeWithTag("theme-design:prototype").performScrollTo().performClick();await("未能保存外观，请重试。")
  compose.onNodeWithTag("theme-design:classic").assertIsSelected();compose.onNodeWithTag("theme-design:prototype").assertIsNotSelected()
  compose.runOnIdle{fail=false};compose.onNodeWithTag("theme-design:prototype").performScrollTo().performClick();compose.waitUntil(10000){design.value=="prototype"};compose.onNodeWithText("未能保存外观，请重试。").assertDoesNotExist()
 }
 @Test fun narrowLargeFontPickerWrapsWithoutHorizontalClipping(){
  val design=mutableStateOf("classic");val mode=mutableStateOf("light")
  compose.setContent{val density=LocalDensity.current;CompositionLocalProvider(LocalDensity provides Density(density.density,2f)){NativeTheme(design=design.value){Surface(Modifier.width(280.dp).fillMaxHeight()){NativeAppearanceSettings(mode.value,design.value,{design.value=it}){mode.value=it}}}}}
  compose.onNodeWithTag("theme-design:prototype").performScrollTo().performClick();compose.onNodeWithTag("theme-design:prototype").assertIsSelected()
  val root=compose.onRoot().fetchSemanticsNode().boundsInRoot
  for(title in listOf("舒展蓝","蓝色强调 · 冷灰底色 · 舒展卡片")){val node=compose.onNodeWithText(title).performScrollTo();val bounds=node.fetchSemanticsNode().boundsInRoot;assertTrue(bounds.left>=root.left&&bounds.right<=root.right+1);node.assertIsDisplayed()}
  compose.onNodeWithText("舒展蓝").performScrollTo();screenshot("prototype-theme-large-font.png")
  compose.onNodeWithText("深色",substring=false).performScrollTo().performClick();compose.runOnIdle{assertEquals("dark",mode.value)}
 }
}

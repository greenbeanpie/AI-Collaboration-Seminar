package cn.buwei.nativeapp.media

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import cn.buwei.nativeapp.NativeTheme
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

class NativeMediaPlayerTest {
    @get:Rule val compose=createComposeRule()
    @Test fun localAudioPlaysAndPausesUsingComposeControls() {
        val file=File.createTempFile("native-playback-",".wav",InstrumentationRegistry.getInstrumentation().targetContext.cacheDir)
        val pcm=ByteArray(16000*2*10)
        val header=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("RIFF".toByteArray());putInt(pcm.size+36);put("WAVEfmt ".toByteArray());putInt(16);putShort(1);putShort(1);putInt(16000);putInt(32000);putShort(2);putShort(16);put("data".toByteArray());putInt(pcm.size)
        }.array()
        try {
            file.outputStream().use {it.write(header);it.write(pcm)}
            compose.setContent {NativeTheme {NativeMediaPlayer(file)}}
            compose.onNodeWithText("播放").performClick()
            compose.waitUntil(15000){compose.onAllNodesWithText("暂停播放").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithText("暂停播放").performClick()
            compose.waitUntil(5000){compose.onAllNodesWithText("播放").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithText("回到开头").assertIsDisplayed()
        }finally{file.delete()}
    }
}

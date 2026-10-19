package cn.buwei.nativeapp.voice

import org.junit.Assert.*
import org.junit.Test

class VoiceProtocolTest {
    @Test fun signedPcmUsesLittleEndianWithoutClipping() {
        assertArrayEquals(byteArrayOf(0, 128.toByte(), 255.toByte(), 255.toByte(), 0, 0, 255.toByte(), 127), VoiceProtocol.pcm(shortArrayOf(Short.MIN_VALUE, -1, 0, Short.MAX_VALUE), 4))
    }
    @Test fun partialHardwareReadEncodesOnlyValidSamples() {
        assertEquals("AQACAAM A".replace(" ", ""), VoiceProtocol.base64(shortArrayOf(1, 2, 3, 99), 3))
    }
    @Test fun streamCannotLeaveTheAuthenticatedSession() {
        val prefix = "/api/v1/projects/p/rehearsals/r"
        assertEquals("$prefix/voice-sessions/s/stream", VoiceProtocol.streamPath("$prefix/voice-sessions/s/stream", prefix, "s"))
        for (invalid in listOf("https://evil.invalid/stream", "$prefix/voice-sessions/s/stream?token=x", "$prefix/voice-sessions/other/stream", "//$prefix/voice-sessions/s/stream")) {
            try { VoiceProtocol.streamPath(invalid, prefix, "s"); fail("Unsafe path accepted") } catch (_: IllegalArgumentException) {}
        }
    }
}

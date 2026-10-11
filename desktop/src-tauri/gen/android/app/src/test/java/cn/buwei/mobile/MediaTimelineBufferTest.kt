package cn.buwei.mobile

import org.junit.Assert.*
import org.junit.Test

class MediaTimelineBufferTest {
    @Test fun delaysNewAudioUntilVideoCatchesUp() {
        val buffer = MediaTimelineBuffer<String>(true)
        buffer.push("audio-before", 90, false, 1)
        buffer.push("audio-after", 110, false, 1)
        assertEquals(emptyList<String>(), buffer.take(false))
        buffer.push("keyframe", 100, true, 1)
        assertEquals(listOf("audio-before", "keyframe"), buffer.take(false))
        buffer.push("next-video", 120, true, 1)
        assertEquals(listOf("audio-after"), buffer.take(false))
        assertEquals(listOf("next-video"), buffer.take(true))
        assertTrue(buffer.isEmpty())
    }
    @Test fun keyframePrecedesAudioAtEqualBoundary() {
        val buffer = MediaTimelineBuffer<String>(true)
        buffer.push("audio", 100, false, 1)
        buffer.push("keyframe", 100, true, 1)
        assertEquals(listOf("keyframe", "audio"), buffer.take(false))
    }
    @Test fun audioOnlyDoesNotWaitForVideo() {
        val buffer = MediaTimelineBuffer<String>(false)
        buffer.push("aac", 100, false, 1)
        assertEquals(listOf("aac"), buffer.take(false))
    }
    @Test fun rejectsClockRollback() {
        val buffer = MediaTimelineBuffer<String>(true)
        buffer.push("first", 100, true, 1)
        assertTrue(runCatching { buffer.push("rollback", 99, true, 1) }.isFailure)
    }
    @Test fun boundsMemoryWhenOneEncoderStalls() {
        val buffer = MediaTimelineBuffer<String>(true, 2)
        buffer.push("first", 100, false, 2)
        assertTrue(runCatching { buffer.push("overflow", 101, false, 1) }.isFailure)
        assertEquals(listOf("first"), buffer.take(true))
        buffer.push("recovered", 102, false, 2)
    }
}

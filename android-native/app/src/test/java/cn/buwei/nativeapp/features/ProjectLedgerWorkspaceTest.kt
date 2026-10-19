package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProjectLedgerWorkspaceTest {
    @Test fun eventsDistinguishHumanAdoptionFromUnreviewedAiResult() {
        val ai = presentProjectEvent(buildJsonObject { put("type", "ai.run_succeeded"); put("actorType", "ai"); put("payload", buildJsonObject {}) })
        assertEquals("AI 辅助", ai.actor); assertTrue(ai.detail.contains("仍需人工复核"))
        val adopted = presentProjectEvent(buildJsonObject { put("type", "material.adopted"); put("actorType", "user"); put("payload", buildJsonObject { put("revision", 4) }) })
        assertEquals("成员操作", adopted.actor); assertTrue(adopted.detail.contains("成员确认")); assertTrue(adopted.detail.contains("r4"))
    }
    @Test fun eventStatusChangesAreReadableAndUnknownPayloadIsNotRawJson() {
        val result = presentProjectEvent(buildJsonObject { put("type", "task.status_changed"); put("actorType", "user"); put("payload", buildJsonObject { put("from", "todo"); put("to", "done") }) })
        assertEquals("待开始 → 已完成", result.detail)
        val future = presentProjectEvent(buildJsonObject { put("type", "future.operation"); put("actorType", "system"); put("payload", buildJsonObject { put("token", "never display") }) })
        assertEquals("系统记录", future.actor); assertFalse(future.detail.contains("never display")); assertEquals("项目活动", future.title)
    }
}

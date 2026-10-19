package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProjectOverviewWorkspaceTest {
    @Test fun pendingPreviewRanksMineFirstThenNewestAndShowsOnlyTwo() {
        fun row(id: String, owner: String, date: String, status: String = "doing") = buildJsonObject { put("taskId", id); put("assigneeId", owner); put("createdAt", date); put("status", status) }
        val rows = listOf(row("other-newest", "other", "2026-10-20"), row("mine-older", "mine", "2026-10-18"), row("mine-newer", "mine", "2026-10-19"), row("finished", "mine", "2026-10-21", "done"))
        assertEquals(listOf("mine-newer", "mine-older"), overviewPendingTasks(rows, "mine").map { it.text("taskId") })
    }
}

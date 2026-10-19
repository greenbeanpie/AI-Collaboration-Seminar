package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate

class ProjectDashboardWorkspaceTest {
    private fun graph(vararg tasks: JsonObject) = buildJsonObject { put("items", JsonArray(tasks.toList())); put("memberIds", buildJsonArray { add("member") }) }
    private fun task(id: String, status: String = "todo", assignee: String = "member", revision: Int = 1, dependencies: List<String> = emptyList(), unfinished: List<String> = emptyList(), lifecycle: String = "open") = buildJsonObject { put("taskId", id); put("title", id); put("status", status); put("assigneeId", assignee); put("revision", revision); put("lifecycleState", lifecycle); put("dependsOnTaskIds", JsonArray(dependencies.map(::JsonPrimitive))); put("unfinishedDependencyIds", JsonArray(unfinished.map(::JsonPrimitive))) }
    @Test fun completeProjectRequiresNonemptyFullTaskGraph() {
        val project = buildJsonObject { put("status", "active") }
        assertEquals("unknown", dashboardStatus(project, null)); assertEquals("unknown", dashboardStatus(project, JsonObject(emptyMap())))
        assertEquals("active", dashboardStatus(project, graph()))
        assertEquals("done", dashboardStatus(project, graph(task("t", "done"))))
        assertEquals("pending", dashboardStatus(project, graph(task("t", "doing", lifecycle = "submitted"))))
        assertEquals("archived", dashboardStatus(buildJsonObject { put("status", "archived") }, null))
    }
    @Test fun latestTaskRevisionWinsWithoutDoubleCounting() {
        val tasks = dashboardTasks(graph(task("t", "todo", revision = 1), task("t", "done", revision = 2)))
        assertEquals(1, tasks.size); assertEquals("done", tasks.single().text("status"))
    }
    @Test fun actionableRequiresMembershipAndSatisfiedDependencies() {
        val complete = graph(task("dependency", "done"), task("ready", dependencies = listOf("dependency")), task("former-member", assignee = "departed"), task("blocked", "blocked"), task("missing-prerequisite", dependencies = listOf("missing")), task("awaiting-review", lifecycle = "submitted"), task("unfinished", unfinished = listOf("dependency")))
        assertEquals(listOf("ready"), dashboardActionable(complete).map { it.text("taskId") })
        assertTrue(dashboardActionable(JsonObject(complete - "memberIds")).isEmpty())
    }
    @Test fun deadlinesRespectPrecisionAndRejectInvalidCalendarDates() {
        val today = LocalDate.of(2026,10,19)
        assertEquals(0L, dashboardDays(buildJsonObject { put("dueDate", "2026-10-19"); put("duePrecision", "date") }, today))
        assertEquals(-1L, dashboardDays(buildJsonObject { put("dueDate", "2026-10-18"); put("duePrecision", "date") }, today))
        assertNull(dashboardDays(buildJsonObject { put("dueDate", "2026-10-19"); put("duePrecision", "unknown") }, today))
        assertNull(dashboardDays(buildJsonObject { put("dueDate", "2026-02-30"); put("duePrecision", "date") }, today))
    }
}

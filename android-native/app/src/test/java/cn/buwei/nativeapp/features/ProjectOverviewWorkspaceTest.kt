package cn.buwei.nativeapp.features
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class ProjectOverviewWorkspaceTest {
 @Test fun focusPreviewRetainsServerOrderAndLimitsFive(){val focus=buildJsonObject{put("items",JsonArray(listOf("pinned-other","overdue","rework","soon","active","sixth").map{buildJsonObject{put("taskId",it)}}))};assertEquals(listOf("pinned-other","overdue","rework","soon","active"),overviewFocusTasks(focus).map{it.text("taskId")})}
 @Test fun missingFocusDoesNotInventAssignments(){assertTrue(overviewFocusTasks(null).isEmpty())}
}

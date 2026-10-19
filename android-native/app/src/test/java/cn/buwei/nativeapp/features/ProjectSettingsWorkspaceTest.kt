package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ProjectSettingsWorkspaceTest {
    private val base = Json.parseToJsonElement("""{"revision":7,"deadlineDate":"2026-12-01T12:30:00+08:00","deadlinePrecision":"datetime"}""").jsonObject
    @Test fun uneditedDeadlineDoesNotOverwriteOriginalTimestampOrPrecision() {
        val patch = projectSettingsPatch(base, buildJsonObject { put("name", "新名称") })
        assertEquals(setOf("name", "expectedRevision"), patch.keys)
        assertEquals(7, patch["expectedRevision"]!!.jsonPrimitive.int)
    }
    @Test fun dateEditUsesDatePrecisionAndExplicitEmptyDateClearsOnlyOnEdit() {
        val edit = projectSettingsPatch(base, buildJsonObject { put("deadlineDate", "2026-12-02") })
        assertEquals("date", edit.text("deadlinePrecision")); assertEquals("2026-12-02", edit.text("deadlineDate"))
        val cleared = projectSettingsPatch(base, buildJsonObject { put("deadlineDate", "") })
        assertEquals(JsonNull, cleared["deadlineDate"]); assertEquals("unknown", cleared.text("deadlinePrecision"))
        assertThrows(java.time.format.DateTimeParseException::class.java) { projectSettingsPatch(base, buildJsonObject { put("deadlineDate", "2026-99-99") }) }
    }
    @Test fun unknownResourceOrIdentityFieldsCannotEnterProjectPatch() {
        assertThrows(IllegalArgumentException::class.java) { projectSettingsPatch(base, buildJsonObject { put("bucketId", "replace") }) }
    }
}

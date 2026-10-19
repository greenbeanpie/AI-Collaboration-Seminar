package cn.buwei.nativeapp.push

import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeInboxFilterTest {
    private fun event(id: String, read: JsonElement = JsonNull, dismissed: JsonElement = JsonNull) = buildJsonObject {
        put("id", id); put("readAt", read); put("dismissedAt", dismissed)
    }
    @Test fun includesOnlyUnreadVisibleRowsInOldToNewOrder() {
        val latest = UUID.randomUUID().toString(); val earlier = UUID.randomUUID().toString()
        val feed = buildJsonObject { put("items", buildJsonArray {
            add(event(latest)); add(event(UUID.randomUUID().toString(), JsonPrimitive("2026-10-19")))
            add(event(UUID.randomUUID().toString(), dismissed = JsonPrimitive("2026-10-19")))
            add(event(earlier)); add(event("invalid")); add(buildJsonObject { put("id", UUID.randomUUID().toString()) })
        }) }
        assertEquals(listOf(earlier, latest), unreadNativeEventIds(feed))
    }
    @Test fun firstPageHasHardLimitOfFifty() {
        val ids = (1..51).map { UUID.randomUUID().toString() }
        val feed = buildJsonObject { put("items", buildJsonArray { ids.forEach { add(event(it)) } }) }
        assertEquals(ids.take(50).asReversed(), unreadNativeEventIds(feed))
    }
    @Test fun missingOrNonArrayFeedDoesNotGenerateAlerts() {
        assertTrue(unreadNativeEventIds(buildJsonObject {}).isEmpty())
        assertTrue(unreadNativeEventIds(buildJsonObject { put("items", JsonNull) }).isEmpty())
    }
}

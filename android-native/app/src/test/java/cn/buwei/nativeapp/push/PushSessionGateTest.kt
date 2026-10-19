package cn.buwei.nativeapp.push

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PushSessionGateTest {
    @Test fun coldProcessRestoresBeforeValidatingAndAccepting() = runBlocking {
        var account: String? = null
        var restored = false
        val result = validatedPushAccount("owner", { restored = true; account = "owner" }, { account }) {
            check(restored)
            "owner"
        }
        assertEquals("owner", result)
    }

    @Test fun signedOutAndOtherAccountMessagesDoNotValidateOrDisplay() = runBlocking {
        for (account in listOf(null, "another")) {
            var validated = false
            assertNull(validatedPushAccount("owner", {}, { account }) { validated = true; "owner" })
            assertFalse(validated)
        }
    }

    @Test fun logoutDuringValidationPreventsDisplay() = runBlocking {
        var account: String? = "owner"
        assertNull(validatedPushAccount("owner", {}, { account }) { account = null; "owner" })
    }

    @Test fun serverDifferentAccountPreventsDisplay() = runBlocking {
        assertNull(validatedPushAccount("owner", {}, { "owner" }) { "another" })
    }

    @Test fun networkFailurePropagatesRatherThanUsingCachedAccount() {
        assertThrows(IOException::class.java) {
            runBlocking { validatedPushAccount("owner", {}, { "owner" }) { throw IOException("offline") } }
        }
    }

    @Test fun corruptRestorePropagatesRatherThanResettingOrDisplaying() {
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { validatedPushAccount("owner", { throw IllegalArgumentException("damaged state") }, { "owner" }) { "owner" } }
        }
    }
}

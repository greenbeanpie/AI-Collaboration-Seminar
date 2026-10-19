package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeJobRecoveryTest {
    private fun job(status:String="failed",canResume:Boolean=true)=buildJsonObject {
        put("status",status);put("activity",buildJsonObject { put("canResume",canResume) })
    }
    @Test fun onlyServerEligibleFailedJobsCanResume() {
        assertTrue(nativeJobCanResume(job()))
        listOf("queued","running","waiting_input","succeeded","cancelled","").forEach { assertFalse(nativeJobCanResume(job(it))) }
    }
    @Test fun missingOrDeniedEligibilityCannotDispatch() {
        assertFalse(nativeJobCanResume(job(canResume=false)))
        assertFalse(nativeJobCanResume(buildJsonObject { put("status","failed") }))
        assertFalse(nativeJobCanResume(job(),allowed=false))
        assertFalse(nativeJobCanResume(JsonObject(job()+ ("execution" to buildJsonObject { put("state","paused") }))))
    }
    @Test fun uncertaintyDoesNotTriggerOrBypassManualEligibility() {
        val failed=job().toMutableMap();failed["activity"]=buildJsonObject { put("canResume",false);put("uncertain",true) }
        assertFalse(nativeJobCanResume(JsonObject(failed)))
    }
    @Test fun retryAcceptsOnlyReturnedUuid() {
        val id="7f836077-634b-42b8-8923-923e8c0ba142"
        assertEquals(id,nativeRetryJobId(buildJsonObject { put("jobId",id) }))
        listOf("","old-job","../jobs/other","https://example.com/job","7f836077-634b-42b8-8923-923e8c0ba142/retry").forEach {
            assertThrows(IllegalArgumentException::class.java) { nativeRetryJobId(buildJsonObject { put("jobId",it) }) }
        }
        assertThrows(IllegalArgumentException::class.java) { nativeRetryJobId(buildJsonObject {}) }
    }
}

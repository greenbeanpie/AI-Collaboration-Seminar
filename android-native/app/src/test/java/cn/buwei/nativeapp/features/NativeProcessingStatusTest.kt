package cn.buwei.nativeapp.features
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class NativeProcessingStatusTest {
 private fun row(vararg pairs:Pair<String,JsonElement>)=JsonObject(mapOf(*pairs))
 @Test fun fileUsesActualJobAndConcurrencyStateRatherThanAssumingEveryPhaseIsActive(){
  assertTrue(nativeFileProcessingActive(row("waitingForConcurrency" to JsonPrimitive(true))))
  assertTrue(nativeFileProcessingActive(row("jobStatus" to JsonPrimitive("running"))))
  assertFalse(nativeFileProcessingActive(row("jobStatus" to JsonPrimitive("succeeded"),"summaryStatus" to JsonPrimitive("running"))))
  assertTrue(nativeFileProcessingActive(row("summaryStatus" to JsonPrimitive("running"))))
 }
 @Test fun pausedFileWithNoMissingPagesDoesNotStartAgain(){
  assertTrue(nativeFileProcessingPaused(row("jobStatus" to JsonPrimitive("waiting_input"),"needsImages" to JsonPrimitive(0))))
  assertFalse(nativeFileProcessingPaused(row("jobStatus" to JsonPrimitive("waiting_input"),"needsImages" to JsonPrimitive(2))))
 }
 @Test fun failedIndependentPhaseStillRequiresExplicitRetry(){
  assertTrue(nativeFileProcessingRetry(row("jobStatus" to JsonPrimitive("succeeded"),"summaryStatus" to JsonPrimitive("failed"))))
  assertTrue(nativeFileProcessingRetry(row("requirementsStatus" to JsonPrimitive("cancelled"))))
  assertFalse(nativeFileProcessingRetry(row("jobStatus" to JsonPrimitive("running"))))
 }
 @Test fun waitingForConfigurationDoesNotPollMediaForeverButOtherRunningPhasesStillPoll(){
  val waiting=row("media" to row("stage" to JsonPrimitive("processing"),"audio" to row("phase" to JsonPrimitive("waiting_config"))))
  assertFalse(nativeSourceProcessingActive(waiting))
  assertTrue(nativeSourceProcessingActive(JsonObject(waiting+("summaryStatus" to JsonPrimitive("running")))))
  assertTrue(nativeSourceProcessingActive(row("media" to row("stage" to JsonPrimitive("generating")))))
 }
 @Test fun completedOrRecoverableFailedSummaryDoesNotOfferDuplicateNewSummaryIntent(){
  fun state(status:String,job:String="")=row("textStatus" to JsonPrimitive("ready"),"summaryStatus" to JsonPrimitive(status),"summaryJobId" to JsonPrimitive(job))
  assertTrue(nativeSummaryCanStart(state("pending")));assertTrue(nativeSummaryCanStart(state("cancelled")))
  assertFalse(nativeSummaryCanStart(state("ready")));assertFalse(nativeSummaryCanStart(state("running")));assertFalse(nativeSummaryCanStart(state("failed","existing")))
 }
}

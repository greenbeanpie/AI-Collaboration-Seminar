package cn.buwei.nativeapp

import org.junit.Assert.*
import org.junit.Test

class NativeDestinationTest {
    private val project="11111111-1111-4111-8111-111111111111"
    private val record="22222222-2222-4222-8222-222222222222"
    private val version="33333333-3333-4333-8333-333333333333"
    @Test fun taskLinksKeepActualRecordInsteadOfOnlySection() {
        assertEquals(NativeDestination("tasks",project,record),nativeDestination("/app/projects/$project/tasks/$record"))
        assertEquals(NativeDestination("tasks",project,record),nativeDestination("/app/projects/$project/tasks?task=$record"))
    }
    @Test fun fixedVersionAndAssessmentLinksPreserveIdentity() {
        assertEquals(NativeDestination("data",project,record,"source",version),nativeDestination("/app/projects/$project/data?resourceType=source&resourceId=$record&sourceVersionId=$version"))
        assertEquals(NativeDestination("rehearsals",project,record,assessmentSection="rehearsals"),nativeDestination("/app/projects/$project/assessment?section=rehearsals&assessmentId=$record"))
        assertEquals(NativeDestination("assessment",project,record,assessmentSection="assessments"),nativeDestination("/app/projects/$project/reviews/$record"))
        assertEquals(NativeDestination("assessment",project,record,assessmentSection="assessments"),nativeDestination("/app/projects/$project/assessment?section=checks&assessmentId=$record"))
        assertEquals("inquiries",nativeDestination("/app/projects/$project/tasks?task=$record&taskAction=inquiries")?.taskAction)
    }
    @Test fun currentAndLegacySettingsUseDedicatedDestinations() {
        assertEquals("notifications",nativeDestination("/app/profile/settings/notifications")?.section)
        assertEquals("bridges",nativeDestination("/app/agent-bridges/connect")?.section)
        assertEquals(NativeDestination("support",recordId=record),nativeDestination("/app/support/$record"))
        assertEquals("material-ai",nativeDestination("/app/projects/$project/data?ai=1")?.section)
        assertEquals(NativeDestination("people",username="visible-user"),nativeDestination("/app/people/visible-user"))
        assertNull(nativeDestination("/app/people/ab"))
    }
    @Test fun externalTraversalMalformedAndUnsupportedLinksAreRejected() {
        listOf("https://example.com/app","//example.com/app","/application","/app/projects/not-a-uuid/tasks","/app/../app/profile","/app/%2e%2e/profile","/app/%252e%252e/profile","/app/profile%5csettings","/app/projects/$project/data?resourceType=evil","/app/projects/$project/tasks?task=bad","/app/projects/$project/unknown","/app/profile\n").forEach {assertNull(it,nativeDestination(it))}
    }
}

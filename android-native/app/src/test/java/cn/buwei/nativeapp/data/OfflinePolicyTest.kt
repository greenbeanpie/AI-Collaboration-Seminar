package cn.buwei.nativeapp.data

import org.junit.Assert.*
import org.junit.Test

class OfflinePolicyTest {
    @Test fun onlyServerSupportedIntentsAreQueued() {
        val root="/api/v1/projects/123e4567-e89b-12d3-a456-426614174000/"
        assertTrue(OfflinePolicy.allowed("PUT",root+"materials/material-1"))
        assertTrue(OfflinePolicy.allowed("PATCH",root+"collaboration/tasks/task-1"))
        assertTrue(OfflinePolicy.allowed("POST",root+"tasks/task-1/submissions"))
        listOf("tasks/task-1/ai","tasks/task-1/delete","materials/material-1/restore","recording-sessions","offline-sync","tasks?force=1","../tasks").forEach {assertFalse(it,OfflinePolicy.allowed("POST",root+it))}
        assertFalse(OfflinePolicy.allowed("DELETE",root+"materials/material-1"))
        assertFalse(OfflinePolicy.allowed("PATCH","/api/v1/admin/tasks/task-1"))
    }
    @Test fun privateBinaryAndRealtimeEndpointsNeverUseSnapshots() {
        val root="/api/v1/projects/project-1/"
        assertTrue(OfflinePolicy.cacheable(root+"materials"))
        assertTrue(OfflinePolicy.cacheable("/api/v1/projects?limit=50"))
        listOf("files/file-1/content","rehearsals/r/voice-sessions","files/f/uploads/u","export","agent-sessions/a").forEach {assertFalse(it,OfflinePolicy.cacheable(root+it))}
    }
}

package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NotificationWorkspaceContractTest {
 @Test fun blocksExternalApiAndMalformedNavigation(){listOf("https://evil.example/","//evil.example/app","/api/v1/auth/session","/app\\evil","/app/ bad","/application/invalid","/app/%2e%2e/api/secrets","/app/%5c%5cevil").forEach{assertNull(notificationWorkspaceTarget(it))};assertEquals("/app/projects/project?taskAction=tasks#task",notificationWorkspaceTarget("/app/projects/project?taskAction=tasks#task"))}
 @Test fun laterPagesDeduplicateAndReplaceUpdatedRows(){val first=buildJsonObject{put("id","a");put("title","Old")};val later=buildJsonObject{put("id","a");put("title","Updated");put("readAt","now")};val old=buildJsonObject{put("id","b")};val merged=notificationWorkspaceMerge(listOf(first),listOf(later,old));assertEquals(listOf("a","b"),merged.map{it.text("id")});assertEquals("Updated",merged[0].text("title"))}
}

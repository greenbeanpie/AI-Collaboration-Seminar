package cn.buwei.nativeapp.media

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DerivedUploadIdentityTest {
    private val parent="11111111-1111-4111-8111-111111111111"
    private val other="22222222-2222-4222-8222-222222222222"
    private fun manifest(from:String?=null,contributors:List<String>?=null,purpose:String="reference")=uploadManifestName("project",purpose,"same-bytes",contributors,from)
    @Test fun differentParentsAndOrdinaryUploadsHaveIndependentPersistentIdentities() {
        assertEquals(manifest(parent),manifest(parent))
        assertEquals(3,setOf(manifest(parent),manifest(other),manifest()).size)
        assertNotEquals(manifest(parent),manifest(parent,purpose="output"))
    }
    @Test fun ordinaryUploadNamesRemainCompatibleWithExistingManifests() {
        assertEquals("project-same-bytes.json",manifest())
        assertEquals("project-output-same-bytes.json",manifest(purpose="output"))
        assertEquals(manifest(contributors=listOf(parent,other)),manifest(contributors=listOf(other,parent)))
        assertNotEquals(manifest(),manifest(contributors=listOf(parent)))
    }
    @Test fun derivedAttributionRejectsContributorOverridesAndInvalidParent() {
        assertThrows(IllegalArgumentException::class.java){manifest(parent,listOf(other))}
        assertThrows(IllegalArgumentException::class.java){manifest(parent,emptyList())}
        assertThrows(IllegalArgumentException::class.java){manifest("not-an-id")}
    }
    @Test fun prepareRequiresVersionSourceAndActualFileToAgree() {
        val source=buildJsonObject{put("fileId",parent)}
        assertEquals(parent,pdfImageParentFileId(source,source,parent))
        for(actual in listOf(null,other))assertThrows(IllegalStateException::class.java){pdfImageParentFileId(source,source,actual)}
        assertThrows(IllegalStateException::class.java){pdfImageParentFileId(buildJsonObject{put("fileId",other)},source,parent)}
        assertThrows(IllegalStateException::class.java){pdfImageParentFileId(JsonObject(emptyMap()),source,parent)}
        assertThrows(IllegalStateException::class.java){pdfImageParentFileId(source,JsonObject(emptyMap()),parent)}
    }
}

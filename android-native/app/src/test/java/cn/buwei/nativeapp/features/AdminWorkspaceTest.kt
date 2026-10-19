package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AdminWorkspaceTest {
    @Test fun configDraftNeverPersistsCredentialValuesOrEncryptedMaterial() {
        val source = Json.parseToJsonElement("""{"unified":{"model":"safe-model","apiKey":"new-secret","apiKeyEncrypted":"cipher","keyConfigured":true},"realtimeAudioTranscription":{"gatewayToken":"gateway-secret","gatewayId":"existing-gateway"},"goHeaders":{"authorization":"header-secret"},"notes":"safe note"}""").jsonObject
        val draft = adminPublicDraft(source).toString()
        assertFalse(draft.contains("new-secret")); assertFalse(draft.contains("gateway-secret")); assertFalse(draft.contains("cipher")); assertFalse(draft.contains("header-secret"))
        assertTrue(draft.contains("existing-gateway")); assertTrue(draft.contains("safe-model"))
        val editable = adminEditableConfig(source)
        assertFalse(editable.obj("unified").containsKey("keyConfigured")); assertFalse(editable.obj("unified").containsKey("apiKey"))
    }
    @Test fun aiPatchIncludesOnlyEditedFieldsAndRequiresSeparateActivation() {
        val patch = adminAiPatch(19, buildJsonObject { put("searchEnabled", true) })
        assertEquals(setOf("searchEnabled", "expectedVersion"), patch.keys)
        assertEquals(19, patch["expectedVersion"]!!.jsonPrimitive.int)
        assertThrows(IllegalArgumentException::class.java) { adminAiPatch(19, buildJsonObject { put("enabled", true) }) }
    }
}

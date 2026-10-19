package cn.buwei.nativeapp.features

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class NativeSchemaValidationTest {
    @Test fun unconstrainedReferencesAcceptStructuredJsonWithoutTurningItIntoText(){
        val schema=Json.parseToJsonElement("""{"type":"object","properties":{"references":{"type":"array","items":{}}}}""").jsonObject
        val body=Json.parseToJsonElement("""{"references":[{"resourceType":"source","quote":"固定证据"},[1,true],null,3,"plain"]}""")
        assertNull(validate(schema,body))
        assertEquals("固定证据",body.jsonObject["references"]!!.jsonArray[0].jsonObject.text("quote"))
    }
    @Test fun emptySchemasDoNotDisableTypedSiblingConstraints(){
        val schema=Json.parseToJsonElement("""{"type":"object","required":["expectedRevision"],"properties":{"expectedRevision":{"type":"integer","exclusiveMinimum":0},"references":{"type":"array","items":{}}}}""").jsonObject
        assertNotNull(validate(schema,Json.parseToJsonElement("""{"expectedRevision":0,"references":[{}]}""")))
        assertNotNull(validate(schema,Json.parseToJsonElement("""{"expectedRevision":1,"references":"not an array"}""")))
        assertNull(validate(schema,Json.parseToJsonElement("""{"expectedRevision":1,"references":[{}]}""")))
    }
}

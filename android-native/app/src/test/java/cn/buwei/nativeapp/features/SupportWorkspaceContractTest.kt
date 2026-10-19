package cn.buwei.nativeapp.features

import org.junit.Assert.*
import org.junit.Test

class SupportWorkspaceContractTest {
 @Test fun creationUsesBusinessCategoriesAndTrimmedBody(){val body=supportCreateBody(" A title "," Message ","high","functionality");assertEquals("A title",body.text("title"));assertEquals("Message",body.text("body"));assertEquals("high",body.text("urgency"));assertEquals("functionality",body.text("category"))}
 @Test fun invalidEmptyAndOversizeMessagesAreRejected(){assertThrows(IllegalArgumentException::class.java){supportCreateBody(" ","Message","normal","other")};assertThrows(IllegalArgumentException::class.java){supportCreateBody("Title","x".repeat(8001),"normal","other")};assertThrows(IllegalArgumentException::class.java){supportCreateBody("Title","Message","unknown","other")}}
}

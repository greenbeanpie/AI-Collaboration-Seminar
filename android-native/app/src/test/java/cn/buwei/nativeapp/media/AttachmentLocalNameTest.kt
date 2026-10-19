package cn.buwei.nativeapp.media
import org.junit.Assert.*
import org.junit.Test
class AttachmentLocalNameTest {
 @Test fun unicodeNameKeepsExtensionWithinByteLimit(){val name=attachmentLocalName("手册".repeat(100)+".pdf","id");assertTrue(name.endsWith(".pdf"));assertTrue(name.toByteArray(Charsets.UTF_8).size<=180);assertFalse(name.contains('�'))}
 @Test fun pathCharactersCannotCreateDirectories(){assertEquals(".._folder_guide.pdf",attachmentLocalName("../folder/guide.pdf","id"))}
 @Test fun simpleFilenameIsPreserved(){assertEquals("真实手册.PDF",attachmentLocalName("真实手册.PDF","id"))}
}

package cn.buwei.nativeapp.media

import android.graphics.BitmapFactory
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.pdmodel.PDPage
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException

@RunWith(AndroidJUnit4::class)
class PdfPageImagesInstrumentedTest {
    @Test fun renderingHonorsEdgeAndByteLimitsAndImpossibleLimitPreservesCompletedFile()=runBlocking {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        PDFBoxResourceLoader.init(context)
        val pdf=File.createTempFile("page-limits-", ".pdf",context.cacheDir)
        val image=File.createTempFile("page-limits-", ".jpg",context.cacheDir)
        val retained=File.createTempFile("retained-page-", ".jpg",context.cacheDir)
        val original=byteArrayOf(7,8,9)
        try {
            PDDocument().use {it.addPage(PDPage(PDRectangle(400f,200f)));it.save(pdf)}
            ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY).use {descriptor->PdfRenderer(descriptor).use {document->
                document.openPage(0).use {page->renderPdfPageImage(page,PdfImageLimits(64,2000,null),image)}
                val options=BitmapFactory.Options().apply {inJustDecodeBounds=true}
                BitmapFactory.decodeFile(image.path,options)
                assertTrue(image.length() in 1..2000)
                assertTrue(options.outWidth in 1..64&&options.outHeight in 1..64)
                retained.writeBytes(original)
                try {
                    withTimeout(5000) {document.openPage(0).use {page->renderPdfPageImage(page,PdfImageLimits(1,1,null),retained)}}
                    fail("A 1-byte JPEG budget was silently ignored")
                } catch(expected:IOException) {assertTrue(expected.message.orEmpty().contains("体积限制"))}
                assertArrayEquals(original,retained.readBytes())
                assertFalse(File(retained.path+".rendering").exists())
            }}
        } finally {pdf.delete();image.delete();retained.delete()}
    }
}

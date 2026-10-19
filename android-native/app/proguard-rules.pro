-keepattributes Signature,InnerClasses,EnclosingMethod
# PDFBox's optional JPEG2000 decoder is distributed only via retired JCenter.
# This client uses PDFBox for text extraction, and Android PdfRenderer for images;
# it never calls PDFBox rendering/JPXFilter. Keep this exception limited to the
# upstream optional decoder, rather than hiding other missing classes.
-dontwarn com.gemalto.jp2.JP2Decoder
# EST is an unused certificate-enrolment transport from PDFBox's crypto dependency.
# Fail Release if any EST implementation (including its permissive trust helper)
# survives shrinking. App networking uses OkHttp's platform certificate validation.
-checkdiscard class org.bouncycastle.est.**

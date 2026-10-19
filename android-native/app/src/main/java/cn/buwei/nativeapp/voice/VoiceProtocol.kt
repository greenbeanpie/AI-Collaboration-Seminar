package cn.buwei.nativeapp.voice

import java.util.Base64

/** The server accepts PCM16 little endian, mono at exactly 16 kHz. */
internal object VoiceProtocol {
    const val RATE = 16_000
    const val FRAME_SAMPLES = 1_600
    fun pcm(samples: ShortArray, count: Int): ByteArray {
        require(count in 1..samples.size)
        return ByteArray(count * 2).also { bytes ->
            for (index in 0 until count) {
                val value = samples[index].toInt()
                bytes[index * 2] = value.toByte()
                bytes[index * 2 + 1] = (value shr 8).toByte()
            }
        }
    }
    fun base64(samples: ShortArray, count: Int): String = Base64.getEncoder().encodeToString(pcm(samples, count))
    fun streamPath(path: String, prefix: String, sessionId: String): String {
        require(path == "$prefix/voice-sessions/$sessionId/stream") { "语音服务返回了无效的私有资源路径" }
        return path
    }
}

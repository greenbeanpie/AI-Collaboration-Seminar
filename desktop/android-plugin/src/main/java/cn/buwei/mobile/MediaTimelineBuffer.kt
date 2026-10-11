package cn.buwei.mobile

/** Pure timestamp ordering: each encoder's delivered PTS is a monotonic watermark. */
class MediaTimelineBuffer<T>(private val video: Boolean, private val maxBytes: Int = 2 * 1024 * 1024) {
    private data class Entry<T>(val pts: Long, val video: Boolean, val size: Int, val value: T)
    private val pending = ArrayList<Entry<T>>()
    private var bytes = 0
    private var latestAudioUs = -1L
    private var latestVideoUs = -1L
    fun push(value: T, pts: Long, isVideo: Boolean, size: Int) {
        require(pts >= if (isVideo) latestVideoUs else latestAudioUs) { "设备媒体时钟倒退，录制已停止" }
        require(size >= 0 && size <= maxBytes - bytes) { "编码器时间排序缓存已满，录制已停止" }
        if (isVideo) latestVideoUs = pts else latestAudioUs = pts
        pending.add(Entry(pts, isVideo, size, value)); bytes += size
    }
    fun take(force: Boolean): List<T> {
        val watermark = if (force) Long.MAX_VALUE else if (video) minOf(latestAudioUs, latestVideoUs) else latestAudioUs
        val ready = pending.filter { it.pts <= watermark }.sortedWith(compareBy<Entry<T>> { it.pts }.thenBy { if (it.video) 0 else 1 })
        pending.removeAll(ready.toSet()); bytes -= ready.sumOf { it.size }
        return ready.map { it.value }
    }
    fun isEmpty() = pending.isEmpty()
}

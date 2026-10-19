package cn.buwei.mobile

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.*
import org.json.JSONObject
import java.util.concurrent.Executors

/** Non-sticky: no boot receiver, no automatic background microphone/camera restart. */
class RecordingService : Service() {
    companion object {
        @Volatile var instance: RecordingService? = null
        @Volatile var activeRecording = false
        private const val CHANNEL = "meeting-recording"
        private const val NOTIFICATION = 8421
    }
    private val worker = Executors.newSingleThreadExecutor()
    private fun accountEpoch(): Long = (application as cn.buwei.nativeapp.NativeApplication).repository.epoch
    private fun recordingActivity(active: Boolean) { activeRecording = active }
    private val lifecycleHandler = Handler(Looper.getMainLooper())
    private var epoch = -1L
    private var renewWakeAt=0L
    private val epochWatchdog = object : Runnable {
        override fun run() {
            if (epoch != accountEpoch()) { encoder?.action = "stop"; return }
            if(encoder!=null && SystemClock.elapsedRealtime()>=renewWakeAt) {
                wake?.acquire(10*60*1000L)
                renewWakeAt=SystemClock.elapsedRealtime()+5*60*1000L
            }
            lifecycleHandler.postDelayed(this, 250)
        }
    }
    private var wake: PowerManager.WakeLock? = null
    @Volatile private var encoder: RecordingEncoder? = null
    @Volatile var store: RecordingStore? = null
        private set
    override fun onBind(intent: Intent?) = null
    override fun onCreate() { super.onCreate(); instance = this }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") { encoder?.action = "stop"; return START_NOT_STICKY }
        if (encoder != null) return START_NOT_STICKY
        try {
            val args = JSONObject(intent?.getStringExtra("args") ?: error("缺少录制参数"))
            epoch = args.getLong("accountEpoch")
            require(epoch == accountEpoch()) { "登录账户已变化" }
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "会议录制", NotificationManager.IMPORTANCE_LOW))
            val stop = PendingIntent.getService(this, 0, Intent(this, RecordingService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 1, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
            val notification = Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("正在录制会议资料").setContentText("录制在后台继续；点击停止后预览并上传")
                .setOngoing(true).setContentIntent(open).addAction(Notification.Action.Builder(null, "停止并保存", stop).build()).build()
            val kind = args.getString("kind")
            if (Build.VERSION.SDK_INT >= 30) {
                val types = (if (kind != "photo") ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or
                    (if (kind != "audio") ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
                startForeground(NOTIFICATION, notification, types)
            } else startForeground(NOTIFICATION, notification)
            store = RecordingStore(this, args.getString("root"), args.getString("accountId"), args.getString("id")).also { it.create(args) }
            wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:meeting-recording").apply { setReferenceCounted(false);acquire(10*60*1000L) }
            renewWakeAt=SystemClock.elapsedRealtime()+5*60*1000L
            val capture = RecordingEncoder(this, store!!, args)
            encoder = capture
            recordingActivity(true)
            lifecycleHandler.post(epochWatchdog)
            worker.execute {
                capture.run()
                Handler(Looper.getMainLooper()).post { encoder = null; stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
            }
        } catch (e: Exception) {
            store?.let { runCatching { it.state("interrupted", 0, e.message ?: "录制启动失败") } }
            stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
        }
        return START_NOT_STICKY
    }
    fun action(id: String, action: String, args: JSONObject): JSONObject {
        val activeStore = store ?: error("没有活动录制")
        require(activeStore.view().getString("id") == id) { "录制会话不匹配" }
        require(action in listOf("pause", "resume", "stop", "snapshot")) { "不支持的录制操作" }
        if (args.has("inputDeviceId") || args.has("cameraDeviceId")) {
            require(activeStore.view().getString("state") == "paused" && action == "resume") { "请先暂停，再切换设备并继续" }
            encoder?.devices = args
        }
        when (action) {
            "pause" -> encoder?.action = "paused"
            "resume" -> encoder?.action = "recording"
            "stop" -> encoder?.action = "stop"
        }
        return activeStore.view()
    }
    override fun onDestroy() {
        lifecycleHandler.removeCallbacks(epochWatchdog)
        encoder?.action = "stop"
        recordingActivity(false)
        if (wake?.isHeld == true) wake?.release()
        worker.shutdown(); instance = null; super.onDestroy()
    }
}

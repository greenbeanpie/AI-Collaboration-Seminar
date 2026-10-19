package cn.buwei.nativeapp.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import cn.buwei.nativeapp.MainActivity
import cn.buwei.nativeapp.NativeApplication
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.UUID

/** Never displays server-provided title, text, URL, or cross-account event content. */
class NativeMessagingService : FirebaseMessagingService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        serviceScope.launch {
            val repository = (application as NativeApplication).repository
            if (repository.accountId == null) return@launch
            // A failed registration is retried on the next foreground/sign-in token lookup.
            runCatching { repository.registerPushToken(token) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val repository = (application as NativeApplication).repository
        val accountId = repository.accountId ?: return
        if (message.data["userId"] != accountId) return
        val eventId = message.data["eventId"] ?: return
        if (runCatching { UUID.fromString(eventId) }.isFailure) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this,
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "协作通知", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(this, MainActivity::class.java).apply {
            action = "$packageName.NOTIFICATION.$eventId"
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("notificationEventId", eventId)
            putExtra("notificationAccountId", accountId)
        }
        val pending = PendingIntent.getActivity(this, eventId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        // A generic preview remains safe if permission/session changes after server dispatch.
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("补位")
            .setContentText("你有新的协作通知，登录后查看")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        // Persist bounded event IDs so a provider redelivery cannot resurrect a dismissed alert.
        if (repository.accountId == accountId && NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            val preferences = getSharedPreferences("native_push_seen", MODE_PRIVATE)
            val seen = preferences.getString("events_$accountId", "")!!.split(',').filter { it.isNotEmpty() }
            if (eventId in seen) return
            preferences.edit().putString("events_$accountId", (seen.takeLast(255) + eventId).joinToString(",")).apply()
            manager.notify(eventId, 0, notification)
        }
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    companion object { const val CHANNEL_ID = "collaboration" }
}

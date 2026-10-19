package cn.buwei.nativeapp.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import cn.buwei.nativeapp.MainActivity
import cn.buwei.nativeapp.NativeApplication
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/** Never displays server-provided title, text, URL, or cross-account event content. */
class NativeMessagingService : FirebaseMessagingService() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        completeCallback {
            val repository = (application as NativeApplication).repository
            repository.restore()
            val owner = repository.accountId ?: return@completeCallback
            repository.validateSession()
            if (repository.accountId == owner) repository.registerPushToken(token)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val eventId = message.data["eventId"] ?: return
        val expectedAccount = message.data["userId"] ?: return
        if (runCatching { UUID.fromString(eventId) }.isFailure) return
        completeCallback {
            val repository = (application as NativeApplication).repository
            val accountId = validatedPushAccount(expectedAccount, { repository.restore() }, { repository.accountId }) {
                repository.validateSession()["id"]!!.jsonPrimitive.content
            } ?: return@completeCallback
            showNotification(eventId, accountId)
        }
    }

    /** Firebase invokes callbacks on its background thread. Wait for bounded work so its
     * service cannot stop and cancel the validation as soon as the callback returns. */
    private fun completeCallback(block: suspend () -> Unit) = runBlocking {
        serviceScope.launch {
            try {
                withTimeout(8_000) { block() }
            } catch (_: TimeoutCancellationException) {
                (application as NativeApplication).repository.status.value = "即时通知验证超时，请打开应用查看站内通知"
                Log.w("NativePush", "Push session validation timed out")
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                // Includes damaged Keystore/local state: report the failure; do not restore,
                // reset credentials, or display a notification using an unvalidated account.
                (application as NativeApplication).repository.status.value = "即时通知未通过账户验证，请打开应用检查登录状态"
                Log.w("NativePush", "Push account validation failed: ${failure.javaClass.simpleName}")
            }
        }.join()
    }

    private fun showNotification(eventId: String, accountId: String) {
        val repository = (application as NativeApplication).repository
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

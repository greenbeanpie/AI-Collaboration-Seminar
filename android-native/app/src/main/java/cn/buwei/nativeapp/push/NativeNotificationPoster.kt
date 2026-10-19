package cn.buwei.nativeapp.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import cn.buwei.nativeapp.MainActivity
import cn.buwei.nativeapp.data.ClientRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID

/** Only explicit unread/non-dismissed server rows qualify; malformed rows fail closed. */
internal fun unreadNativeEventIds(feed: JsonObject): List<String> =
    (feed["items"] as? JsonArray).orEmpty().take(50).mapNotNull { item ->
        val entry = item as? JsonObject ?: return@mapNotNull null
        if (entry["readAt"] != JsonNull || entry["dismissedAt"] != JsonNull) return@mapNotNull null
        val id = entry["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        id.takeIf { runCatching { UUID.fromString(it) }.isSuccess }
    }.asReversed()

/** Shared generic alerts for FCM and the existing WorkManager sync worker. */
object NativeNotificationPoster {
    const val CHANNEL_ID = "collaboration"

    /** Caller must validate session/ownership first. Never accepts server notification copy or URLs. */
    @Synchronized
    fun post(repository: ClientRepository, eventId: String, expectedAccount: String, expectedEpoch: Long = repository.epoch): Boolean {
        if (repository.accountId != expectedAccount || repository.epoch != expectedEpoch) return false
        if (runCatching { UUID.fromString(eventId) }.isFailure) return false
        val context = repository.context
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context,
                Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val preferences = context.getSharedPreferences("native_push_seen", Context.MODE_PRIVATE)
        val seen = preferences.getString("events_$expectedAccount", "")!!.split(',').filter { it.isNotEmpty() }
        if (eventId in seen) return false

        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "协作通知", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(context, MainActivity::class.java).apply {
            action = "${context.packageName}.NOTIFICATION.$eventId"
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("notificationEventId", eventId)
            putExtra("notificationAccountId", expectedAccount)
        }
        val pending = PendingIntent.getActivity(context, eventId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("补位")
            .setContentText("你有新的协作通知，登录后查看")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build()
        if (repository.accountId != expectedAccount || repository.epoch != expectedEpoch) return false
        manager.notify(eventId, 0, notification)
        // The same lock covers FCM and polling so they cannot duplicate each other's alert.
        preferences.edit().putString("events_$expectedAccount", (seen.takeLast(255) + eventId).joinToString(",")).apply()
        return true
    }

    /** Best-effort supplement, called by the existing 15-minute worker. Failures never undo
     * completed workspace sync. Reads the newest server page only, up to 50 visible events. */
    suspend fun pollInbox(repository: ClientRepository): Int {
        return try {
            withTimeout(20_000) {
                repository.restore()
                val owner = repository.accountId ?: return@withTimeout 0
                val generation = repository.epoch
                repository.validateSession()
                if (repository.accountId != owner || repository.epoch != generation) return@withTimeout 0
                // networkJson deliberately avoids cached snapshots when proving current access.
                val settings = repository.networkJson("GET", "/notifications/settings")
                if (settings["pushEnabled"]?.jsonPrimitive?.booleanOrNull != true) return@withTimeout 0
                val feed = repository.networkJson("GET", "/notifications?limit=50")
                if (repository.accountId != owner || repository.epoch != generation) return@withTimeout 0
                var posted = 0
                // Process old to new so Android's newest alert reflects the newest inbox event.
                for (eventId in unreadNativeEventIds(feed)) {
                    if (post(repository, eventId, owner, generation)) posted++
                }
                posted
            }
        } catch (_: TimeoutCancellationException) {
            repository.status.value = "通知补查超时；站内通知将在联网后继续检查"
            0
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            repository.status.value = "通知补查未完成；请打开应用检查网络和登录状态"
            // Includes damaged local credentials. Report failure without logging token/content,
            // clearing accounts, or converting the already completed workspace sync to failure.
            Log.w("NativePush", "Inbox supplement failed: ${failure.javaClass.simpleName}")
            0
        }
    }
}

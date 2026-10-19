package cn.buwei.nativeapp.push

import android.app.NotificationManager
import android.content.Context
import cn.buwei.nativeapp.data.ClientRepository
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Call after session validation and whenever the app enters foreground. */
object NativePushRegistration {
    fun isAvailable(context: Context): Boolean =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS &&
            FirebaseApp.getApps(context).isNotEmpty()

    fun refresh(context: Context, repository: ClientRepository, scope: CoroutineScope) {
        if (FirebaseApp.getApps(context).isEmpty()) {
            repository.status.value = "即时通知未配置；仍可查看站内通知，后台约每 15 分钟补查（可能延迟）"
            return
        }
        if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) != ConnectionResult.SUCCESS) {
            repository.status.value = "设备缺少 Google 服务，即时通知不可用；后台约每 15 分钟补查（可能延迟）"
            return
        }
        if (repository.accountId == null) return
        val accountId = repository.accountId
        legacyRegistrationToken().addOnSuccessListener { token ->
            scope.launch {
                if (repository.accountId == accountId) {
                    try { repository.registerPushToken(token) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { repository.status.value = "即时通知注册未完成；站内通知与后台补查仍可使用" }
                }
            }
        }.addOnFailureListener { repository.status.value = "即时通知连接失败；站内通知与后台补查仍可使用" }
    }

    // The current manifest keeps Firebase's default registration-token mode and the backend
    // stores/sends that token. register() is not a drop-in replacement: it throws without
    // firebase_messaging_installation_id_enabled=true and reports an FID via onRegistered().
    // Keep this compatibility use isolated until manifest + server contracts migrate together.
    // https://firebase.google.com/docs/reference/android/com/google/firebase/messaging/FirebaseMessaging#register()
    @Suppress("DEPRECATION")
    private fun legacyRegistrationToken(): Task<String> = FirebaseMessaging.getInstance().token

    /** Call before clearing an account; the server separately revokes session-bound devices. */
    fun clearNotifications(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }
}

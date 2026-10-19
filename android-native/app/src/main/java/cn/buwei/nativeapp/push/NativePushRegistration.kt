package cn.buwei.nativeapp.push

import android.app.NotificationManager
import android.content.Context
import cn.buwei.nativeapp.data.ClientRepository
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Call after session validation and whenever the app enters foreground. */
object NativePushRegistration {
    fun isAvailable(context: Context): Boolean =
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS &&
            FirebaseApp.getApps(context).isNotEmpty()

    fun refresh(context: Context, repository: ClientRepository, scope: CoroutineScope) {
        if (repository.accountId == null || !isAvailable(context)) return
        val accountId = repository.accountId
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            scope.launch {
                if (repository.accountId == accountId) runCatching { repository.registerPushToken(token) }
            }
        }
    }

    /** Call before clearing an account; the server separately revokes session-bound devices. */
    fun clearNotifications(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }
}

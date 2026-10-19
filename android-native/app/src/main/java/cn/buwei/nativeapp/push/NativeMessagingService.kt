package cn.buwei.nativeapp.push

import android.util.Log
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
            NativeNotificationPoster.post(repository, eventId, accountId)
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

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    companion object { const val CHANNEL_ID = NativeNotificationPoster.CHANNEL_ID }
}

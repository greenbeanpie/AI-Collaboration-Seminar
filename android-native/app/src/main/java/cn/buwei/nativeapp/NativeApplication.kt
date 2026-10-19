package cn.buwei.nativeapp

import android.app.Application
import androidx.work.*
import cn.buwei.nativeapp.data.ClientRepository
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import java.util.concurrent.TimeUnit

class NativeApplication:Application() {
    val repository by lazy { ClientRepository(this) }
    val appearance by lazy {AppearancePreferences(this)}
    override fun onCreate() {
        super.onCreate()
        cn.buwei.nativeapp.features.NativeContracts.initialize(assets)
        if(BuildConfig.FIREBASE_APP_ID.isNotBlank() && BuildConfig.FIREBASE_API_KEY.isNotBlank() && BuildConfig.FIREBASE_PROJECT_ID.isNotBlank()) {
            FirebaseApp.initializeApp(this,FirebaseOptions.Builder().setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY).setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        }
        val constraints=Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("workspace-sync",ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15,TimeUnit.MINUTES).setConstraints(constraints).build())
    }
}
class SyncWorker(context:android.content.Context,params:WorkerParameters):CoroutineWorker(context,params) {
    override suspend fun doWork():Result {
        val repository=(applicationContext as NativeApplication).repository
        return try { if(repository.accountId==null) repository.restore(); repository.sync(); cn.buwei.nativeapp.push.NativeNotificationPoster.pollInbox(repository); Result.success() }
        catch(e:cn.buwei.nativeapp.data.ApiException) { Result.failure() }
        catch(e:java.io.IOException) { Result.retry() }
        catch(e:IllegalStateException) { Result.failure() }
    }
}

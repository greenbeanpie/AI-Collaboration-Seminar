package cn.buwei.nativeapp.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keystore key is non-exportable; a failed decryption fails closed, never regenerates credentials. */
class SecureStore(context: Context,namespace:String="") {
    private val prefs = context.getSharedPreferences(namespace+"native-secrets", Context.MODE_PRIVATE)
    private val key: SecretKey by lazy {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("buwei-native-session", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("buwei-native-session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized fun get(name: String): String? = prefs.getString(name, null)?.let { encoded ->
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 12) { "本机凭据已损坏，请重新登录" }
        Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE,key,GCMParameterSpec(128,bytes.copyOfRange(0,12))); doFinal(bytes.copyOfRange(12,bytes.size)).toString(Charsets.UTF_8) }
    }
    @Synchronized fun put(name: String,value: String?) {
        val edit=prefs.edit()
        if(value==null) edit.remove(name) else {
            val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key) }
            edit.putString(name,Base64.encodeToString(cipher.iv+cipher.doFinal(value.toByteArray()),Base64.NO_WRAP))
        }
        check(edit.commit()) { "本机安全存储写入失败" }
    }
}

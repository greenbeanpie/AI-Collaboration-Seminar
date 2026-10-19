package cn.buwei.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.map

internal class AccountReferencePreferences(private val store:DataStore<Preferences>) {
    private fun key(accountId:String):Preferences.Key<Boolean> {
        require(accountId.isNotBlank()) { "需要账户身份才能保存显示偏好" }
        return booleanPreferencesKey("ai-reference-badges:$accountId")
    }
    fun observe(accountId:String)=store.data.map { it[key(accountId)] ?: true }
    suspend fun setVisible(accountId:String,visible:Boolean) { store.edit { it[key(accountId)]=visible } }
}

internal data class ReferenceBadgeState(val visible:Boolean=true,val saving:Boolean=false,val message:String?=null,val setVisible:(Boolean)->Unit={})
internal val LocalReferenceBadges=staticCompositionLocalOf { ReferenceBadgeState() }

/** Preference belongs to the signed-in account and never changes server AI permissions. */
@Composable internal fun NativeReferencePreferences(preferences:AppearancePreferences,accountId:String?,content:@Composable ()->Unit) {
    NativeReferencePreferenceContent(accountId,{preferences.referenceBadges(requireNotNull(accountId))},{preferences.setReferenceBadges(requireNotNull(accountId),it)},content)
}

@Composable internal fun NativeReferencePreferenceContent(accountId:String?,observe:()->kotlinx.coroutines.flow.Flow<Boolean>,save:suspend (Boolean)->Unit,content:@Composable ()->Unit) {
    key(accountId) {
        val scope=rememberCoroutineScope()
        var visible by remember { mutableStateOf(false) }
        var loaded by remember { mutableStateOf(accountId==null) }
        var saving by remember { mutableStateOf(false) }
        var message by remember { mutableStateOf<String?>(null) }
        LaunchedEffect(accountId) {
            if(accountId!=null) try { observe().collect { visible=it; loaded=true } }
            catch(e:CancellationException){throw e}
            catch(_:Exception){visible=true;loaded=true;message="无法读取本机显示偏好，暂时显示标识。"}
        }
        CompositionLocalProvider(LocalReferenceBadges provides ReferenceBadgeState(visible,saving||!loaded,message) { next ->
            if(accountId!=null&&loaded&&!saving) {
                visible=next; saving=true; message=null
                scope.launch {
                    try { save(next) }
                    catch(e:CancellationException){throw e}
                    catch(_:Exception){message="已在当前页面生效，但本机未能保存此偏好。"}
                    finally { saving=false }
                }
            }
        },content=content)
    }
}

/** Separate semantics keep existing field labels discoverable; no generated-content claim. */
@Composable fun NativeAiReferenceBadge() {
    if(LocalReferenceBadges.current.visible) Surface(color=Color(0xFFDCEBFF),contentColor=Color(0xFF184D85),shape=MaterialTheme.shapes.small) {
        Text("AI 会引用",Modifier.padding(horizontal=6.dp,vertical=2.dp),style=MaterialTheme.typography.labelSmall)
    }
}

/** A label retains its exact accessible name while the decoration can wrap below it. */
@Composable internal fun ReferenceFieldLabel(text:String,aiReference:Boolean=true) {
    Column { Text(text); if(aiReference) Box(Modifier.clearAndSetSemantics {}) { NativeAiReferenceBadge() } }
}

@Composable internal fun NativeAppearanceSettings(theme:String,setTheme:suspend (String)->Unit) {
    val scope=rememberCoroutineScope(); val preference=LocalReferenceBadges.current
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("外观",style=MaterialTheme.typography.headlineMedium)
        listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach { (key,title) ->
            TextButton({scope.launch {try{setTheme(key);error=null}catch(e:CancellationException){throw e}catch(_:Exception){error="未能保存主题，请重试。"}}}) {Text((if(theme==key)"✓ "else "")+title)}
        }
        error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
        HorizontalDivider()
        Text("AI 内容引用标识",style=MaterialTheme.typography.titleLarge)
        Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            Text("显示 AI 内容引用标识",Modifier.weight(1f))
            Switch(preference.visible,preference.setVisible,Modifier.semantics { contentDescription="显示 AI 内容引用标识" },enabled=!preference.saving)
        }
        Text("在项目中可供 AI 引用的内容旁显示蓝色标识。此显示偏好按当前账户保存在本机，关闭后仍保留原有 AI 使用权限。")
        if(preference.visible) {Text("标识预览：");NativeAiReferenceBadge()}
        preference.message?.let {Text(it,color=MaterialTheme.colorScheme.error)}
    }
}

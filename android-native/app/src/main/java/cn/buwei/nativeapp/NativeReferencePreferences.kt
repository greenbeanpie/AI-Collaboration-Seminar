package cn.buwei.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.testTag
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

/** A full-height heading. Text-field callers must place this above the input, never in a floating label slot. */
@Composable internal fun ReferenceFieldLabel(text:String,modifier:Modifier=Modifier,aiReference:Boolean=true,decorative:Boolean=false) {
    Column(modifier.testTag("reference-heading:$text"),verticalArrangement=Arrangement.spacedBy(4.dp)) {
        Text(text,if(decorative)Modifier.clearAndSetSemantics { testTag="reference-title:$text" } else Modifier.testTag("reference-title:$text"),style=MaterialTheme.typography.bodyLarge)
        if(aiReference&&LocalReferenceBadges.current.visible) Box(Modifier.clearAndSetSemantics { testTag="reference-badge:$text" }) { NativeAiReferenceBadge() }
    }
}

@Composable internal fun NativeAppearanceSettings(theme:String,design:String="classic",setDesign:suspend (String)->Unit={},setTheme:suspend (String)->Unit) {
    val scope=rememberCoroutineScope(); val preference=LocalReferenceBadges.current
    var error by remember { mutableStateOf<String?>(null) };var saving by remember{mutableStateOf(false)}
    fun save(change:suspend()->Unit){if(saving)return;saving=true;scope.launch{try{change();error=null}catch(e:CancellationException){throw e}catch(_:Exception){error="未能保存外观，请重试。"}finally{saving=false}}}
    val dark=theme=="dark"||(theme=="system"&&isSystemInDarkTheme())
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("外观",style=MaterialTheme.typography.headlineMedium)
        Text("主题设计",style=MaterialTheme.typography.titleLarge)
        Text("选择配色与卡片风格，立即应用到整个应用，并保存在此设备。",style=MaterialTheme.typography.bodyMedium)
        listOf("classic" to "经典绿","prototype" to "舒展蓝").forEach{(key,title)->
            NativeTheme(dark,key){
                OutlinedCard(Modifier.fillMaxWidth().testTag("theme-design:$key").clip(MaterialTheme.shapes.medium).selectable(design==key,enabled=!saving,role=Role.RadioButton,onClick={save{setDesign(key)}}),
                    border=BorderStroke(if(design==key)2.dp else 1.dp,if(design==key)MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)){
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
                        Row(verticalAlignment=androidx.compose.ui.Alignment.CenterVertically){
                            RadioButton(selected=design==key,onClick=null,enabled=!saving)
                            Column(Modifier.weight(1f)){Text(title,style=MaterialTheme.typography.titleMedium);Text(if(key=="prototype")"蓝色强调 · 冷灰底色 · 舒展卡片"else"绿色强调 · 温和底色 · 经典样式",style=MaterialTheme.typography.bodyMedium)}
                        }
                        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                            listOf(MaterialTheme.colorScheme.primary,MaterialTheme.colorScheme.secondary,MaterialTheme.colorScheme.tertiary).forEach{color->Surface(color=color,shape=MaterialTheme.shapes.small,modifier=Modifier.size(28.dp)) {}}
                        }
                        Surface(color=MaterialTheme.colorScheme.primaryContainer,contentColor=MaterialTheme.colorScheme.onPrimaryContainer,shape=MaterialTheme.shapes.small){Text("配色预览 · 项目工作区",Modifier.padding(10.dp),style=MaterialTheme.typography.bodyMedium)}
                    }
                }
            }
        }
        Text("明暗模式",style=MaterialTheme.typography.titleLarge)
        FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){
            listOf("system" to "跟随系统","light" to "浅色","dark" to "深色").forEach { (key,title) ->
                TextButton({save{setTheme(key)}},enabled=!saving) {Text((if(theme==key)"✓ "else "")+title)}
            }
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

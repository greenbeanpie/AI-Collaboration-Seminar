package cn.buwei.nativeapp

import android.content.Context
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map

private val Context.appearanceStore by preferencesDataStore("appearance")
data class NativeAppearance(val mode:String="system",val design:String="classic")
internal val nativeThemeDesigns=listOf("classic","prototype")
internal fun normalizedAppearance(mode:String?,design:String?)=NativeAppearance(
    mode?.takeIf{it in listOf("system","light","dark")}?:"system",
    design?.takeIf{it in nativeThemeDesigns}?:"classic"
)
class AppearancePreferences internal constructor(private val store:DataStore<Preferences>) {
    constructor(context:Context):this(context.applicationContext.appearanceStore)
    private val key=stringPreferencesKey("theme")
    private val designKey=stringPreferencesKey("design")
    val settings=store.data.map {normalizedAppearance(it[key],it[designKey])}
    val mode=settings.map {it.mode}
    val design=settings.map {it.design}
    private val references=AccountReferencePreferences(store)
    fun referenceBadges(accountId:String)=references.observe(accountId)
    suspend fun setReferenceBadges(accountId:String,visible:Boolean)=references.setVisible(accountId,visible)
    suspend fun setMode(mode:String) {require(mode in listOf("system","light","dark"));store.edit {it[key]=mode}}
    suspend fun setDesign(design:String) {require(design in nativeThemeDesigns);store.edit {it[designKey]=design}}
}

@Composable fun NativeTheme(dark:Boolean=false,design:String="classic",content:@Composable ()->Unit) {
    val palette=if(design=="prototype") prototypeColorScheme(dark) else if(dark) darkColorScheme(
        primary=Color(0xFF9DD2B9),secondary=Color(0xFFB7CCBF),primaryContainer=Color(0xFF204E3B),secondaryContainer=Color(0xFF384D42),
        background=Color(0xFF111512),surface=Color(0xFF111512),surfaceVariant=Color(0xFF414942),surfaceTint=Color(0xFF9DD2B9),
        surfaceContainerLowest=Color(0xFF0C100D),surfaceContainerLow=Color(0xFF191E1A),surfaceContainer=Color(0xFF1D231F),surfaceContainerHigh=Color(0xFF272D28),surfaceContainerHighest=Color(0xFF323833),outline=Color(0xFF8B958D),outlineVariant=Color(0xFF414942)
    ) else lightColorScheme(
        primary=Color(0xFF356B56),secondary=Color(0xFF52685C),primaryContainer=Color(0xFFB9E4CE),secondaryContainer=Color(0xFFD5E9DC),
        background=Color(0xFFF8FAF6),surface=Color(0xFFF8FAF6),surfaceVariant=Color(0xFFDFE6DF),surfaceTint=Color(0xFF356B56),
        surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFF0F5EF),surfaceContainer=Color(0xFFEAF0E9),surfaceContainerHigh=Color(0xFFE4EAE3),surfaceContainerHighest=Color(0xFFDDE4DC),outline=Color(0xFF717B73),outlineVariant=Color(0xFFC1CBC2)
    )
    MaterialTheme(colorScheme=palette,shapes=if(design=="prototype") prototypeShapes else Shapes(),typography=if(design=="prototype") prototypeTypography else Typography(),content=content)
}

package cn.buwei.nativeapp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
class PrototypeThemeTest {
 @Test fun classicForegroundsUseGreenTonesAndReadableContrast(){
  assertEquals(Color(0xFF002116),classicColorScheme(false).onPrimaryContainer)
  assertEquals(Color(0xFFB9E4CE),classicColorScheme(true).onPrimaryContainer)
  for(dark in listOf(false,true)){
   val p=classicColorScheme(dark)
   for((fg,bg) in listOf(p.onPrimary to p.primary,p.onPrimaryContainer to p.primaryContainer,p.onSecondary to p.secondary,p.onSecondaryContainer to p.secondaryContainer,p.onBackground to p.background,p.onSurface to p.surface,p.onSurfaceVariant to p.surfaceVariant)){
    val ratio=(max(fg.luminance(),bg.luminance())+0.05f)/(min(fg.luminance(),bg.luminance())+0.05f)
    assertTrue("classic dark=$dark contrast=$ratio",ratio>=4.5f)
   }
  }
 }
 @Test fun oldAndUnknownPreferencesKeepClassicSystemDefaults(){assertEquals(NativeAppearance(),normalizedAppearance(null,null));assertEquals(NativeAppearance("dark","classic"),normalizedAppearance("dark",null));assertEquals(NativeAppearance(),normalizedAppearance("unknown","unknown"))}
 @Test fun designAndModeAreIndependent(){assertEquals(NativeAppearance("system","prototype"),normalizedAppearance("system","prototype"));assertEquals(NativeAppearance("dark","prototype"),normalizedAppearance("dark","prototype"))}
 @Test fun lightPaletteUsesMobilePrototypeTokens(){val p=prototypeColorScheme(false);assertEquals(Color(0xFF2563EB),p.primary);assertEquals(Color(0xFFF5F7FB),p.background);assertEquals(Color.White,p.surface);assertEquals(Color(0xFF141824),p.onSurface)}
 @Test fun darkPaletteUsesPrototypeLayersWithReadableBlue(){val p=prototypeColorScheme(true);assertEquals(Color(0xFF161B26),p.background);assertEquals(Color(0xFF222A3B),p.surface);assertEquals(Color(0xFF60A5FA),p.primary)}
 @Test fun normalTextAndAccentPairsMeetContrastInBothModes(){for(dark in listOf(false,true)){val p=prototypeColorScheme(dark);for((fg,bg) in listOf(p.onBackground to p.background,p.onSurface to p.surface,p.onSurfaceVariant to p.surface,p.primary to p.surface,p.onPrimary to p.primary,p.onPrimaryContainer to p.primaryContainer,p.onSecondary to p.secondary,p.onSecondaryContainer to p.secondaryContainer,p.onTertiary to p.tertiary,p.onError to p.error,p.onErrorContainer to p.errorContainer)){val ratio=(max(fg.luminance(),bg.luminance())+0.05f)/(min(fg.luminance(),bg.luminance())+0.05f);assertTrue("dark=$dark contrast=$ratio",ratio>=4.5f)}}}
}

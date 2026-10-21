package cn.buwei.nativeapp

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Native tokens from windows-native/Tests/Fixtures/prototype-theme.css.
 * Mobile .phone-screen/.m-card use a cool page, opaque cards and 15 px corners.
 * No bitmap, blur layer, downloaded font, WebView or per-frame work is required.
 */
internal fun prototypeColorScheme(dark:Boolean):ColorScheme=if(dark) darkColorScheme(
 primary=Color(0xFF60A5FA),onPrimary=Color(0xFF0B1830),primaryContainer=Color(0xFF203459),onPrimaryContainer=Color(0xFFBFDBFE),inversePrimary=Color(0xFF2563EB),
 secondary=Color(0xFFA78BFA),onSecondary=Color(0xFF221044),secondaryContainer=Color(0xFF302641),onSecondaryContainer=Color(0xFFDDD6FE),
 tertiary=Color(0xFF5EEAD4),onTertiary=Color(0xFF00382F),tertiaryContainer=Color(0xFF153D3C),onTertiaryContainer=Color(0xFF99F6E4),
 background=Color(0xFF161B26),onBackground=Color(0xFFF1F5F9),surface=Color(0xFF222A3B),onSurface=Color(0xFFF1F5F9),surfaceVariant=Color(0xFF283248),onSurfaceVariant=Color(0xFFB4C0D3),
 surfaceTint=Color(0xFF60A5FA),surfaceContainerLowest=Color(0xFF0B0F17),surfaceContainerLow=Color(0xFF1A2130),surfaceContainer=Color(0xFF222A3B),surfaceContainerHigh=Color(0xFF283248),surfaceContainerHighest=Color(0xFF303C53),
 outline=Color(0xFF7C879C),outlineVariant=Color(0xFF3C465A),inverseSurface=Color(0xFFF1F5F9),inverseOnSurface=Color(0xFF141824),
 error=Color(0xFFFCA5A5),onError=Color(0xFF450A0A),errorContainer=Color(0xFF4A252E),onErrorContainer=Color(0xFFFEE2E2),scrim=Color.Black
)else lightColorScheme(
 primary=Color(0xFF2563EB),onPrimary=Color.White,primaryContainer=Color(0xFFEBF2FF),onPrimaryContainer=Color(0xFF1D4ED8),inversePrimary=Color(0xFF93C5FD),
 secondary=Color(0xFF6D28D9),onSecondary=Color.White,secondaryContainer=Color(0xFFF3E8FF),onSecondaryContainer=Color(0xFF6D28D9),
 tertiary=Color(0xFF0F766E),onTertiary=Color.White,tertiaryContainer=Color(0xFFCCFBF1),onTertiaryContainer=Color(0xFF0F766E),
 background=Color(0xFFF5F7FB),onBackground=Color(0xFF141824),surface=Color.White,onSurface=Color(0xFF141824),surfaceVariant=Color(0xFFF7F9FC),onSurfaceVariant=Color(0xFF4E586E),
 surfaceTint=Color(0xFF2563EB),surfaceContainerLowest=Color.White,surfaceContainerLow=Color(0xFFF7F9FC),surfaceContainer=Color.White,surfaceContainerHigh=Color(0xFFECF0F7),surfaceContainerHighest=Color(0xFFF7F9FC),
 outline=Color(0xFF7C879C),outlineVariant=Color(0xFFE6EAF2),inverseSurface=Color(0xFF222A3B),inverseOnSurface=Color(0xFFF1F5F9),
 error=Color(0xFFDC2626),onError=Color.White,errorContainer=Color(0xFFFEE2E2),onErrorContainer=Color(0xFFB91C1C),scrim=Color.Black
)
internal val prototypeShapes=Shapes(
 extraSmall=RoundedCornerShape(7.dp),small=RoundedCornerShape(10.dp),medium=RoundedCornerShape(15.dp),large=RoundedCornerShape(20.dp),extraLarge=RoundedCornerShape(24.dp)
)
// Keep Android's system fonts and scalable type; do not copy the desktop's compact pixel sizes.
internal val prototypeTypography=Typography().let{it.copy(
 headlineMedium=it.headlineMedium.copy(fontWeight=FontWeight.Bold),
 titleLarge=it.titleLarge.copy(fontWeight=FontWeight.SemiBold),
 titleMedium=it.titleMedium.copy(fontWeight=FontWeight.Bold,letterSpacing=0.sp),
 bodyLarge=it.bodyLarge.copy(lineHeight=26.sp,letterSpacing=0.sp),
 bodyMedium=it.bodyMedium.copy(lineHeight=22.sp,letterSpacing=0.sp),
 labelLarge=it.labelLarge.copy(fontWeight=FontWeight.SemiBold,letterSpacing=0.sp)
)}

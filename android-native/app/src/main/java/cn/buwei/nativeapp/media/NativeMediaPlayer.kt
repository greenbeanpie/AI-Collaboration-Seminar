package cn.buwei.nativeapp.media

import android.net.Uri
import android.view.SurfaceView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import kotlinx.coroutines.delay
import java.io.File

/** No media3-ui dependency: its optional HTML subtitle backend embeds a WebView. */
@Composable internal fun NativeMediaPlayer(file:File) {
    val context=LocalContext.current
    var position by rememberSaveable(file.path){mutableLongStateOf(0L)}
    var duration by remember(file.path){mutableLongStateOf(0L)}
    var playing by remember(file.path){mutableStateOf(false)}
    var failure by remember(file.path){mutableStateOf<String?>(null)}
    val player=remember(file.path){ExoPlayer.Builder(context).build().apply {setMediaItem(MediaItem.fromUri(Uri.fromFile(file)));seekTo(position);prepare()}}
    DisposableEffect(player) {
        val listener=object:Player.Listener {
            override fun onIsPlayingChanged(isPlaying:Boolean){playing=isPlaying}
            override fun onPlaybackStateChanged(playbackState:Int){duration=player.duration.coerceAtLeast(0)}
            override fun onPlayerError(error:androidx.media3.common.PlaybackException){failure="媒体播放失败：${error.errorCodeName}"}
        }
        player.addListener(listener)
        onDispose {player.removeListener(listener);player.clearVideoSurface();player.release()}
    }
    LaunchedEffect(player){while(true){position=player.currentPosition.coerceAtLeast(0);duration=player.duration.coerceAtLeast(0);delay(250)}}
    Column(Modifier.fillMaxWidth(),verticalArrangement=Arrangement.spacedBy(8.dp)) {
        if(file.extension.lowercase() in listOf("mp4","webm"))AndroidView(
            factory={SurfaceView(it).also(player::setVideoSurfaceView)},modifier=Modifier.fillMaxWidth().height(240.dp)
        )
        failure?.let {Text(it,color=MaterialTheme.colorScheme.error)}
        Text("${time(position)} / ${time(duration)}",style=MaterialTheme.typography.bodySmall)
        Slider(value=if(duration>0)(position.toDouble()/duration).toFloat().coerceIn(0f,1f) else 0f,
            onValueChange={fraction->position=(duration*fraction).toLong();player.seekTo(position)},enabled=duration>0)
        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
            Button(onClick={if(playing)player.pause() else {if(player.playbackState==Player.STATE_ENDED)player.seekTo(0);player.play()}},enabled=failure==null){Text(if(playing)"暂停播放"else"播放")}
            OutlinedButton(onClick={player.pause();player.seekTo(0);position=0}){Text("回到开头")}
        }
    }
}
private fun time(value:Long):String {val seconds=value/1000;return "${seconds/60}:${(seconds%60).toString().padStart(2,'0')}"}

package cn.buwei.nativeapp

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import cn.buwei.nativeapp.data.NativeAuth

/** Navigation and recoverable operation state survive Activity configuration changes. */
class NativeViewModel(application:Application):AndroidViewModel(application) {
    val repository=(application as NativeApplication).repository
    val auth=NativeAuth(repository)
    var fatal by mutableStateOf<String?>(null)
    var busy by mutableStateOf(true)
    var section by mutableStateOf("projects")
    var projectId by mutableStateOf<String?>(null)
}

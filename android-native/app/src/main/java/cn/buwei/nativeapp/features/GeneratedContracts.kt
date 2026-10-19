// Generated from backend/openapi/openapi.json. Run node android-native/scripts/generate-contracts.mjs.
package cn.buwei.nativeapp.features

import android.content.res.AssetManager
import kotlinx.serialization.json.*

internal data class NativeOperation(val method:String,val path:String,val title:String,val tag:String,val parameters:JsonArray,val schema:JsonObject,val binary:Boolean)
internal object NativeContracts {
 private lateinit var assets:AssetManager
 fun initialize(manager:AssetManager) { assets=manager }
 val operations:List<NativeOperation> by lazy { decode(assets.open("native-contracts.json").bufferedReader().use { it.readText() }) }
 fun decode(source:String):List<NativeOperation> = Json.parseToJsonElement(source).jsonArray.map { entry->val o=entry.jsonObject
  NativeOperation(o["method"]!!.jsonPrimitive.content,o["path"]!!.jsonPrimitive.content,o["title"]!!.jsonPrimitive.content,o["tag"]!!.jsonPrimitive.content,o["parameters"]!!.jsonArray,o["schema"]!!.jsonObject,o["binary"]!!.jsonPrimitive.boolean)
 }
}

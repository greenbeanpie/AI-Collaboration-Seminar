package cn.buwei.nativeapp

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp

/**
 * The String Material3 overload only supports a floating label; a multiline heading plus
 * badge can extend above its measured container. Keep the controlled value/onValueChange
 * contract and allocate the heading its own normal layout space instead.
 *
 * The input owns the label's Text semantics, just as the merged Material3 label normally
 * does. Its SetText/InsertTextAtCursor actions stay on that same node. The visual heading
 * is decorative so assistive tools and onNodeWithText(label) find exactly one named input.
 */
@Composable internal fun ReferenceOutlinedTextField(
    value:String,
    onValueChange:(String)->Unit,
    modifier:Modifier=Modifier,
    label:String,
    aiReference:Boolean=true,
    enabled:Boolean=true,
    readOnly:Boolean=false,
    minLines:Int=1,
    maxLines:Int=Int.MAX_VALUE,
    singleLine:Boolean=false,
    keyboardOptions:KeyboardOptions=KeyboardOptions.Default,
    supportingText:(@Composable ()->Unit)?=null,
) {
    Column(modifier,verticalArrangement=Arrangement.spacedBy(8.dp)) {
        ReferenceFieldLabel(label,Modifier.fillMaxWidth(),aiReference=aiReference,decorative=true)
        OutlinedTextField(
            value=value,
            onValueChange=onValueChange,
            modifier=Modifier.fillMaxWidth().testTag("reference-input:$label").semantics { text=AnnotatedString(label) },
            enabled=enabled,
            readOnly=readOnly,
            minLines=minLines,
            maxLines=maxLines,
            singleLine=singleLine,
            keyboardOptions=keyboardOptions,
            supportingText=supportingText,
        )
    }
}

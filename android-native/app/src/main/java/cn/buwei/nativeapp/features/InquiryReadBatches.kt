package cn.buwei.nativeapp.features

import kotlinx.coroutines.CancellationException

internal data class InquiryReadProgress(
    val messageIds:List<String>,
    val processedCount:Int=0,
    val newlyReadCount:Int=0,
    val failureMessage:String?=null,
) {
    val remainingCount:Int get()=messageIds.size-processedCount
}

/** Copy the displayed list once. Future loads or replies never expand an in-flight read intent. */
internal fun inquiryReadSnapshot(displayedIds:List<String>)=InquiryReadProgress(displayedIds.filter(String::isNotBlank).distinct().toList())

/** No retries: an uncertain/failed batch remains pending until a person explicitly resumes it. */
internal suspend fun markDisplayedInquiryMessages(
    progress:InquiryReadProgress,
    assertCurrentAccount:()->Unit,
    postBatch:suspend (List<String>)->Int,
    onProgress:(InquiryReadProgress)->Unit={},
):InquiryReadProgress {
    require(progress.processedCount in 0..progress.messageIds.size&&progress.newlyReadCount>=0)
    require(progress.messageIds.none(String::isBlank)&&progress.messageIds.distinct().size==progress.messageIds.size)
    var current=progress.copy(failureMessage=null)
    try {
        for(batch in current.messageIds.drop(current.processedCount).chunked(200)) {
            assertCurrentAccount()
            val newlyRead=postBatch(batch)
            assertCurrentAccount()
            require(newlyRead in 0..batch.size){"服务端返回了无效的新增已读数量，请刷新核对"}
            current=current.copy(processedCount=current.processedCount+batch.size,newlyReadCount=current.newlyReadCount+newlyRead)
            onProgress(current)
        }
    }catch(e:CancellationException){throw e}
    catch(e:Exception){return current.copy(failureMessage=e.message?:"标记已读失败")}
    return current
}

package cn.buwei.nativeapp.features

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class InquiryReadBatchesTest {
    @Test fun moreThanTwoHundredDisplayedMessagesAreDeduplicatedAndBatchedWithoutTruncation()=runBlocking {
        val ids=(1..401).map{"message-$it"};val calls=mutableListOf<List<String>>()
        val snapshot=inquiryReadSnapshot(ids+ids.take(25)+listOf(""," "))
        val counts=listOf(5,0,1)
        val result=markDisplayedInquiryMessages(snapshot,{},postBatch={batch->calls.add(batch);counts[calls.lastIndex]})
        assertEquals(listOf(200,200,1),calls.map(List<String>::size));assertEquals(ids,calls.flatten());assertEquals(401,result.processedCount);assertEquals(6,result.newlyReadCount);assertEquals(0,result.remainingCount);assertNull(result.failureMessage)
    }
    @Test fun snapshotNeverIncludesMessagesLoadedDuringTheOperation()=runBlocking {
        val displayed=(1..201).map{"message-$it"}.toMutableList();val snapshot=inquiryReadSnapshot(displayed);val calls=mutableListOf<List<String>>()
        markDisplayedInquiryMessages(snapshot,{},postBatch={batch->calls.add(batch);displayed.add("unloaded-message");0})
        assertEquals(201,calls.flatten().size);assertFalse(calls.flatten().contains("unloaded-message"));assertEquals(listOf(200,1),calls.map(List<String>::size))
    }
    @Test fun failureStopsLaterBatchesAndManualResumeSkipsOnlyConfirmedPrefix()=runBlocking {
        val ids=(1..401).map{"message-$it"};val calls=mutableListOf<List<String>>()
        val failed=markDisplayedInquiryMessages(inquiryReadSnapshot(ids),{},postBatch={batch->calls.add(batch);if(calls.size==2)throw IllegalStateException("结果待核对");7})
        assertEquals(2,calls.size);assertEquals(200,failed.processedCount);assertEquals(7,failed.newlyReadCount);assertEquals(201,failed.remainingCount);assertEquals("结果待核对",failed.failureMessage)
        val continued=mutableListOf<List<String>>()
        val result=markDisplayedInquiryMessages(failed,{},postBatch={batch->continued.add(batch);if(continued.size==1)0 else 1})
        assertEquals(ids.drop(200),continued.flatten());assertEquals(401,result.processedCount);assertEquals(8,result.newlyReadCount);assertNull(result.failureMessage)
    }
    @Test fun changedAccountBeforeStartMakesNoWrite()=runBlocking {
        var writes=0
        val result=markDisplayedInquiryMessages(inquiryReadSnapshot(listOf("message-1")),{error("账户已变化")},postBatch={writes++;1})
        assertEquals(0,writes);assertEquals(0,result.processedCount);assertEquals("账户已变化",result.failureMessage)
    }
    @Test fun accountOrEpochChangeAfterFirstRequestPreventsEveryAdditionalWrite()=runBlocking {
        var sameAccount=true;var writes=0
        val result=markDisplayedInquiryMessages(inquiryReadSnapshot((1..401).map{"message-$it"}),{check(sameAccount){"账户会话已变化"}},postBatch={writes++;sameAccount=false;1})
        assertEquals(1,writes);assertEquals(0,result.processedCount);assertEquals(0,result.newlyReadCount);assertEquals("账户会话已变化",result.failureMessage)
    }
    @Test fun epochChangeBetweenConfirmedBatchesMakesNoAdditionalWrite()=runBlocking {
        var epoch=1;var writes=0
        val result=markDisplayedInquiryMessages(inquiryReadSnapshot((1..401).map{"message-$it"}),{check(epoch==1){"会话已变化"}},postBatch={writes++;3},onProgress={epoch++})
        assertEquals(1,writes);assertEquals(200,result.processedCount);assertEquals(3,result.newlyReadCount);assertEquals(201,result.remainingCount);assertEquals("会话已变化",result.failureMessage)
    }
    @Test fun malformedReadCountCannotBecomeAFalseCompletionOrContinueAutomatically()=runBlocking {
        var writes=0
        val result=markDisplayedInquiryMessages(inquiryReadSnapshot((1..201).map{"message-$it"}),{},postBatch={writes++;201})
        assertEquals(1,writes);assertEquals(0,result.processedCount);assertEquals(0,result.newlyReadCount);assertNotNull(result.failureMessage)
    }
    @Test fun cancelledScreenPropagatesCancellationWithoutStartingLaterBatches()=runBlocking {
        var writes=0
        try{markDisplayedInquiryMessages(inquiryReadSnapshot((1..201).map{"message-$it"}),{},postBatch={writes++;throw CancellationException("screen closed")});fail("cancellation must propagate")}catch(_:CancellationException){}
        assertEquals(1,writes)
    }
}

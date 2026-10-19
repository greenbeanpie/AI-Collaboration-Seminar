package cn.buwei.nativeapp

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test

class AccountReferencePreferencesTest {
    @Test fun preferenceIsAccountIsolatedAndSurvivesReopening()=runBlocking {
        val file=File.createTempFile("reference-badges", ".preferences_pb").also { it.delete() }
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
        val preferences=AccountReferencePreferences(PreferenceDataStoreFactory.create(scope=scope,produceFile={file}))
        try {
            assertTrue(preferences.observe("a").first())
            preferences.setVisible("a",false)
            assertFalse(preferences.observe("a").first())
            assertTrue(preferences.observe("b").first())
            preferences.setVisible("b",true)
            assertFalse(preferences.observe("a").first())
        } finally { scope.coroutineContext[Job]!!.cancelAndJoin() }
        val reopenedScope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
        try {
            val reopened=AccountReferencePreferences(PreferenceDataStoreFactory.create(scope=reopenedScope,produceFile={file}))
            assertFalse(reopened.observe("a").first())
            assertTrue(reopened.observe("b").first())
            reopened.setVisible("a",true)
            assertTrue(reopened.observe("a").first())
        } finally { reopenedScope.coroutineContext[Job]!!.cancelAndJoin();file.delete() }
    }
    @Test fun missingAccountCannotCreateGlobalPreference()=runBlocking {
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
        val file=File.createTempFile("reference-anonymous", ".preferences_pb").also{it.delete()}
        try {
            val preferences=AccountReferencePreferences(PreferenceDataStoreFactory.create(scope=scope,produceFile={file}))
            try { preferences.setVisible("",false);fail("anonymous write accepted") } catch(_:IllegalArgumentException){}
            assertTrue(preferences.observe("valid-account").first())
        } finally {scope.coroutineContext[Job]!!.cancelAndJoin();file.delete()}
    }
}

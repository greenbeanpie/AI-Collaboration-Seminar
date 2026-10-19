package cn.buwei.nativeapp.baselineprofile

import androidx.benchmark.macro.junit4.BaselineProfileRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Until
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Auth-free startup only. Does not make production writes or call AI. */
@RunWith(AndroidJUnit4::class)
class StartupProfile {
    @get:Rule val baseline=BaselineProfileRule()
    @Test fun loginStartup()=baseline.collect(packageName="cn.buwei.mobile.nativepreview",includeInStartupProfile=true) {
        pressHome();startActivityAndWait()
        check(device.wait(Until.hasObject(By.text("登录 / 注册")),15000)) {"Native login did not render"}
    }
}

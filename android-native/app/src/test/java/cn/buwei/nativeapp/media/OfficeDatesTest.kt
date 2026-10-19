package cn.buwei.nativeapp.media

import org.junit.Assert.assertEquals
import org.junit.Test

class OfficeDatesTest {
    @Test fun excelEpochsAndLeapYearCompatibility() {
        assertEquals("1900-01-01",OfficeDates.format("1",14,null,false))
        assertEquals("1900-02-29",OfficeDates.format("60",14,null,false))
        assertEquals("1900-03-01",OfficeDates.format("61",14,null,false))
        assertEquals("1904-01-01",OfficeDates.format("0",14,null,true))
    }
    @Test fun datesTimesAndOrdinaryQuantitiesStayDistinct() {
        assertEquals("2024-01-01",OfficeDates.format("45292",14,null,false))
        assertEquals("12:00",OfficeDates.format("0.5",20,null,false))
        assertEquals("2024-01-01 12:00",OfficeDates.format("45292.5",0,"yyyy-mm-dd hh:mm",false))
        assertEquals("45292",OfficeDates.format("45292",0,"0.00",false))
        assertEquals("45292",OfficeDates.format("45292",0,"0.00 \"days\"",false))
        assertEquals("[公式 A1+1：无已保存结果]",OfficeDates.format("[公式 A1+1：无已保存结果]",14,null,false))
    }
}

package com.cortoba.fieldops.ui.components

import com.cortoba.fieldops.ui.theme.StatusGrey
import com.cortoba.fieldops.ui.theme.StatusGreen
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A status chip must never be able to take a screen down.
 *
 * Every status field is optional on the wire: a payload that omits it arrives
 * as null. Calling a method on it (or forcing it non-null) crashed the whole
 * screen — the reported «الأزرار مش شغالة» on the receiving screen. This pins
 * the null handling so a future edit cannot reintroduce the crash.
 */
class StatusChipPresentationTest {

    @Test
    fun `a known status maps to its Arabic label`() {
        assertEquals("تم الاستلام" to StatusGreen, statusPresentation("RECEIVED"))
    }

    @Test
    fun `a missing status is rendered as a dash, never a crash`() {
        assertEquals("—" to StatusGrey, statusPresentation(null))
    }
}

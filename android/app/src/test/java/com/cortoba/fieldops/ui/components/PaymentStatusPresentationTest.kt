package com.cortoba.fieldops.ui.components

import com.cortoba.fieldops.ui.theme.StatusAmber
import com.cortoba.fieldops.ui.theme.StatusGreen
import com.cortoba.fieldops.ui.theme.StatusGrey
import com.cortoba.fieldops.ui.theme.StatusRed
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The supplier card must answer one question — "is this supplier settled?" —
 * with a plain Arabic word and never a money figure. This pins the mapping so a
 * future edit cannot leak an amount into the label or swap the colour semantics.
 */
class PaymentStatusPresentationTest {

    @Test
    fun `paid maps to the settled label`() {
        assertEquals("مسدد" to StatusGreen, paymentStatusPresentation("paid"))
    }

    @Test
    fun `partial maps to the partial label`() {
        assertEquals("سداد جزئي" to StatusAmber, paymentStatusPresentation("partial"))
    }

    @Test
    fun `unpaid maps to the unsettled label`() {
        assertEquals("غير مسدد" to StatusRed, paymentStatusPresentation("unpaid"))
    }

    @Test
    fun `unknown status is shown verbatim and never guessed`() {
        assertEquals("weird" to StatusGrey, paymentStatusPresentation("weird"))
    }
}

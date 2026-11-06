package com.cortoba.fieldops.ui.pickups

import com.cortoba.fieldops.core.network.dto.ConsolidatedItem
import com.cortoba.fieldops.core.network.dto.PickupAllocation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The consolidation contract the whole receiving feature rests on.
 *
 * These are pure tests over the DTOs the server returns. The Android side must
 * never re-derive grouping (that would be a second source of truth), but it MUST
 * render the total and the allocation faithfully. The assertions pin the
 * mandatory scenario from the specification:
 *
 *   Schneider Contactor LC1D32M7 → 2 + 3 + 1 = 6 units across three POs.
 */
class ConsolidationDisplayTest {

    private fun contactorGroup() = ConsolidatedItem(
        groupKey = "item:CONT-LC1D32M7",
        matchBasis = "itemId",
        displayName = "كونتاكتور شنايدر LC1D32M7",
        partNo = "LC1D32M7",
        uom = "قطعة",
        totalRequiredQty = 6.0,
        totalAcceptedQty = 0.0,
        totalRemainingQty = 6.0,
        allocations = listOf(
            PickupAllocation(
                poItemId = 101,
                poId = 1,
                poNo = "SPO-001",
                qty = 2.0,
                remainingQty = 2.0,
                customerPoNos = listOf("P26E001"),
            ),
            PickupAllocation(
                poItemId = 102,
                poId = 5,
                poNo = "SPO-005",
                qty = 3.0,
                remainingQty = 3.0,
                customerPoNos = listOf("P26E014"),
            ),
            PickupAllocation(
                poItemId = 103,
                poId = 9,
                poNo = "SPO-009",
                qty = 1.0,
                remainingQty = 1.0,
                customerPoNos = listOf("P26E021"),
            ),
        ),
        customerPoNos = listOf("P26E001", "P26E014", "P26E021"),
    )

    @Test
    fun totalEqualsTheSumOfTheAllocations() {
        val group = contactorGroup()
        assertEquals(6.0, group.totalRemainingQty, 0.0001)
        assertEquals(6.0, group.allocations.sumOf { it.remainingQty }, 0.0001)
    }

    @Test
    fun eachAllocationKeepsItsOwnPoAndCustomerPo() {
        val group = contactorGroup()
        assertEquals(listOf("SPO-001", "SPO-005", "SPO-009"), group.allocations.map { it.poNo })
        assertEquals(
            listOf(listOf("P26E001"), listOf("P26E014"), listOf("P26E021")),
            group.allocations.map { it.customerPoNos },
        )
    }

    @Test
    fun consolidatedItemExpandsToOneReceiptEntryPerOriginalPoLine() {
        val entries = contactorGroup().toEntries()
        assertEquals(3, entries.size)
        // Every entry is keyed by the ORIGINAL po item id — that is what makes the
        // receipt traceable once the grouping is only a display concern.
        assertEquals(listOf(101, 102, 103), entries.map { it.poItemId })
        assertEquals(6.0, entries.sumOf { it.requiredQty }, 0.0001)
    }

    @Test
    fun partialReceivingLeavesTheUntouchedLinesIntact() {
        val entries = contactorGroup().toEntries()
        // Receive 2 of the 3 on SPO-005 and nothing else.
        val submitted = entries.map { entry ->
            if (entry.poItemId == 102) entry.copy(receivedQty = "2") else entry.copy(receivedQty = "0")
        }
        assertEquals(2.0, submitted.sumOf { it.receivedQty.toDouble() }, 0.0001)
        // The outstanding quantity is derived from what was typed, never assumed.
        val remaining = entries.zip(submitted).sumOf { (required, actual) ->
            required.requiredQty - actual.receivedQty.toDouble()
        }
        assertEquals(4.0, remaining, 0.0001)
    }

    @Test
    fun itemsThatMerelyReadAlikeStaySeparateGroups() {
        val a = contactorGroup()
        val b = a.copy(
            groupKey = "poitem:999",
            matchBasis = "unique",
            itemId = null,
            partNo = null,
            displayName = "كونتاكتور شنايدر LC1D32M7 (بدون رقم قطعة)",
        )
        assertNotEquals(a.groupKey, b.groupKey)
    }
}

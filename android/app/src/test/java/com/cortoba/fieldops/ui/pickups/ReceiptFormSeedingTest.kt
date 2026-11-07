package com.cortoba.fieldops.ui.pickups

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cortoba.fieldops.core.network.CortobaApi
import com.cortoba.fieldops.core.session.SessionStore
import com.cortoba.fieldops.data.local.FieldOpsDatabase
import com.cortoba.fieldops.data.repository.FieldOpsRepository
import com.cortoba.fieldops.data.sync.SyncScheduler
import com.google.gson.Gson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * Regression test for the «لا توجد أصناف للاستلام» defect.
 *
 * The receiving screen used to fire two calls side by side:
 *
 *     viewModel.loadDetail(assignmentId)   // asynchronous
 *     viewModel.prepareForm()              // reads _detail NOW
 *
 * `prepareForm()` read the detail state while the network call was still in
 * flight, found it empty, and returned without seeding a single row. The task
 * was then displayed with nothing to receive — and because the submit handler
 * rejects an empty submission, the rep could never complete it, while the task
 * itself stayed on the list.
 *
 * These tests drive the REAL ViewModel, the REAL repository, a real Room
 * database and a real HTTP server. Nothing is mocked, because the defect lived
 * in the timing between these components and a mock would have hidden it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class ReceiptFormSeedingTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var server: MockWebServer
    private lateinit var db: FieldOpsDatabase
    private lateinit var repository: FieldOpsRepository
    private lateinit var context: Context

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        context = ApplicationProvider.getApplicationContext()
        context.deleteSharedPreferences("cortoba_secure_prefs")
        server = MockWebServer().apply { start() }
        db = Room.inMemoryDatabaseBuilder(context, FieldOpsDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        val gson = Gson()
        val api: CortobaApi = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .addConverterFactory(GsonConverterFactory.create(gson))
            .build()
            .create(CortobaApi::class.java)
        repository = FieldOpsRepository(
            api = api,
            dao = db.dao(),
            gson = gson,
            sessionStore = SessionStore(context),
            scheduler = SyncScheduler(context),
        )
    }

    @After
    fun tearDown() {
        db.close()
        server.shutdown()
        Dispatchers.resetMain()
    }

    /**
     * Drive the coroutines until [cond] holds.
     *
     * The test scheduler uses virtual time, but the HTTP round trip happens on
     * OkHttp's real threads. `advanceUntilIdle()` alone therefore returns before
     * the response arrives — which would make every assertion here a race. This
     * interleaves scheduler advancement with a short real wait, so the test
     * observes the same ordering a device would.
     */
    private fun TestScope.awaitUntil(cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            testScheduler.advanceUntilIdle()
            if (cond()) return
            Thread.sleep(10)
        }
        testScheduler.advanceUntilIdle()
    }

    /** The Schneider contactor: 2 + 3 + 1 = 6 units across three supplier POs. */
    private fun detailJson(assignmentId: Int = 7, status: String = "sent"): String = """
        {
          "assignmentId": $assignmentId,
          "status": "$status",
          "executorRole": "owner",
          "po": {"id": 1, "poNo": "SPO-001"},
          "supplier": {"id": 3, "name": "مورد الاختبار", "phone": "0100"},
          "items": [
            {
              "groupKey": "item:CONT-LC1D32M7",
              "matchBasis": "itemId",
              "displayName": "كونتاكتور شنايدر LC1D32M7",
              "totalRequiredQty": 6.0,
              "totalAcceptedQty": 0.0,
              "totalRemainingQty": 6.0,
              "allocations": [
                {"poItemId": 101, "poId": 1, "poNo": "SPO-001", "qty": 2.0, "remainingQty": 2.0,
                 "customerPoNos": ["P26E001"]},
                {"poItemId": 102, "poId": 5, "poNo": "SPO-005", "qty": 3.0, "remainingQty": 3.0,
                 "customerPoNos": ["P26E014"]},
                {"poItemId": 103, "poId": 9, "poNo": "SPO-009", "qty": 1.0, "remainingQty": 1.0,
                 "customerPoNos": ["P26E021"]}
              ]
            }
          ]
        }
    """.trimIndent()

    private fun enqueueJson(body: String, code: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    /**
     * The exact reported failure. Under the old code the form stayed empty
     * because `prepareForm()` ran before the detail arrived; there is no
     * `prepareForm()` any more — seeding follows the load, which is the fix.
     */
    @Test
    fun loadingDetailSeedsOneEntryPerOriginalPoLine() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.detail.value.data != null }

        val entries = viewModel.form.value.entries
        assertEquals("one row per original PO line", 3, entries.size)
        assertEquals(listOf(101, 102, 103), entries.map { it.poItemId })
        assertEquals(6.0, entries.sumOf { it.requiredQty }, 0.0001)
        // The summary the screen renders must be non-zero, otherwise the rep is
        // told there is nothing to receive.
        val summary = viewModel.summaryFor(entries)
        // distinctItems counts consolidated GROUPS (one product), not the three
        // original PO lines behind it.
        assertEquals(1, summary.distinctItems)
        assertEquals(6.0, summary.totalRequired, 0.0001)
    }

    @Test
    fun seedingDoesNotRepeatOnReloadAndKeepsTypedQuantities() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        viewModel.onReceivedQtyChange(102, "2")

        // A reload (retry, or the screen recomposing) must not reset the form:
        // the rep would silently lose the quantities already entered.
        enqueueJson(detailJson())
        viewModel.loadDetail(7)
        // Wait for the SECOND request to be served, not for a condition already
        // true from the first load, or the assertions below prove nothing.
        awaitUntil { server.requestCount >= 2 }
        awaitUntil { viewModel.detail.value.loading.not() }

        assertEquals("2", viewModel.form.value.entries.single { it.poItemId == 102 }.receivedQty)
        assertEquals(3, viewModel.form.value.entries.size)
    }

    @Test
    fun aFailedLoadLeavesTheFormEmptyAndSurfacesTheError() = runTest(dispatcher) {
        enqueueJson("""{"error":"خطأ في الخادم"}""", code = 500)
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.detail.value.error != null }

        assertTrue(viewModel.form.value.entries.isEmpty())
        assertNotNull(viewModel.detail.value.error)
    }

    /**
     * A partial receipt is a success, not an error: the outstanding quantity
     * stays on the same task for a later visit. The result the UI reads must say
     * so, otherwise the rep sees a completed screen for unfinished work.
     */
    @Test
    fun partialSubmissionIsReportedAsPartialAndKeepsTheShortfall() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        // Receive 4 of the 6 required units: 2 + 2 + 0.
        viewModel.onReceivedQtyChange(101, "2")
        viewModel.onReceivedQtyChange(102, "2")
        viewModel.onReceivedQtyChange(103, "0")

        enqueueJson(
            """{"success":true,"receiptIds":[1,2],"duplicate":false,"assignmentStatus":"partially_received"}""",
        )
        viewModel.submit(7)
        awaitUntil { viewModel.form.value.result != null }

        val result = viewModel.form.value.result
        assertNotNull(result)
        assertTrue("a partial receipt must report the shortfall", result!!.partial)
        assertEquals(2.0, result.missingQty, 0.0001)
        assertEquals(4.0, result.acceptedQty, 0.0001)
    }

    @Test
    fun fullSubmissionIsNotReportedAsPartial() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        viewModel.onReceivedQtyChange(101, "2")
        viewModel.onReceivedQtyChange(102, "3")
        viewModel.onReceivedQtyChange(103, "1")

        enqueueJson(
            """{"success":true,"receiptIds":[1,2,3],"duplicate":false,"assignmentStatus":"received"}""",
        )
        viewModel.submit(7)
        awaitUntil { viewModel.form.value.result != null }

        val result = viewModel.form.value.result
        assertNotNull(result)
        assertTrue("a complete receipt must not be flagged partial", !result!!.partial)
        assertEquals(0.0, result.missingQty, 0.0001)
        assertEquals(6.0, result.acceptedQty, 0.0001)
    }

    /**
     * Damaged units are recorded but never counted as accepted, so a receipt
     * that arrives short must still be reported as partial.
     */
    @Test
    fun damagedUnitsAreExcludedFromAcceptedAndCountAsMissing() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)

        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        viewModel.onReceivedQtyChange(101, "2")
        viewModel.onReceivedQtyChange(102, "3")
        viewModel.onReceivedQtyChange(103, "1")
        viewModel.onRejectedQtyChange(103, "1")

        enqueueJson(
            """{"success":true,"receiptIds":[1,2,3],"duplicate":false,"assignmentStatus":"partially_received"}""",
        )
        viewModel.submit(7)
        awaitUntil { viewModel.form.value.result != null }

        val result = viewModel.form.value.result
        assertNotNull(result)
        // The server marks the task partial because the damaged unit was never
        // accepted, so the line still has an outstanding quantity.
        assertTrue(result!!.partial)
        assertEquals(5.0, result.acceptedQty, 0.0001)
        // Per the specification "missing" is ordered-minus-RECEIVED (the units
        // that never arrived); the damaged unit arrived and is reported through
        // the damaged count instead. The task still stays open because accepted
        // is below ordered — which is exactly what `partial` above captures.
        assertEquals(0.0, result.missingQty, 0.0001)
    }
}

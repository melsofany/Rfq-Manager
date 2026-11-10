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
     * A per-line action sends that line to the server at once. There is no
     * separate confirm step, so the request must leave on the tap itself.
     */
    @Test
    fun receivingOneLineFullSendsItImmediately() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        enqueueJson("""{"success":true,"receiptIds":[1]}""")
        viewModel.receiveLineFull(7, 101)
        awaitUntil { server.requestCount >= 2 }

        val confirm = takeConfirmRequest()
        val body = confirm.body.readUtf8()
        assertTrue("the line's own quantity must be sent", body.contains("\"receivedQty\":2"))
        assertTrue("the PO line id must be sent", body.contains("\"poItemId\":101"))
        assertTrue(
            "a full receipt records the line as accepted",
            body.contains("\"acceptedQty\":2"),
        )
    }

    /** «رفض» on one line sends nothing received and the whole quantity rejected. */
    @Test
    fun rejectingOneLineSendsTheWholeQuantityAsRejectedWithTheReason() =
        runTest(dispatcher) {
            enqueueJson(detailJson())
            val viewModel = PickupViewModel(repository)
            viewModel.loadDetail(7)
            awaitUntil { viewModel.form.value.entries.isNotEmpty() }

            enqueueJson("""{"success":true,"receiptIds":[1]}""")
            viewModel.onRejectionReasonChange(101, "تالف")
            viewModel.rejectLine(7, 101)
            awaitUntil { server.requestCount >= 2 }

            val body = takeConfirmRequest().body.readUtf8()
            assertTrue(body.contains("\"receivedQty\":0"))
            assertTrue("the whole remaining quantity is rejected", body.contains("\"rejectedQty\":2"))
            assertTrue("the reason is recorded", body.contains("تالف"))
        }

    /** A rejection without a reason must be refused before it reaches the wire. */
    @Test
    fun rejectingWithoutAReasonIsRefusedLocally() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        val before = server.requestCount
        viewModel.rejectLine(7, 101)
        testScheduler.advanceUntilIdle()

        assertEquals("no request may leave without a reason", before, server.requestCount)
        assertNotNull(viewModel.form.value.error)
    }

    /** «استلام جزئي» sends exactly the quantity the rep typed. */
    @Test
    fun partialReceiptSendsTheTypedQuantity() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        enqueueJson("""{"success":true,"receiptIds":[1]}""")
        viewModel.onReceivedQtyChange(102, "2")
        viewModel.receiveLinePartial(7, 102)
        awaitUntil { server.requestCount >= 2 }

        val body = takeConfirmRequest().body.readUtf8()
        assertTrue(body.contains("\"poItemId\":102"))
        assertTrue(body.contains("\"receivedQty\":2"))
    }

    /** A quantity above the required one is refused before it reaches the wire. */
    @Test
    fun overReceiptIsRefusedLocally() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        val before = server.requestCount
        viewModel.onReceivedQtyChange(101, "99")
        viewModel.receiveLinePartial(7, 101)
        testScheduler.advanceUntilIdle()

        assertEquals("an over-receipt must not reach the server", before, server.requestCount)
        assertNotNull(viewModel.form.value.error)
    }

    /** «استلام الكل» sends every line of the task in one submission. */
    @Test
    fun receiveAllSendsEveryLine() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        enqueueJson("""{"success":true,"receiptIds":[1,2,3]}""")
        viewModel.receiveAll(7)
        awaitUntil { server.requestCount >= 2 }

        val body = takeConfirmRequest().body.readUtf8()
        assertTrue(body.contains("\"poItemId\":101"))
        assertTrue(body.contains("\"poItemId\":102"))
        assertTrue(body.contains("\"poItemId\":103"))
    }

    /** «رفض الكل» sends every line rejected with the one chosen reason. */
    @Test
    fun rejectAllSendsEveryLineRejected() = runTest(dispatcher) {
        enqueueJson(detailJson())
        val viewModel = PickupViewModel(repository)
        viewModel.loadDetail(7)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        enqueueJson("""{"success":true,"receiptIds":[1,2,3]}""")
        viewModel.rejectAll(7, "تالف")
        awaitUntil { server.requestCount >= 2 }

        val body = takeConfirmRequest().body.readUtf8()
        assertTrue(body.contains("\"receivedQty\":0"))
        assertTrue(body.contains("تالف"))
    }

    /**
     * The receipt endpoint is the one the app must reach; `takeConfirmRequest`
     * filters the earlier GET out of the recorded traffic.
     */
    private fun takeConfirmRequest(): okhttp3.mockwebserver.RecordedRequest {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val request = server.takeRequest(1, java.util.concurrent.TimeUnit.SECONDS)
            if (request == null) continue
            if (request.path?.endsWith("/confirm") == true) return request
        }
        throw AssertionError("the confirm request never reached the server")
    }
}

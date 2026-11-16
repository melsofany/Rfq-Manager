package com.cortoba.fieldops.ui.deliveries

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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * A customer line is supplied in one of two ways, and the delivery screen must
 * treat them differently:
 *
 *  - a purchase order was issued to a supplier → the goods must be RECEIVED
 *    before they can be delivered. The line is SHOWN so the rep knows the work
 *    exists, but every action stays disabled until the goods land.
 *  - nothing was issued (the rep buys it on the street, outside the system) →
 *    the line is deliverable immediately.
 *
 * The defect this guards: a line waiting on a supplier receipt was offered for
 * delivery with a ceiling of zero, so the rep either could not act at all or
 * had the batch rejected by the server.
 *
 * The tests drive the REAL ViewModel, the REAL repository, a real Room database
 * and a real HTTP server — nothing is mocked, because the behaviour lives in the
 * wiring between them.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class DeliverySupplierReceiptTest {

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
     * The scheduler uses virtual time but the HTTP round trip runs on OkHttp's
     * real threads, so `advanceUntilIdle()` alone returns before the response
     * arrives. Interleave it with a short real wait.
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

    /**
     * One customer order with two lines: [supplierLineReceived] controls whether
     * the supplier-supplied line has been received yet.
     */
    private fun customerJson(supplierLineReceived: Boolean): String {
        val supplierAvailable = if (supplierLineReceived) 5.0 else 0.0
        val supplierAwaiting = if (supplierLineReceived) "false" else "true"
        return """
            {
              "customerId": 10,
              "customer": {"id": 10, "name": "عميل الاختبار"},
              "purchaseOrders": [
                {
                  "assignmentId": 7,
                  "customerPoId": 5,
                  "customerPoNo": "P26E001",
                  "status": "in_progress",
                  "totalItems": 2,
                  "items": [
                    {
                      "customerPoItemId": 42,
                      "description": "بند له أمر شراء مورد",
                      "orderedQty": 5.0,
                      "availableQty": $supplierAvailable,
                      "awaitingSupplierReceipt": $supplierAwaiting,
                      "deliveredQty": 0.0,
                      "rejectedByCustomerQty": 0.0
                    },
                    {
                      "customerPoItemId": 43,
                      "description": "بند شراء من الشارع",
                      "orderedQty": 3.0,
                      "availableQty": 3.0,
                      "awaitingSupplierReceipt": false,
                      "deliveredQty": 0.0,
                      "rejectedByCustomerQty": 0.0
                    }
                  ]
                }
              ]
            }
        """.trimIndent()
    }

    private fun enqueueJson(body: String, code: Int = 200) {
        server.enqueue(
            MockResponse()
                .setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    /** Load the customer and wait for the form to be seeded. */
    private fun TestScope.loadCustomer(viewModel: DeliveryViewModel, key: String = "id:10") {
        viewModel.loadCustomerDetail(key)
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
    }

    @Test
    fun showsBothLinesButOnlyTheStreetLineIsDeliverable() = runTest(dispatcher) {
        enqueueJson(customerJson(supplierLineReceived = false))
        val viewModel = DeliveryViewModel(repository)
        loadCustomer(viewModel)

        val entries = viewModel.form.value.entries.associateBy { it.customerPoItemId }
        assertEquals("both lines are shown", 2, entries.size)

        val supplierLine = entries.getValue(42)
        assertTrue("the supplier line is flagged as waiting", supplierLine.awaitingSupplierReceipt)
        assertFalse("an unreceived line cannot be delivered", supplierLine.isDeliverable)
        assertEquals("nothing is pre-filled for an unreceived line", "", supplierLine.deliveredQty)

        val streetLine = entries.getValue(43)
        assertFalse(streetLine.awaitingSupplierReceipt)
        assertTrue("a street-bought line is deliverable at once", streetLine.isDeliverable)
    }

    @Test
    fun actingOnAnUnreceivedLineIsRefusedBeforeItReachesTheWire() = runTest(dispatcher) {
        enqueueJson(customerJson(supplierLineReceived = false))
        val viewModel = DeliveryViewModel(repository)
        loadCustomer(viewModel)

        val before = server.requestCount
        viewModel.deliverLineFull("id:10", 42)
        testScheduler.advanceUntilIdle()

        assertEquals("no delivery may leave for an unreceived line", before, server.requestCount)
        assertNotNull(viewModel.form.value.error)
    }

    @Test
    fun deliverWholePoSkipsTheUnreceivedLineAndSendsTheRest() = runTest(dispatcher) {
        enqueueJson(customerJson(supplierLineReceived = false))
        val viewModel = DeliveryViewModel(repository)
        loadCustomer(viewModel)

        enqueueJson("""{"success":true}""")
        viewModel.deliverPoFull("id:10", 5)
        awaitUntil { server.requestCount >= 2 }

        val body = takeConfirmRequest().body.readUtf8()
        assertTrue("the street line is delivered", body.contains("\"customerPoItemId\":43"))
        assertFalse("the unreceived line must not be sent", body.contains("\"customerPoItemId\":42"))
    }

    @Test
    fun aReceivedLineBecomesDeliverable() = runTest(dispatcher) {
        enqueueJson(customerJson(supplierLineReceived = true))
        val viewModel = DeliveryViewModel(repository)
        loadCustomer(viewModel)

        val supplierLine = viewModel.form.value.entries.single { it.customerPoItemId == 42 }
        assertFalse(supplierLine.awaitingSupplierReceipt)
        assertTrue("once received, the line is deliverable", supplierLine.isDeliverable)

        enqueueJson("""{"success":true}""")
        viewModel.deliverLineFull("id:10", 42)
        awaitUntil { server.requestCount >= 2 }

        val body = takeConfirmRequest().body.readUtf8()
        assertTrue(body.contains("\"customerPoItemId\":42"))
        assertTrue("the whole received quantity is delivered", body.contains("\"deliveredQty\":5"))
    }

    /** Filters the earlier GET out of the recorded traffic. */
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

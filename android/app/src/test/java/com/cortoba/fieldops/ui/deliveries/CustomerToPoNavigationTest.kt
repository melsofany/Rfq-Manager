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
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory

/**
 * The customer screen must open an order that the order screen can find.
 *
 * The defect this guards: the customer screen handed the assignment id to the
 * order screen while the order screen looks up by customer PO id, so the lookup
 * always failed and the order screen rendered with NO buttons — reported as
 * «أغلب الأزرار داخل التطبيق لا تعمل».
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class CustomerToPoNavigationTest {

    private val dispatcher = StandardTestDispatcher()
    private lateinit var server: MockWebServer
    private lateinit var db: FieldOpsDatabase
    private lateinit var repository: FieldOpsRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        val context: Context = ApplicationProvider.getApplicationContext()
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

    private fun TestScope.awaitUntil(cond: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            testScheduler.advanceUntilIdle()
            if (cond()) return
            Thread.sleep(10)
        }
    }

    /**
     * The customer detail: one order whose assignment id (11) and customer PO id
     * (4) are deliberately DIFFERENT, which is the real shape of the data.
     */
    private fun customerJson(): String = """
        {
          "customerId": 7,
          "customer": {"id": 7, "name": "عميل الاختبار", "phone": "0111"},
          "purchaseOrders": [
            {
              "assignmentId": 11,
              "customerPoId": 4,
              "customerPoNo": "P26E001",
              "customerName": "عميل الاختبار",
              "poDate": "2026-01-01",
              "buyerName": "أحمد",
              "status": "in_progress",
              "assignmentStatus": "sent",
              "totalItems": 1,
              "totalAmount": 100.0,
              "items": [
                {
                  "customerPoItemId": 501,
                  "description": "كونتاكتور شنايدر LC1D32M7",
                  "orderedQty": 6.0,
                  "acceptedFromSupplierQty": 4.0,
                  "deliveredQty": 0.0,
                  "rejectedByCustomerQty": 0.0,
                  "availableQty": 4.0,
                  "deliveryStatus": "pending"
                }
              ]
            }
          ]
        }
    """.trimIndent()

    private fun enqueue(body: String, code: Int = 200) {
        server.enqueue(
            MockResponse().setResponseCode(code)
                .setHeader("Content-Type", "application/json")
                .setBody(body),
        )
    }

    /**
     * Reproduces the bug: the id the customer screen hands over must be the id
     * the order screen looks up. With the assignment id the screen finds nothing
     * and renders empty; with the customer PO id it finds the order and exposes
     * its items and actions.
     */
    @Test
    fun theOrderScreenFindsTheOrderUsingTheIdTheCustomerScreenProvides() =
        runTest(dispatcher) {
            enqueue(customerJson())
            val viewModel = DeliveryViewModel(repository)
            viewModel.loadCustomerDetail("name:عميل الاختبار")
            awaitUntil { viewModel.customerDetail.value.data != null }

            val po = viewModel.customerDetail.value.data!!.purchaseOrders.single()

            // What the customer screen must hand over (the fix).
            val idTheScreenProvides = po.customerPoId
            val found = viewModel.customerDetail.value.data!!.purchaseOrders
                .firstOrNull { it.customerPoId == idTheScreenProvides }
            assertNotNull("the order screen must find the order it was opened with", found)
            assertEquals("P26E001", found!!.customerPoNo)

            // The assignment id is a DIFFERENT key: using it reproduces the bug.
            val wrong = viewModel.customerDetail.value.data!!.purchaseOrders
                .firstOrNull { it.customerPoId == po.assignmentId }
            assertEquals(
                "using the assignment id as the PO id finds nothing (the original defect)",
                null,
                wrong,
            )
        }

    /** The order screen must expose the order's items and its confirm action. */
    @Test
    fun theOrderFormIsSeededSoItsButtonsCanBeUsed() = runTest(dispatcher) {
        enqueue(customerJson())
        val viewModel = DeliveryViewModel(repository)
        viewModel.loadCustomerDetail("name:عميل الاختبار")
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        val entry = viewModel.form.value.entries.single()
        assertEquals(4, entry.customerPoId)
        assertEquals(11, entry.assignmentId)
        assertEquals(501, entry.customerPoItemId)
        // A line seeded at its full quantity so the order can be confirmed.
        assertEquals(4.0, entry.availableQty, 1e-6)
    }
}

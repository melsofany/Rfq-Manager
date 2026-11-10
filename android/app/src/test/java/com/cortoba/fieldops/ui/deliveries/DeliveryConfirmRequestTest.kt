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
import org.json.JSONObject
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
 * The delivery confirmation carries quantities and evidence only.
 *
 * Recipient name and on-screen signature were removed from the delivery step:
 * PLAN.md puts the customer's confirmation and signature out of scope ("تأكيد
 * العميل، توقيع العميل ... خارج النطاق (لا حقول، لا خطوة، لا Portal)" — F5), and
 * the rep has no way to obtain a customer signature anyway.
 *
 * This guards both halves of the removal. The UI assertions are what a
 * regression would break first; the request assertions are what would leak a
 * field back onto the wire.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class DeliveryConfirmRequestTest {

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

    /**
     * The HTTP round trip runs on OkHttp's real threads while the scheduler uses
     * virtual time, so `advanceUntilIdle()` alone returns before the response
     * arrives. Interleave both, or every assertion here becomes a race.
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

    private fun detailJson(): String = """
        {
          "assignmentId": 11,
          "status": "sent",
          "executorRole": "owner",
          "customerPo": {"id": 4, "customerPoNo": "P26E001", "customerName": "عميل الاختبار"},
          "customer": {"id": 4, "name": "عميل الاختبار", "phone": "0111"},
          "items": [
            {
              "customerPoItemId": 501,
              "description": "كونتاكتور شنايدر LC1D32M7",
              "orderedQty": 6.0,
              "acceptedFromSupplierQty": 4.0,
              "deliveredQty": 0.0,
              "availableQty": 4.0,
              "deliveryStatus": "pending"
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

    private fun loadedViewModel(): DeliveryViewModel {
        enqueueJson(detailJson())
        val viewModel = DeliveryViewModel(repository)
        viewModel.loadDetail(11)
        return viewModel
    }

    /**
     * Pull recorded requests until the confirm POST shows up.
     *
     * `loadDetail` issues its own GET, so the confirm call is not necessarily
     * the first request the server saw; taking blindly would read the detail
     * request (empty body) and prove nothing.
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

    /**
     * «كلي» on one line must send that line to the server at once — there is no
     * separate confirm step, so the request leaves on the tap itself.
     */
    @Test
    fun deliveringOneLineFullReachesTheServerImmediately() = runTest(dispatcher) {
        val viewModel = loadedViewModel()
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        enqueueJson("""{"success":true,"deliveryIds":[1]}""")

        viewModel.deliverLineFull(null, 501)
        awaitUntil { server.requestCount >= 2 }

        assertEquals("/api/mobile/deliveries/11/confirm", takeConfirmRequest().path)
    }

    /** No field of the removed feature may reappear on the wire. */
    @Test
    fun theConfirmRequestCarriesNoRecipientName() = runTest(dispatcher) {
        val viewModel = loadedViewModel()
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        enqueueJson("""{"success":true,"deliveryIds":[1]}""")

        viewModel.deliverLineFull(null, 501)
        awaitUntil { server.requestCount >= 2 }

        val body = JSONObject(takeConfirmRequest().body.readUtf8())
        assertFalse(
            "the delivery request must not carry a recipient name",
            body.has("recipientName"),
        )
        // The quantities are still there — the removal must not have taken them.
        assertTrue(body.has("items"))
        assertTrue(body.has("clientUuid"))
    }

    /** «رفض» on one line sends nothing delivered and the reason. */
    @Test
    fun rejectingOneLineSendsTheReasonAtOnce() = runTest(dispatcher) {
        val viewModel = loadedViewModel()
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }
        enqueueJson("""{"success":true,"deliveryIds":[1]}""")

        viewModel.setLineReason(501, "تالف")
        viewModel.rejectLine(null, 501)
        awaitUntil { server.requestCount >= 2 }

        val body = JSONObject(takeConfirmRequest().body.readUtf8())
        assertTrue("the rejection reason must be sent", body.toString().contains("تالف"))
    }

    /** A rejection with no reason must be refused before it reaches the wire. */
    @Test
    fun rejectingWithoutAReasonIsRefusedLocally() = runTest(dispatcher) {
        val viewModel = loadedViewModel()
        awaitUntil { viewModel.form.value.entries.isNotEmpty() }

        val before = server.requestCount
        viewModel.rejectLine(null, 501)
        testScheduler.advanceUntilIdle()

        assertEquals("no request may leave without a reason", before, server.requestCount)
        assertNotNull(viewModel.form.value.error)
    }

    /** The form exposes no recipient field for the screen to bind. */
    @Test
    fun theFormExposesNoRecipientField() {
        val form = DeliveryFormState()
        val fields = DeliveryFormState::class.java.declaredFields.map { it.name }
        assertFalse(
            "DeliveryFormState must not carry recipient state: $fields",
            fields.contains("recipientName"),
        )
        assertFalse(
            "DeliveryFormState must not carry signature state: $fields",
            fields.contains("signed"),
        )
        assertEquals("", form.notes)
    }
}

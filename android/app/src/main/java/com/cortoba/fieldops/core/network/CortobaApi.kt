package com.cortoba.fieldops.core.network

import com.cortoba.fieldops.core.network.dto.AppVersionDto
import com.cortoba.fieldops.core.network.dto.ChangePasswordRequest
import com.cortoba.fieldops.core.network.dto.CustomerDeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DashboardResponse
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmRequest
import com.cortoba.fieldops.core.network.dto.DeliveryConfirmResponse
import com.cortoba.fieldops.core.network.dto.DeliveryDetailResponse
import com.cortoba.fieldops.core.network.dto.DeliveryListResponse
import com.cortoba.fieldops.core.network.dto.HistoryResponse
import com.cortoba.fieldops.core.network.dto.LoginRequest
import com.cortoba.fieldops.core.network.dto.LoginResponse
import com.cortoba.fieldops.core.network.dto.NotificationDto
import com.cortoba.fieldops.core.network.dto.PickupDetailResponse
import com.cortoba.fieldops.core.network.dto.PickupListResponse
import com.cortoba.fieldops.core.network.dto.ProfileResponse
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmRequest
import com.cortoba.fieldops.core.network.dto.ReceiptConfirmResponse
import com.cortoba.fieldops.core.network.dto.SyncRequest
import com.cortoba.fieldops.core.network.dto.SyncResponse
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * The mobile API surface. Every endpoint here exists on the server; nothing is
 * stubbed locally, so the app never shows data the backend did not authorise.
 */
interface CortobaApi {

    @POST("api/mobile/auth/login")
    suspend fun login(@Body body: LoginRequest): Response<LoginResponse>

    @POST("api/mobile/auth/logout")
    suspend fun logout(): Response<Unit>

    @POST("api/mobile/auth/change-password")
    suspend fun changePassword(@Body body: ChangePasswordRequest): Response<Unit>

    @GET("api/mobile/version")
    suspend fun latestVersion(): Response<AppVersionDto>

    @GET("api/mobile/dashboard")
    suspend fun dashboard(): Response<DashboardResponse>

    @GET("api/mobile/pickups")
    suspend fun pickups(): Response<PickupListResponse>

    @GET("api/mobile/pickups/{id}")
    suspend fun pickup(@Path("id") assignmentId: Int): Response<PickupDetailResponse>

    @POST("api/mobile/pickups/{id}/confirm")
    suspend fun confirmReceipt(
        @Path("id") assignmentId: Int,
        @Body body: ReceiptConfirmRequest,
    ): Response<ReceiptConfirmResponse>

    @GET("api/mobile/deliveries")
    suspend fun deliveries(): Response<DeliveryListResponse>

    @GET("api/mobile/deliveries/customer/{id}")
    suspend fun customerDelivery(@Path("id") customerId: Int): Response<CustomerDeliveryDetailResponse>

    @GET("api/mobile/deliveries/{id}")
    suspend fun delivery(@Path("id") assignmentId: Int): Response<DeliveryDetailResponse>

    @POST("api/mobile/deliveries/{id}/confirm")
    suspend fun confirmDelivery(
        @Path("id") assignmentId: Int,
        @Body body: DeliveryConfirmRequest,
    ): Response<DeliveryConfirmResponse>

    @GET("api/mobile/notifications")
    suspend fun notifications(): Response<List<NotificationDto>>

    @POST("api/mobile/notifications/{id}/read")
    suspend fun markNotificationRead(@Path("id") id: Int): Response<Unit>

    @POST("api/mobile/notifications/read-all")
    suspend fun markAllNotificationsRead(): Response<Unit>

    @POST("api/mobile/sync")
    suspend fun sync(@Body body: SyncRequest): Response<SyncResponse>

    @GET("api/mobile/profile")
    suspend fun profile(): Response<ProfileResponse>

    @GET("api/mobile/history")
    suspend fun history(): Response<HistoryResponse>
}

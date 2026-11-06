package com.cortoba.fieldops.core.network

import retrofit2.Response

/**
 * Turn a Retrofit `Response<T>` into either the body or a typed [ApiException]
 * that carries the server's Arabic message. Every repository call funnels
 * through here so error handling cannot drift between screens.
 */
suspend fun <T> apiCall(block: suspend () -> Response<T>): T {
    val response = try {
        block()
    } catch (io: java.io.IOException) {
        throw ApiException.network(io)
    }
    if (response.isSuccessful) {
        @Suppress("UNCHECKED_CAST")
        return (response.body() ?: Unit) as T
    }
    val raw = response.errorBody()?.string()
    throw ApiException.parse(raw, response.code())
}

/** For endpoints that return 200 with no body (`Unit`). */
suspend fun apiCallUnit(block: suspend () -> Response<Unit>) {
    val response = try {
        block()
    } catch (io: java.io.IOException) {
        throw ApiException.network(io)
    }
    if (!response.isSuccessful) {
        throw ApiException.parse(response.errorBody()?.string(), response.code())
    }
}

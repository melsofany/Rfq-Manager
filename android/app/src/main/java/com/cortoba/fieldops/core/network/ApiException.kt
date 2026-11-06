package com.cortoba.fieldops.core.network

/**
 * A failure that carries the server's own Arabic message. Screens show
 * [userMessage] verbatim, so the wording the operator sees is the wording the
 * backend decided — never a generic "something went wrong".
 */
class ApiException(
    val statusCode: Int,
    val userMessage: String,
    cause: Throwable? = null,
) : Exception(userMessage, cause) {

    /** Session expired / revoked: the app must send the user back to login. */
    val isUnauthorized: Boolean get() = statusCode == 401

    val isNetwork: Boolean get() = statusCode == 0

    companion object {
        fun network(cause: Throwable? = null) =
            ApiException(0, "لا يوجد اتصال بالإنترنت. سيتم حفظ العملية ومزامنتها لاحقاً", cause)

        fun parse(body: String?, status: Int): ApiException {
            val message = body?.let { raw ->
                runCatching {
                    val parsed = com.google.gson.JsonParser.parseString(raw)
                    if (parsed.isJsonObject) {
                        val error = parsed.asJsonObject.get("error")
                        if (error != null && !error.isJsonNull) error.asString else null
                    } else {
                        null
                    }
                }.getOrNull()
            }
            return ApiException(status, message?.takeIf { it.isNotBlank() } ?: defaultMessage(status))
        }

        private fun defaultMessage(status: Int): String = when (status) {
            400 -> "البيانات المدخلة غير صحيحة"
            401 -> "انتهت الجلسة. برجاء تسجيل الدخول مرة أخرى"
            403 -> "ليس لديك صلاحية لتنفيذ هذه العملية"
            404 -> "العنصر المطلوب غير موجود"
            in 500..599 -> "حدث خطأ في الخادم. برجاء المحاولة لاحقاً"
            else -> "تعذر تنفيذ العملية ($status)"
        }
    }
}

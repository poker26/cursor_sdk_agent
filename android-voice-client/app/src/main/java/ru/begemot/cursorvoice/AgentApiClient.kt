package ru.begemot.cursorvoice

import okhttp3.Credentials
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class VoiceTurnResult(
    val ok: Boolean,
    val userText: String,
    val assistantText: String,
    val durationMs: Long,
    val status: String,
    val errorMessage: String?,
    val speechText: String?,
    val errorDetail: String?,
)

class AgentApiClient(private val appPreferences: AppPreferences) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    fun postVoiceTurn(audioBase64: String, mimeType: String): VoiceTurnResult {
        val requestJson = JSONObject()
            .put("audioBase64", audioBase64)
            .put("mimeType", mimeType)
            .put("sessionId", appPreferences.chatSessionId)
            .put("workspaceId", appPreferences.workspaceId)
            .put("responseMode", "voice")

        return executeVoiceTurnRequest(requestJson)
    }

    fun postVoiceTurnWithText(messageText: String): VoiceTurnResult {
        val requestJson = JSONObject()
            .put("message", messageText)
            .put("sessionId", appPreferences.chatSessionId)
            .put("workspaceId", appPreferences.workspaceId)
            .put("responseMode", "voice")

        return executeVoiceTurnRequest(requestJson)
    }

    fun synthesizeSpeech(assistantText: String): ByteArray {
        val requestJson = JSONObject().put("text", assistantText)
        val request = buildAuthorizedRequest("/api/voice/synthesize")
            .post(requestJson.toString().toRequestBody(jsonMediaType))
            .build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val errorBody = response.body?.string() ?: "HTTP ${response.code}"
                throw IllegalStateException("Синтез речи: $errorBody")
            }
            return response.body?.bytes()
                ?: throw IllegalStateException("Пустой ответ синтеза речи")
        }
    }

    private fun executeVoiceTurnRequest(requestJson: JSONObject): VoiceTurnResult {
        val request = buildAuthorizedRequest("/api/voice/turn")
            .post(requestJson.toString().toRequestBody(jsonMediaType))
            .build()

        httpClient.newCall(request).execute().use { response ->
            val responseBodyText = response.body?.string() ?: ""
            val responseJson = try {
                JSONObject(responseBodyText)
            } catch (_: Exception) {
                throw IllegalStateException("Некорректный JSON: $responseBodyText")
            }

            if (!response.isSuccessful) {
                return parseVoiceTurnResult(responseJson, ok = false)
            }

            return parseVoiceTurnResult(responseJson, ok = responseJson.optBoolean("ok", false))
        }
    }

    private fun parseVoiceTurnResult(responseJson: JSONObject, ok: Boolean): VoiceTurnResult {
        val errorMessage = responseJson.optString("error", "").ifBlank { null }
        val errorDetail = responseJson.optString("errorDetail", "").ifBlank { null }
        val speechText = responseJson.optString("speechText", "").ifBlank { null }
        return VoiceTurnResult(
            ok = ok,
            userText = responseJson.optString("userText", ""),
            assistantText = responseJson.optString("assistantText", ""),
            durationMs = responseJson.optLong("durationMs", 0),
            status = responseJson.optString("status", ""),
            errorMessage = errorMessage,
            speechText = speechText,
            errorDetail = errorDetail ?: errorMessage,
        )
    }

    private fun buildAuthorizedRequest(pathSuffix: String): Request.Builder {
        val baseUrl = appPreferences.gatewayBaseUrl.trimEnd('/')
        val requestBuilder = Request.Builder().url("$baseUrl$pathSuffix")

        val basicUser = appPreferences.basicAuthUser.trim()
        val basicPassword = appPreferences.basicAuthPassword
        if (basicUser.isNotEmpty()) {
            val credentials = Credentials.basic(basicUser, basicPassword)
            requestBuilder.header("Authorization", credentials)
        }

        return requestBuilder
    }
}

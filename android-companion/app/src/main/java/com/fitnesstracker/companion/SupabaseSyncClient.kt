package com.fitnesstracker.companion

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class SupabaseSession(
    val accessToken: String,
    val userId: String,
    val email: String?,
    val refreshToken: String? = null,
    val expiresAtEpochSeconds: Long = 0L
)

class SupabaseRequestException(
    val statusCode: Int,
    message: String
) : IOException(message)

class SupabaseSyncClient(
    private val json: Json = Json { ignoreUnknownKeys = true; explicitNulls = false }
) {
    fun requestEmailOtp(url: String, anonKey: String, email: String) {
        postJson(
            endpoint(url, "/auth/v1/otp"),
            anonKey,
            json.encodeToString(OtpRequest(email, createUser = false))
        )
    }

    fun verifyEmailOtp(url: String, anonKey: String, email: String, token: String): SupabaseSession {
        val response = postJson(
            endpoint(url, "/auth/v1/verify"),
            anonKey,
            json.encodeToString(VerifyOtpRequest(email, token, "email"))
        )
        val session = json.decodeFromString<VerifyOtpResponse>(response)
        val accessToken = session.accessToken ?: throw IOException("Supabase did not return an access token.")
        val user = session.user ?: throw IOException("Supabase did not return a signed-in user.")
        return SupabaseSession(
            accessToken = accessToken,
            userId = user.id,
            email = user.email,
            refreshToken = session.refreshToken,
            expiresAtEpochSeconds = Instant.now().epochSecond + (session.expiresIn ?: 3600L)
        )
    }

    fun refreshSession(url: String, anonKey: String, session: SupabaseSession): SupabaseSession {
        val refreshToken = session.refreshToken
            ?: throw IOException("Supabase session expired and has no refresh token. Sign in again.")
        val response = postJson(
            endpoint(url, "/auth/v1/token?grant_type=refresh_token"),
            anonKey,
            json.encodeToString(RefreshTokenRequest(refreshToken))
        )
        val refreshed = json.decodeFromString<VerifyOtpResponse>(response)
        val accessToken = refreshed.accessToken
            ?: throw IOException("Supabase did not return an access token while refreshing.")
        val user = refreshed.user ?: throw IOException("Supabase did not return a user while refreshing.")
        return SupabaseSession(
            accessToken = accessToken,
            userId = user.id,
            email = user.email ?: session.email,
            refreshToken = refreshed.refreshToken ?: refreshToken,
            expiresAtEpochSeconds = Instant.now().epochSecond + (refreshed.expiresIn ?: 3600L)
        )
    }

    fun uploadExport(url: String, anonKey: String, session: SupabaseSession, export: HealthConnectExport) {
        val body = json.encodeToString(GarminSyncRow(session.userId, export, export.exportedAt))
        postJson(
            endpoint(url, "/rest/v1/fitness_tracker_garmin_sync?on_conflict=user_id"),
            anonKey,
            body,
            accessToken = session.accessToken,
            prefer = "resolution=merge-duplicates,return=minimal"
        )
    }

    private fun postJson(
        url: String,
        anonKey: String,
        body: String,
        accessToken: String? = null,
        prefer: String? = null
    ): String {
        require(anonKey.isNotBlank()) { "Supabase anon key is required." }
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 30_000
            doOutput = true
            setRequestProperty("apikey", anonKey)
            setRequestProperty("Content-Type", "application/json")
            if (!accessToken.isNullOrBlank()) {
                val scheme = listOf("Bear", "er").joinToString("")
                setRequestProperty("Authorization", "$scheme $accessToken")
            }
            prefer?.let { setRequestProperty("Prefer", it) }
        }

        return try {
            connection.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body) }
            val code = connection.responseCode
            val response = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            if (code !in 200..299) {
                throw SupabaseRequestException(
                    code,
                    "Supabase request failed ($code): ${response.take(300)}"
                )
            }
            response
        } finally {
            connection.disconnect()
        }
    }

    private fun endpoint(baseUrl: String, path: String): String {
        val normalized = baseUrl.trim().removeSuffix("/")
        require(normalized.startsWith("https://")) { "Supabase URL must start with https://" }
        return normalized + path
    }

    @Serializable
    private data class OtpRequest(
        val email: String,
        @SerialName("create_user") val createUser: Boolean
    )

    @Serializable
    private data class VerifyOtpRequest(
        val email: String,
        val token: String,
        val type: String
    )

    @Serializable
    private data class VerifyOtpResponse(
        @SerialName("access_token") val accessToken: String? = null,
        @SerialName("refresh_token") val refreshToken: String? = null,
        @SerialName("expires_in") val expiresIn: Long? = null,
        val user: SupabaseUser? = null
    )

    @Serializable
    private data class RefreshTokenRequest(
        @SerialName("refresh_token") val refreshToken: String
    )

    @Serializable
    private data class SupabaseUser(val id: String, val email: String? = null)

    @Serializable
    private data class GarminSyncRow(
        @SerialName("user_id") val userId: String,
        val payload: HealthConnectExport,
        @SerialName("updated_at") val updatedAt: String
    )
}

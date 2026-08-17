package com.fitnesstracker.companion

import android.content.Context

data class SavedSupabaseState(
    val url: String = "",
    val anonKey: String = "",
    val email: String = "",
    val session: SupabaseSession? = null
)

class SupabaseSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun load(): SavedSupabaseState {
        val accessToken = preferences.getString(KEY_ACCESS_TOKEN, null)
        val userId = preferences.getString(KEY_USER_ID, null)
        val refreshToken = preferences.getString(KEY_REFRESH_TOKEN, null)
        val session = if (!accessToken.isNullOrBlank() && !userId.isNullOrBlank()) {
            SupabaseSession(
                accessToken = accessToken,
                userId = userId,
                email = preferences.getString(KEY_SESSION_EMAIL, null),
                refreshToken = refreshToken,
                expiresAtEpochSeconds = preferences.getLong(KEY_EXPIRES_AT, 0L)
            )
        } else {
            null
        }

        return SavedSupabaseState(
            url = preferences.getString(KEY_URL, "").orEmpty(),
            anonKey = preferences.getString(KEY_ANON_KEY, "").orEmpty(),
            email = preferences.getString(KEY_EMAIL, "").orEmpty(),
            session = session
        )
    }

    fun saveConfiguration(url: String, anonKey: String, email: String) {
        preferences.edit()
            .putString(KEY_URL, url)
            .putString(KEY_ANON_KEY, anonKey)
            .putString(KEY_EMAIL, email)
            .apply()
    }

    fun saveSession(session: SupabaseSession) {
        preferences.edit()
            .putString(KEY_ACCESS_TOKEN, session.accessToken)
            .putString(KEY_USER_ID, session.userId)
            .putString(KEY_SESSION_EMAIL, session.email)
            .putString(KEY_REFRESH_TOKEN, session.refreshToken)
            .putLong(KEY_EXPIRES_AT, session.expiresAtEpochSeconds)
            .apply()
    }

    fun clearSession() {
        preferences.edit()
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_USER_ID)
            .remove(KEY_SESSION_EMAIL)
            .remove(KEY_REFRESH_TOKEN)
            .remove(KEY_EXPIRES_AT)
            .apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "supabase_session"
        const val KEY_URL = "url"
        const val KEY_ANON_KEY = "anon_key"
        const val KEY_EMAIL = "email"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_USER_ID = "user_id"
        const val KEY_SESSION_EMAIL = "session_email"
        const val KEY_REFRESH_TOKEN = "refresh_token"
        const val KEY_EXPIRES_AT = "expires_at"
    }
}

package ru.begemot.cursorvoice

import android.content.Context
import java.util.UUID

class AppPreferences(context: Context) {
    private val sharedPreferences =
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    var gatewayBaseUrl: String
        get() = sharedPreferences.getString(KEY_GATEWAY_URL, DEFAULT_GATEWAY_URL) ?: DEFAULT_GATEWAY_URL
        set(value) = sharedPreferences.edit().putString(KEY_GATEWAY_URL, value.trim()).apply()

    var basicAuthUser: String
        get() = sharedPreferences.getString(KEY_BASIC_USER, "") ?: ""
        set(value) = sharedPreferences.edit().putString(KEY_BASIC_USER, value).apply()

    var basicAuthPassword: String
        get() = sharedPreferences.getString(KEY_BASIC_PASSWORD, "") ?: ""
        set(value) = sharedPreferences.edit().putString(KEY_BASIC_PASSWORD, value).apply()

    var workspaceId: String
        get() = sharedPreferences.getString(KEY_WORKSPACE_ID, "default") ?: "default"
        set(value) = sharedPreferences.edit().putString(KEY_WORKSPACE_ID, value.trim()).apply()

    var wakePhrase: String
        get() = sharedPreferences.getString(KEY_WAKE_PHRASE, DEFAULT_WAKE_PHRASE) ?: DEFAULT_WAKE_PHRASE
        set(value) = sharedPreferences.edit().putString(KEY_WAKE_PHRASE, value.trim().lowercase()).apply()

    var chatSessionId: String
        get() {
            val existing = sharedPreferences.getString(KEY_SESSION_ID, null)
            if (!existing.isNullOrBlank()) {
                return existing
            }
            val generated = UUID.randomUUID().toString()
            sharedPreferences.edit().putString(KEY_SESSION_ID, generated).apply()
            return generated
        }
        set(value) = sharedPreferences.edit().putString(KEY_SESSION_ID, value).apply()

    var backgroundServiceEnabled: Boolean
        get() = sharedPreferences.getBoolean(KEY_BACKGROUND_ENABLED, false)
        set(value) = sharedPreferences.edit().putBoolean(KEY_BACKGROUND_ENABLED, value).apply()

    var lastAssistantText: String
        get() = sharedPreferences.getString(KEY_LAST_ASSISTANT_TEXT, "") ?: ""
        set(value) = sharedPreferences.edit().putString(KEY_LAST_ASSISTANT_TEXT, value).apply()

    companion object {
        private const val PREFERENCES_NAME = "cursor_voice_prefs"
        private const val KEY_GATEWAY_URL = "gateway_url"
        private const val KEY_BASIC_USER = "basic_user"
        private const val KEY_BASIC_PASSWORD = "basic_password"
        private const val KEY_WORKSPACE_ID = "workspace_id"
        private const val KEY_WAKE_PHRASE = "wake_phrase"
        private const val KEY_SESSION_ID = "session_id"
        private const val KEY_BACKGROUND_ENABLED = "background_enabled"
        private const val KEY_LAST_ASSISTANT_TEXT = "last_assistant_text"
        const val DEFAULT_GATEWAY_URL = "https://cursor.begemot26.ru"
        const val DEFAULT_WAKE_PHRASE = "эй агент"
    }
}

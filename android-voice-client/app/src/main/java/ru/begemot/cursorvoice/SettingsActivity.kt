package ru.begemot.cursorvoice

import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import ru.begemot.cursorvoice.databinding.ActivitySettingsBinding

class SettingsActivity : AppCompatActivity() {
    private lateinit var activityBinding: ActivitySettingsBinding
    private lateinit var appPreferences: AppPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBinding = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(activityBinding.root)

        appPreferences = AppPreferences(applicationContext)
        activityBinding.gatewayUrlInput.setText(appPreferences.gatewayBaseUrl)
        activityBinding.basicUserInput.setText(appPreferences.basicAuthUser)
        activityBinding.basicPasswordInput.setText(appPreferences.basicAuthPassword)
        activityBinding.workspaceInput.setText(appPreferences.workspaceId)
        activityBinding.wakePhraseInput.setText(appPreferences.wakePhrase)

        activityBinding.saveSettingsButton.setOnClickListener {
            appPreferences.gatewayBaseUrl =
                activityBinding.gatewayUrlInput.text?.toString()?.trim()
                    ?: AppPreferences.DEFAULT_GATEWAY_URL
            appPreferences.basicAuthUser = activityBinding.basicUserInput.text?.toString().orEmpty()
            appPreferences.basicAuthPassword =
                activityBinding.basicPasswordInput.text?.toString().orEmpty()
            appPreferences.workspaceId =
                activityBinding.workspaceInput.text?.toString()?.trim().ifBlank { "default" }
                    ?: "default"
            appPreferences.wakePhrase =
                activityBinding.wakePhraseInput.text?.toString()?.trim()
                    ?: AppPreferences.DEFAULT_WAKE_PHRASE

            Toast.makeText(this, "Сохранено", Toast.LENGTH_SHORT).show()
            finish()
        }
    }
}

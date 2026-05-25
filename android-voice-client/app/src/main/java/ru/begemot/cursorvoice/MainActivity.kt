package ru.begemot.cursorvoice

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ru.begemot.cursorvoice.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity(), VoiceStateListener {
    private lateinit var activityBinding: ActivityMainBinding
    private lateinit var appPreferences: AppPreferences
    private lateinit var voiceTurnOrchestrator: VoiceTurnOrchestrator
    private var isPushToTalkActive = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { permissionResults ->
        val microphoneGranted = permissionResults[Manifest.permission.RECORD_AUDIO] == true
        if (!microphoneGranted) {
            Toast.makeText(this, "Нужен доступ к микрофону", Toast.LENGTH_LONG).show()
        }
    }

    private val serviceEventReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != VoiceForegroundService.ACTION_VOICE_SERVICE_EVENT) {
                return
            }
            val eventType = intent.getStringExtra(VoiceForegroundService.EXTRA_EVENT_TYPE) ?: return
            val payload = intent.getStringExtra(VoiceForegroundService.EXTRA_EVENT_PAYLOAD) ?: return
            if (eventType == "state") {
                activityBinding.statusText.text = payload
            } else if (eventType == "log") {
                appendLogLine(payload)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBinding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(activityBinding.root)

        appPreferences = AppPreferences(applicationContext)
        voiceTurnOrchestrator = VoiceTurnOrchestrator(applicationContext, appPreferences, this)

        requestRuntimePermissions()

        activityBinding.listenButton.setOnClickListener {
            handleListenButtonClick()
        }

        activityBinding.toggleServiceButton.setOnClickListener {
            handleToggleServiceClick()
        }

        activityBinding.settingsButton.setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        updateServiceToggleLabel()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(VoiceForegroundService.ACTION_VOICE_SERVICE_EVENT)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(
                serviceEventReceiver,
                filter,
                Context.RECEIVER_NOT_EXPORTED,
            )
        } else {
            registerReceiver(serviceEventReceiver, filter)
        }
    }

    override fun onStop() {
        unregisterReceiver(serviceEventReceiver)
        super.onStop()
    }

    override fun onStateChanged(state: VoiceClientState, statusLine: String) {
        runOnUiThread {
            activityBinding.statusText.text = statusLine
            activityBinding.listenButton.text = when {
                isPushToTalkActive -> getString(R.string.stop_button)
                else -> getString(R.string.listen_button)
            }
        }
    }

    override fun onLogLine(logLine: String) {
        runOnUiThread { appendLogLine(logLine) }
    }

    private fun handleListenButtonClick() {
        if (isPushToTalkActive) {
            isPushToTalkActive = false
            voiceTurnOrchestrator.finishPushToTalkAndRunTurn()
            return
        }
        isPushToTalkActive = true
        voiceTurnOrchestrator.startPushToTalkRecording()
    }

    private fun handleToggleServiceClick() {
        val shouldEnable = !appPreferences.backgroundServiceEnabled
        appPreferences.backgroundServiceEnabled = shouldEnable

        val serviceIntent = Intent(this, VoiceForegroundService::class.java)
        if (shouldEnable) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
            Toast.makeText(this, "Фоновый режим включён", Toast.LENGTH_SHORT).show()
        } else {
            stopService(serviceIntent)
            Toast.makeText(this, "Фоновый режим выключен", Toast.LENGTH_SHORT).show()
        }
        updateServiceToggleLabel()
    }

    private fun updateServiceToggleLabel() {
        activityBinding.toggleServiceButton.text = if (appPreferences.backgroundServiceEnabled) {
            getString(R.string.stop_service)
        } else {
            getString(R.string.start_service)
        }
    }

    private fun appendLogLine(logLine: String) {
        val existingText = activityBinding.logText.text?.toString().orEmpty()
        val combined = if (existingText.isEmpty()) logLine else "$existingText\n$logLine"
        activityBinding.logText.text = combined
    }

    private fun requestRuntimePermissions() {
        val permissionsToRequest = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missingPermissions = permissionsToRequest.filter { permissionName ->
            ContextCompat.checkSelfPermission(this, permissionName) != PackageManager.PERMISSION_GRANTED
        }

        if (missingPermissions.isNotEmpty()) {
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }
    }
}

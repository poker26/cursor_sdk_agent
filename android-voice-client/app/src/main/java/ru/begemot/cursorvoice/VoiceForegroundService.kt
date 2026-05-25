package ru.begemot.cursorvoice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat

class VoiceForegroundService : Service(), VoiceStateListener {
    private lateinit var appPreferences: AppPreferences
    private lateinit var voiceTurnOrchestrator: VoiceTurnOrchestrator
    private var wakeWordEngine: WakeWordEngine? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var isRecordingCommand = false
    private var lastWakeTriggeredAtMs = 0L

    override fun onCreate() {
        super.onCreate()
        appPreferences = AppPreferences(applicationContext)
        voiceTurnOrchestrator = VoiceTurnOrchestrator(applicationContext, appPreferences, this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildForegroundNotification("Запуск…")
        startForeground(NOTIFICATION_ID, notification)

        val wakePhrase = appPreferences.wakePhrase
        wakeWordEngine?.stopListening()
        wakeWordEngine = WakeWordEngine(applicationContext, wakePhrase) {
            mainHandler.post { handleWakePhraseDetected() }
        }

        if (wakeWordEngine?.startListening() == true) {
            onStateChanged(VoiceClientState.WAKE_LISTENING, "Жду: $wakePhrase")
        } else {
            onStateChanged(VoiceClientState.IDLE, "Нет Vosk-модели")
            onLogLine(getString(R.string.model_missing))
        }

        return START_STICKY
    }

    override fun onDestroy() {
        wakeWordEngine?.stopListening()
        wakeWordEngine = null
        voiceTurnOrchestrator.stopPlayback()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStateChanged(state: VoiceClientState, statusLine: String) {
        val notificationText = when (state) {
            VoiceClientState.WAKE_LISTENING -> statusLine
            VoiceClientState.LISTENING -> statusLine
            VoiceClientState.THINKING -> statusLine
            VoiceClientState.SPEAKING -> statusLine
            VoiceClientState.IDLE -> getString(R.string.notification_text)
        }
        val notificationManager =
            getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.notify(NOTIFICATION_ID, buildForegroundNotification(notificationText))

        broadcastToActivity("state", statusLine)
    }

    override fun onLogLine(logLine: String) {
        broadcastToActivity("log", logLine)
    }

    private fun handleWakePhraseDetected() {
        val nowMs = System.currentTimeMillis()
        if (nowMs - lastWakeTriggeredAtMs < WAKE_COOLDOWN_MS) {
            return
        }
        if (voiceTurnOrchestrator.isBusy() || isRecordingCommand) {
            return
        }
        lastWakeTriggeredAtMs = nowMs
        isRecordingCommand = true
        wakeWordEngine?.stopListening()
        voiceTurnOrchestrator.startPushToTalkRecording()

        mainHandler.postDelayed({
            voiceTurnOrchestrator.finishPushToTalkAndRunTurn()
            isRecordingCommand = false
            restartWakeListening()
        }, COMMAND_RECORDING_MS)
    }

    private fun restartWakeListening() {
        if (voiceTurnOrchestrator.isBusy()) {
            mainHandler.postDelayed({ restartWakeListening() }, 2000)
            return
        }
        val wakePhrase = appPreferences.wakePhrase
        wakeWordEngine = WakeWordEngine(applicationContext, wakePhrase) {
            mainHandler.post { handleWakePhraseDetected() }
        }
        if (wakeWordEngine?.startListening() == true) {
            onStateChanged(VoiceClientState.WAKE_LISTENING, "Жду: $wakePhrase")
        }
    }

    private fun broadcastToActivity(eventType: String, payload: String) {
        val broadcastIntent = Intent(ACTION_VOICE_SERVICE_EVENT)
            .putExtra(EXTRA_EVENT_TYPE, eventType)
            .putExtra(EXTRA_EVENT_PAYLOAD, payload)
        sendBroadcast(broadcastIntent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        val notificationManager =
            getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        notificationManager.createNotificationChannel(channel)
    }

    private fun buildForegroundNotification(contentText: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    companion object {
        const val ACTION_VOICE_SERVICE_EVENT = "ru.begemot.cursorvoice.SERVICE_EVENT"
        const val EXTRA_EVENT_TYPE = "event_type"
        const val EXTRA_EVENT_PAYLOAD = "event_payload"
        private const val NOTIFICATION_CHANNEL_ID = "cursor_voice_channel"
        private const val NOTIFICATION_ID = 41001
        private const val COMMAND_RECORDING_MS = 6000L
        private const val WAKE_COOLDOWN_MS = 4000L
    }
}

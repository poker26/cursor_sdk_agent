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
    private var dialogCommandRecorder: DialogCommandRecorder? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var isRecordingCommand = false
    private var lastWakeTriggeredAtMs = 0L
    private var isDialogSessionActive = false

    override fun onCreate() {
        super.onCreate()
        appPreferences = AppPreferences(applicationContext)
        voiceTurnOrchestrator = VoiceTurnOrchestrator(applicationContext, appPreferences, this)
        voiceTurnOrchestrator.onTurnFullyFinished = {
            mainHandler.post {
                if (isDialogSessionActive) {
                    scheduleEnterDialogListening()
                } else {
                    scheduleRestartWakeListening()
                }
            }
        }
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildForegroundNotification("Запуск…")
        startForeground(NOTIFICATION_ID, notification)

        isDialogSessionActive = false
        dialogCommandRecorder?.stop()
        startWakeListening()

        return START_STICKY
    }

    override fun onDestroy() {
        dialogCommandRecorder?.stop()
        dialogCommandRecorder = null
        wakeWordEngine?.stopListening()
        wakeWordEngine = null
        voiceTurnOrchestrator.stopPlayback()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStateChanged(state: VoiceClientState, statusLine: String) {
        val notificationText = when (state) {
            VoiceClientState.WAKE_LISTENING -> statusLine
            VoiceClientState.DIALOG_LISTENING -> statusLine
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
        isDialogSessionActive = true
        isRecordingCommand = true
        dialogCommandRecorder?.stop()
        wakeWordEngine?.stopListening()
        voiceTurnOrchestrator.startPushToTalkRecording()
        onStateChanged(VoiceClientState.LISTENING, "Слушаю команду…")

        mainHandler.postDelayed({
            voiceTurnOrchestrator.finishPushToTalkAndRunTurn()
            isRecordingCommand = false
        }, COMMAND_RECORDING_MS)
    }

    private fun scheduleEnterDialogListening() {
        mainHandler.postDelayed({ enterDialogListening() }, DIALOG_RESTART_DELAY_MS)
    }

    private fun enterDialogListening() {
        if (!isDialogSessionActive) {
            scheduleRestartWakeListening()
            return
        }
        if (voiceTurnOrchestrator.isBusy() || isRecordingCommand) {
            mainHandler.postDelayed({ enterDialogListening() }, 1500)
            return
        }

        wakeWordEngine?.stopListening()
        dialogCommandRecorder?.stop()

        val dialogRecorder = DialogCommandRecorder(applicationContext)
        dialogCommandRecorder = dialogRecorder

        val idleTimeoutMs = appPreferences.dialogIdleTimeoutMs
        dialogRecorder.start(
            idleTimeoutMs = idleTimeoutMs,
            onUtteranceReady = { recordedUtterance ->
                mainHandler.post {
                    if (voiceTurnOrchestrator.isBusy() || isRecordingCommand) {
                        return@post
                    }
                    dialogCommandRecorder?.stop()
                    onStateChanged(VoiceClientState.LISTENING, "Слушаю команду…")
                    voiceTurnOrchestrator.runVoiceTurnFromDialog(recordedUtterance)
                }
            },
            onIdleTimeout = {
                mainHandler.post { exitDialogSession() }
            },
            onNoSpeechCaptured = {
                mainHandler.post { scheduleEnterDialogListening() }
            },
            onStatusChanged = { statusLine ->
                mainHandler.post {
                    onStateChanged(VoiceClientState.DIALOG_LISTENING, statusLine)
                }
            },
        )
    }

    private fun exitDialogSession() {
        isDialogSessionActive = false
        dialogCommandRecorder?.stop()
        dialogCommandRecorder = null
        onLogLine("Минута тишины — снова жду wake-фразу")
        restartWakeListening()
    }

    private fun startWakeListening() {
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
    }

    private fun scheduleRestartWakeListening() {
        mainHandler.postDelayed({ restartWakeListening() }, WAKE_RESTART_DELAY_MS)
    }

    private fun restartWakeListening() {
        if (voiceTurnOrchestrator.isBusy() || isRecordingCommand) {
            mainHandler.postDelayed({ restartWakeListening() }, 1500)
            return
        }

        dialogCommandRecorder?.stop()
        dialogCommandRecorder = null
        wakeWordEngine?.stopListening()

        val wakePhrase = appPreferences.wakePhrase
        wakeWordEngine = WakeWordEngine(applicationContext, wakePhrase) {
            mainHandler.post { handleWakePhraseDetected() }
        }
        if (wakeWordEngine?.startListening() == true) {
            lastWakeTriggeredAtMs = 0L
            onStateChanged(VoiceClientState.WAKE_LISTENING, "Жду: $wakePhrase")
            onLogLine("Снова слушаю wake-фразу")
        } else {
            onStateChanged(VoiceClientState.IDLE, "Wake не запустился")
            onLogLine("Не удалось перезапустить wake — проверьте модель Vosk")
            mainHandler.postDelayed({ restartWakeListening() }, 5000)
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
        private const val WAKE_RESTART_DELAY_MS = 800L
        private const val DIALOG_RESTART_DELAY_MS = 800L
    }
}

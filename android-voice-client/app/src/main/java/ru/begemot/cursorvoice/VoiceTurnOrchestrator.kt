package ru.begemot.cursorvoice

import android.content.Context
import android.media.MediaPlayer
import java.io.File

enum class VoiceClientState {
    IDLE,
    LISTENING,
    THINKING,
    SPEAKING,
    WAKE_LISTENING,
}

interface VoiceStateListener {
    fun onStateChanged(state: VoiceClientState, statusLine: String)
    fun onLogLine(logLine: String)
}

class VoiceTurnOrchestrator(
    private val applicationContext: Context,
    private val appPreferences: AppPreferences,
    private val stateListener: VoiceStateListener,
) {
    private val agentApiClient = AgentApiClient(appPreferences)
    private val utteranceRecorder = UtteranceRecorder(applicationContext)
    private val localPromptSpeaker = LocalPromptSpeaker(applicationContext)
    private var mediaPlayer: MediaPlayer? = null
    @Volatile
    private var isTurnInProgress = false

    fun isBusy(): Boolean = isTurnInProgress

    fun startPushToTalkRecording() {
        if (isTurnInProgress) {
            stateListener.onLogLine("Уже выполняется запрос")
            return
        }
        localPromptSpeaker.speakPrompt("Слушаю")
        utteranceRecorder.startRecording()
        stateListener.onStateChanged(VoiceClientState.LISTENING, "Слушаю команду…")
    }

    fun repeatLastAssistantSpeech() {
        val lastText = appPreferences.lastAssistantText.trim()
        if (lastText.isEmpty()) {
            stateListener.onLogLine("Нет предыдущего ответа для повтора")
            return
        }
        if (isTurnInProgress) {
            stateListener.onLogLine("Дождитесь окончания текущего запроса")
            return
        }
        Thread {
            try {
                playAssistantSpeech(lastText)
            } catch (repeatError: Exception) {
                stateListener.onLogLine(
                    "Повтор не удался: ${repeatError.message ?: repeatError.toString()}",
                )
            }
        }.start()
    }

    fun finishPushToTalkAndRunTurn() {
        if (isTurnInProgress) {
            return
        }
        val recordedUtterance = utteranceRecorder.stopRecording()
        if (recordedUtterance == null) {
            stateListener.onStateChanged(VoiceClientState.IDLE, "Готов")
            stateListener.onLogLine("Запись пуста")
            return
        }
        runVoiceTurn(recordedUtterance)
    }

    fun runVoiceTurnFromWake(recordedUtterance: RecordedUtterance) {
        if (isTurnInProgress) {
            stateListener.onLogLine("Пропуск: агент занят")
            return
        }
        runVoiceTurn(recordedUtterance)
    }

    fun stopPlayback() {
        mediaPlayer?.stop()
        mediaPlayer?.release()
        mediaPlayer = null
    }

    private fun runVoiceTurn(recordedUtterance: RecordedUtterance) {
        Thread {
            isTurnInProgress = true
            try {
                stateListener.onStateChanged(VoiceClientState.THINKING, "Думаю…")
                localPromptSpeaker.speakPrompt("Думаю")
                val turnResult = agentApiClient.postVoiceTurn(
                    audioBase64 = recordedUtterance.audioBase64,
                    mimeType = recordedUtterance.mimeType,
                )

                stateListener.onLogLine("Вы: ${turnResult.userText}")
                if (!turnResult.ok || turnResult.assistantText.isBlank()) {
                    val errorText = turnResult.errorMessage ?: "Пустой ответ агента"
                    stateListener.onLogLine("Ошибка: $errorText (${turnResult.durationMs} мс)")
                    val speechErrorText =
                        if (errorText.contains("занят", ignoreCase = true)) {
                            "Подождите, агент занят"
                        } else {
                            errorText
                        }
                    speakErrorMessage(speechErrorText)
                } else {
                    appPreferences.lastAssistantText = turnResult.assistantText
                    stateListener.onLogLine(
                        "Агент (${turnResult.durationMs} мс): ${turnResult.assistantText}",
                    )
                    playAssistantSpeech(turnResult.assistantText)
                }
            } catch (runError: Exception) {
                val message = runError.message ?: runError.toString()
                stateListener.onLogLine("Сбой: $message")
                speakErrorMessage(message)
            } finally {
                isTurnInProgress = false
                if (mediaPlayer == null) {
                    stateListener.onStateChanged(VoiceClientState.IDLE, "Готов")
                }
            }
        }.start()
    }

    private fun speakErrorMessage(errorMessage: String) {
        try {
            playAssistantSpeech("Ошибка. $errorMessage")
        } catch (_: Exception) {
            stateListener.onStateChanged(VoiceClientState.IDLE, "Готов")
        }
    }

    private fun playAssistantSpeech(assistantText: String) {
        stateListener.onStateChanged(VoiceClientState.SPEAKING, "Озвучиваю…")
        val audioBytes = agentApiClient.synthesizeSpeech(assistantText)
        val temporaryAudioFile = File.createTempFile("tts_", ".ogg", applicationContext.cacheDir)
        temporaryAudioFile.writeBytes(audioBytes)

        val player = MediaPlayer()
        mediaPlayer = player
        player.setDataSource(temporaryAudioFile.absolutePath)
        player.prepare()
        player.setOnCompletionListener {
            temporaryAudioFile.delete()
            player.release()
            mediaPlayer = null
            stateListener.onStateChanged(VoiceClientState.IDLE, "Готов")
        }
        player.setOnErrorListener { _, _, _ ->
            temporaryAudioFile.delete()
            mediaPlayer = null
            stateListener.onStateChanged(VoiceClientState.IDLE, "Готов")
            true
        }
        player.start()
    }
}

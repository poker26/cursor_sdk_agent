package ru.begemot.cursorvoice

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.AudioRecord.RECORDSTATE_RECORDING
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.math.sqrt

class DialogCommandRecorder(private val applicationContext: Context) {
    @Volatile
    private var isActive = false
    private var monitorThread: Thread? = null
    private var audioRecord: AudioRecord? = null

    fun start(
        idleTimeoutMs: Long,
        onUtteranceReady: (RecordedUtterance) -> Unit,
        onIdleTimeout: () -> Unit,
        onNoSpeechCaptured: () -> Unit,
        onStatusChanged: (String) -> Unit,
    ) {
        stop()
        isActive = true

        monitorThread = Thread {
            var localAudioRecord: AudioRecord? = null
            try {
                val bufferSize = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE_HERTZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                )
                if (bufferSize <= 0) {
                    onStatusChanged("Микрофон недоступен")
                    return@Thread
                }

                localAudioRecord = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE_HERTZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize * 2,
                )
                audioRecord = localAudioRecord
                localAudioRecord.startRecording()

                val audioBuffer = ByteArray(bufferSize)
                val pcmOutputStream = ByteArrayOutputStream()
                val dialogStartedAtMs = System.currentTimeMillis()
                var speechDetected = false
                var speechHoldMs = 0L
                var consecutiveSilenceAfterSpeechMs = 0L
                var lastChunkDurationMs = 0L

                onStatusChanged("Диалог: говорите…")

                while (isActive) {
                    val bytesRead = localAudioRecord.read(audioBuffer, 0, audioBuffer.size)
                    if (bytesRead <= 0) {
                        Thread.sleep(30)
                        continue
                    }

                    lastChunkDurationMs = estimateChunkDurationMs(bytesRead)
                    val rootMeanSquare = calculateRootMeanSquare(audioBuffer, bytesRead)
                    val isSpeechFrame = rootMeanSquare >= SPEECH_RMS_THRESHOLD

                    if (!speechDetected) {
                        val waitingDurationMs = System.currentTimeMillis() - dialogStartedAtMs
                        if (waitingDurationMs >= idleTimeoutMs) {
                            onIdleTimeout()
                            return@Thread
                        }

                        if (isSpeechFrame) {
                            speechHoldMs += lastChunkDurationMs
                            if (speechHoldMs >= SPEECH_START_HOLD_MS) {
                                speechDetected = true
                                pcmOutputStream.write(audioBuffer, 0, bytesRead)
                                onStatusChanged("Слушаю команду…")
                            }
                        } else {
                            speechHoldMs = 0L
                        }
                        continue
                    }

                    pcmOutputStream.write(audioBuffer, 0, bytesRead)

                    if (isSpeechFrame) {
                        consecutiveSilenceAfterSpeechMs = 0L
                    } else {
                        consecutiveSilenceAfterSpeechMs += lastChunkDurationMs
                        if (consecutiveSilenceAfterSpeechMs >= SILENCE_AFTER_SPEECH_MS) {
                            break
                        }
                    }

                    if (pcmOutputStream.size() >= MAX_PCM_BYTES) {
                        break
                    }
                }

                if (!speechDetected || pcmOutputStream.size() < MIN_PCM_BYTES) {
                    onNoSpeechCaptured()
                    return@Thread
                }

                val wavBytes = PcmWavEncoder.encodePcm16MonoToWav(
                    pcmOutputStream.toByteArray(),
                    SAMPLE_RATE_HERTZ,
                )
                val audioBase64 = Base64.getEncoder().encodeToString(wavBytes)
                onUtteranceReady(
                    RecordedUtterance(audioBase64 = audioBase64, mimeType = "audio/wav"),
                )
            } catch (_: Exception) {
                onStatusChanged("Ошибка записи диалога")
            } finally {
                isActive = false
                try {
                    if (localAudioRecord?.recordingState == RECORDSTATE_RECORDING) {
                        localAudioRecord.stop()
                    }
                } catch (_: Exception) {
                    /* already stopped */
                }
                try {
                    localAudioRecord?.release()
                } catch (_: Exception) {
                    /* already released */
                }
                audioRecord = null
            }
        }
        monitorThread?.start()
    }

    fun stop() {
        isActive = false
        val recordToStop = audioRecord
        audioRecord = null
        if (recordToStop != null) {
            try {
                if (recordToStop.recordingState == RECORDSTATE_RECORDING) {
                    recordToStop.stop()
                }
            } catch (_: Exception) {
                /* already stopped */
            }
            try {
                recordToStop.release()
            } catch (_: Exception) {
                /* already released */
            }
        }
        monitorThread?.join(2500)
        monitorThread = null
    }

    private fun calculateRootMeanSquare(audioBuffer: ByteArray, bytesRead: Int): Double {
        var sumOfSquares = 0.0
        var sampleCount = 0
        var index = 0
        while (index + 1 < bytesRead) {
            val lowByte = audioBuffer[index].toInt() and 0xff
            val highByte = audioBuffer[index + 1].toInt()
            val sampleValue = (highByte shl 8) or lowByte
            val signedSample = if (sampleValue > 32767) sampleValue - 65536 else sampleValue
            sumOfSquares += (signedSample * signedSample).toDouble()
            sampleCount += 1
            index += 2
        }
        if (sampleCount == 0) {
            return 0.0
        }
        return sqrt(sumOfSquares / sampleCount)
    }

    private fun estimateChunkDurationMs(bytesRead: Int): Long {
        val sampleCount = bytesRead / 2
        return (sampleCount * 1000L) / SAMPLE_RATE_HERTZ
    }

    companion object {
        private const val SAMPLE_RATE_HERTZ = 16000
        private const val SPEECH_RMS_THRESHOLD = 550.0
        private const val SPEECH_START_HOLD_MS = 250L
        private const val SILENCE_AFTER_SPEECH_MS = 1400L
        private const val MIN_PCM_BYTES = 8000
        private const val MAX_PCM_BYTES = 16000 * 2 * 30
    }
}

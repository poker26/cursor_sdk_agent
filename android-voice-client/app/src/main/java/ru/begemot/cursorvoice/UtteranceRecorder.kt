package ru.begemot.cursorvoice

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File
import java.util.Base64

class UtteranceRecorder(private val applicationContext: Context) {
    private var mediaRecorder: MediaRecorder? = null
    private var recordingFile: File? = null

    fun startRecording(): File {
        stopRecording()
        val outputFile = File.createTempFile("voice_cmd_", ".m4a", applicationContext.cacheDir)
        recordingFile = outputFile

        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(applicationContext)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        recorder.setAudioSamplingRate(48000)
        recorder.setAudioEncodingBitRate(128000)
        recorder.setOutputFile(outputFile.absolutePath)
        recorder.prepare()
        recorder.start()
        mediaRecorder = recorder
        return outputFile
    }

    fun stopRecording(): RecordedUtterance? {
        val activeRecorder = mediaRecorder ?: return null
        val recordedFile = recordingFile

        try {
            activeRecorder.stop()
        } catch (_: RuntimeException) {
            recordedFile?.delete()
            return null
        } finally {
            activeRecorder.release()
            mediaRecorder = null
        }

        if (recordedFile == null || !recordedFile.exists() || recordedFile.length() == 0L) {
            recordedFile?.delete()
            recordingFile = null
            return null
        }

        val audioBytes = recordedFile.readBytes()
        recordedFile.delete()
        recordingFile = null

        val audioBase64 = Base64.getEncoder().encodeToString(audioBytes)
        return RecordedUtterance(audioBase64 = audioBase64, mimeType = "audio/mp4")
    }
}

data class RecordedUtterance(
    val audioBase64: String,
    val mimeType: String,
)

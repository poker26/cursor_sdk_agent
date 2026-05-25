package ru.begemot.cursorvoice

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

class WakeWordEngine(
    private val applicationContext: Context,
    private val wakePhrase: String,
    private val onWakePhraseDetected: () -> Unit,
) {
    private var recognitionThread: Thread? = null
    @Volatile
    private var isListening = false
    private var audioRecord: AudioRecord? = null

    fun startListening(): Boolean {
        if (isListening) {
            return true
        }

        val modelDirectory = resolveVoskModelDirectory()
        if (modelDirectory == null) {
            return false
        }

        val normalizedWakePhrase = wakePhrase.trim().lowercase()
        if (normalizedWakePhrase.isEmpty()) {
            return false
        }

        isListening = true
        recognitionThread = Thread {
            try {
                val voskModel = Model(modelDirectory.absolutePath)
                val recognizer = Recognizer(voskModel, SAMPLE_RATE_HERTZ.toFloat())
                recognizer.setWords(true)

                val bufferSize = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE_HERTZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                )

                val record = AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE_HERTZ,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize * 2,
                )
                audioRecord = record
                record.startRecording()

                val audioBuffer = ByteArray(bufferSize)
                while (isListening) {
                    val bytesRead = record.read(audioBuffer, 0, audioBuffer.size)
                    if (bytesRead > 0 && recognizer.acceptWaveForm(audioBuffer, bytesRead)) {
                        checkPartialForWakePhrase(recognizer.partialResult, normalizedWakePhrase)
                    } else {
                        checkPartialForWakePhrase(recognizer.partialResult, normalizedWakePhrase)
                    }
                }

                record.stop()
                record.release()
                recognizer.close()
                voskModel.close()
            } catch (_: Exception) {
                isListening = false
            }
        }
        recognitionThread?.start()
        return true
    }

    fun stopListening() {
        isListening = false
        audioRecord?.stop()
        audioRecord?.release()
        audioRecord = null
        recognitionThread?.join(1500)
        recognitionThread = null
    }

    fun isModelAvailable(): Boolean = resolveVoskModelDirectory() != null

    private fun checkPartialForWakePhrase(partialJson: String, normalizedWakePhrase: String) {
        try {
            val partialText = JSONObject(partialJson).optString("partial", "").lowercase()
            if (partialText.contains(normalizedWakePhrase)) {
                onWakePhraseDetected()
            }
        } catch (_: Exception) {
            /* ignore malformed partial */
        }
    }

    private fun resolveVoskModelDirectory(): File? {
        val targetDirectory = File(applicationContext.filesDir, "model-small-ru")
        if (File(targetDirectory, "am/final.mdl").exists()) {
            return targetDirectory
        }

        val assetsModelPath = "model-small-ru"
        return try {
            copyAssetFolderToFiles(assetsModelPath, targetDirectory)
            if (File(targetDirectory, "am/final.mdl").exists()) {
                targetDirectory
            } else {
                null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun copyAssetFolderToFiles(assetFolderName: String, targetDirectory: File) {
        val assetManager = applicationContext.assets
        val assetEntries = assetManager.list(assetFolderName) ?: return
        if (!targetDirectory.exists()) {
            targetDirectory.mkdirs()
        }
        for (assetEntry in assetEntries) {
            val assetPath = "$assetFolderName/$assetEntry"
            val nestedEntries = assetManager.list(assetPath)
            if (nestedEntries != null && nestedEntries.isNotEmpty()) {
                copyAssetFolderToFiles(assetPath, File(targetDirectory, assetEntry))
            } else {
                val outputFile = File(targetDirectory, assetEntry)
                if (assetPath.endsWith(".zip")) {
                    extractZipAsset(assetPath, targetDirectory.parentFile ?: targetDirectory)
                } else {
                    assetManager.open(assetPath).use { inputStream ->
                        FileOutputStream(outputFile).use { outputStream ->
                            inputStream.copyTo(outputStream)
                        }
                    }
                }
            }
        }
    }

    private fun extractZipAsset(zipAssetPath: String, targetDirectory: File) {
        applicationContext.assets.open(zipAssetPath).use { assetInputStream ->
            ZipInputStream(BufferedInputStream(assetInputStream)).use { zipInputStream ->
                var zipEntry = zipInputStream.nextEntry
                while (zipEntry != null) {
                    val outputFile = File(targetDirectory, zipEntry.name)
                    if (zipEntry.isDirectory) {
                        outputFile.mkdirs()
                    } else {
                        outputFile.parentFile?.mkdirs()
                        FileOutputStream(outputFile).use { outputStream ->
                            zipInputStream.copyTo(outputStream)
                        }
                    }
                    zipEntry = zipInputStream.nextEntry
                }
            }
        }
    }

    companion object {
        private const val SAMPLE_RATE_HERTZ = 16000
    }
}

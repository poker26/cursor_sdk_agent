package ru.begemot.cursorvoice

import android.content.Context
import android.speech.tts.TextToSpeech
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LocalPromptSpeaker(context: Context) {
    private var textToSpeech: TextToSpeech? = null
    private var isReady = false

    init {
        textToSpeech = TextToSpeech(context.applicationContext) { initializationStatus ->
            isReady = initializationStatus == TextToSpeech.SUCCESS
            if (isReady) {
                textToSpeech?.language = Locale.forLanguageTag("ru-RU")
            }
        }
    }

    fun speakPrompt(promptText: String) {
        if (!isReady) {
            return
        }
        textToSpeech?.speak(promptText, TextToSpeech.QUEUE_FLUSH, null, "prompt-$promptText")
    }

    fun speakPromptAndWait(promptText: String, waitMillis: Long = 1200L) {
        if (!isReady) {
            return
        }
        val completionLatch = CountDownLatch(1)
        textToSpeech?.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                completionLatch.countDown()
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                completionLatch.countDown()
            }
        })
        textToSpeech?.speak(promptText, TextToSpeech.QUEUE_FLUSH, null, "wait-prompt")
        completionLatch.await(waitMillis, TimeUnit.MILLISECONDS)
    }

    fun shutdown() {
        textToSpeech?.shutdown()
        textToSpeech = null
        isReady = false
    }
}

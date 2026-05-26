package ru.begemot.cursorvoice

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

object PcmWavEncoder {
    fun encodePcm16MonoToWav(pcmAudioBytes: ByteArray, sampleRateHertz: Int): ByteArray {
        val channelCount = 1
        val bitsPerSample = 16
        val byteRate = sampleRateHertz * channelCount * bitsPerSample / 8
        val blockAlign = (channelCount * bitsPerSample / 8).toShort()
        val dataSize = pcmAudioBytes.size
        val wavOutputStream = ByteArrayOutputStream(44 + dataSize)

        wavOutputStream.write("RIFF".toByteArray())
        wavOutputStream.write(intToLittleEndianBytes(36 + dataSize))
        wavOutputStream.write("WAVE".toByteArray())
        wavOutputStream.write("fmt ".toByteArray())
        wavOutputStream.write(intToLittleEndianBytes(16))
        wavOutputStream.write(shortToLittleEndianBytes(1))
        wavOutputStream.write(shortToLittleEndianBytes(channelCount.toShort()))
        wavOutputStream.write(intToLittleEndianBytes(sampleRateHertz))
        wavOutputStream.write(intToLittleEndianBytes(byteRate))
        wavOutputStream.write(shortToLittleEndianBytes(blockAlign))
        wavOutputStream.write(shortToLittleEndianBytes(bitsPerSample.toShort()))
        wavOutputStream.write("data".toByteArray())
        wavOutputStream.write(intToLittleEndianBytes(dataSize))
        wavOutputStream.write(pcmAudioBytes)

        return wavOutputStream.toByteArray()
    }

    private fun intToLittleEndianBytes(value: Int): ByteArray {
        return ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
    }

    private fun shortToLittleEndianBytes(value: Short): ByteArray {
        return ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value).array()
    }
}

import { loadYandexVoiceConfig } from "./config.js";

function splitTextIntoTtsChunks(text: string, maxChunkLength: number): string[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return [];
  }
  if (normalizedText.length <= maxChunkLength) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let remainingText = normalizedText;

  while (remainingText.length > maxChunkLength) {
    let splitIndex = remainingText.lastIndexOf("\n\n", maxChunkLength);
    if (splitIndex < maxChunkLength * 0.4) {
      splitIndex = remainingText.lastIndexOf(". ", maxChunkLength);
    }
    if (splitIndex < maxChunkLength * 0.4) {
      splitIndex = remainingText.lastIndexOf(" ", maxChunkLength);
    }
    if (splitIndex < 1) {
      splitIndex = maxChunkLength;
    }
    chunks.push(remainingText.slice(0, splitIndex).trim());
    remainingText = remainingText.slice(splitIndex).trim();
  }

  if (remainingText) {
    chunks.push(remainingText);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

async function synthesizeSingleChunkWithYandex(textChunk: string): Promise<Buffer> {
  const voiceConfig = loadYandexVoiceConfig();

  const formBody = new URLSearchParams({
    text: textChunk,
    lang: voiceConfig.ttsLang,
    voice: voiceConfig.ttsVoice,
    format: voiceConfig.ttsFormat,
    folderId: voiceConfig.folderId,
    speed: voiceConfig.ttsSpeed,
  });

  const httpResponse = await fetch(
    "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize",
    {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${voiceConfig.apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formBody.toString(),
    },
  );

  if (!httpResponse.ok) {
    const errorText = await httpResponse.text();
    throw new Error(`Yandex TTS HTTP ${httpResponse.status}: ${errorText.slice(0, 400)}`);
  }

  const arrayBuffer = await httpResponse.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function synthesizeSpeechWithYandex(text: string): Promise<{
  audioBuffer: Buffer;
  contentType: string;
  chunkCount: number;
}> {
  const voiceConfig = loadYandexVoiceConfig();
  const textChunks = splitTextIntoTtsChunks(text, voiceConfig.maxTtsChars);

  if (textChunks.length === 0) {
    throw new Error("Нет текста для озвучивания.");
  }

  const audioBuffers: Buffer[] = [];
  for (const textChunk of textChunks) {
    audioBuffers.push(await synthesizeSingleChunkWithYandex(textChunk));
  }

  const combinedBuffer = Buffer.concat(audioBuffers);
  const contentType =
    voiceConfig.ttsFormat === "lpcm" ? "audio/wav" : "audio/ogg";

  return {
    audioBuffer: combinedBuffer,
    contentType,
    chunkCount: textChunks.length,
  };
}

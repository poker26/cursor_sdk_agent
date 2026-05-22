import type express from "express";
import {
  getVoicePublicConfig,
  isVoiceEnabled,
  loadYandexVoiceConfig,
} from "./config.js";
import { guessMimeTypeFromFilename } from "./audio-convert.js";
import { transcribeAudioWithYandex } from "./yandex-stt.js";
import { synthesizeSpeechWithYandex } from "./yandex-tts.js";
import { prepareTextForSpeechSynthesis } from "./text-for-tts.js";

interface VoiceTranscribeRequestBody {
  audioBase64?: string;
  mimeType?: string;
  filename?: string;
}

interface VoiceSynthesizeRequestBody {
  text?: string;
}

function decodeBase64AudioPayload(audioBase64: string): Buffer {
  const normalizedBase64 = audioBase64.replace(/\s/g, "");
  return Buffer.from(normalizedBase64, "base64");
}

export function registerVoiceRoutes(application: express.Application): void {
  application.get("/api/voice/status", (_request, response) => {
    response.json(getVoicePublicConfig());
  });

  application.post("/api/voice/transcribe", async (request, response) => {
    if (!isVoiceEnabled()) {
      response.status(503).json({ error: "Голос отключён: задайте YANDEX_API_KEY и YANDEX_FOLDER_ID." });
      return;
    }

    const requestBody = request.body as VoiceTranscribeRequestBody;
    const audioBase64 =
      typeof requestBody.audioBase64 === "string" ? requestBody.audioBase64.trim() : "";
    if (!audioBase64) {
      response.status(400).json({ error: "Нужно поле audioBase64." });
      return;
    }

    let voiceConfig;
    try {
      voiceConfig = loadYandexVoiceConfig();
    } catch (configError) {
      response.status(503).json({
        error: configError instanceof Error ? configError.message : String(configError),
      });
      return;
    }

    let audioBuffer: Buffer;
    try {
      audioBuffer = decodeBase64AudioPayload(audioBase64);
    } catch {
      response.status(400).json({ error: "Некорректный audioBase64." });
      return;
    }

    if (audioBuffer.length > voiceConfig.maxAudioBytes) {
      response.status(400).json({
        error: `Аудио слишком большое (макс. ${voiceConfig.maxAudioBytes} байт).`,
      });
      return;
    }

    const mimeType =
      typeof requestBody.mimeType === "string" && requestBody.mimeType.trim()
        ? requestBody.mimeType.trim()
        : guessMimeTypeFromFilename(
            typeof requestBody.filename === "string" ? requestBody.filename : "",
          );

    try {
      const sttResult = await transcribeAudioWithYandex(audioBuffer, mimeType);
      response.json({
        text: sttResult.text,
        autoSend: voiceConfig.autoSendTranscription,
      });
    } catch (transcribeError) {
      response.status(502).json({
        error:
          transcribeError instanceof Error
            ? transcribeError.message
            : String(transcribeError),
      });
    }
  });

  application.post("/api/voice/synthesize", async (request, response) => {
    if (!isVoiceEnabled()) {
      response.status(503).json({ error: "Голос отключён: задайте YANDEX_API_KEY и YANDEX_FOLDER_ID." });
      return;
    }

    const requestBody = request.body as VoiceSynthesizeRequestBody;
    const rawTextToSpeak =
      typeof requestBody.text === "string" ? requestBody.text.trim() : "";
    if (!rawTextToSpeak) {
      response.status(400).json({ error: "Нужно поле text." });
      return;
    }

    const textToSpeak = prepareTextForSpeechSynthesis(rawTextToSpeak);
    if (!textToSpeak) {
      response.status(400).json({
        error: "После очистки markdown не осталось текста для озвучивания.",
      });
      return;
    }

    try {
      const synthesisResult = await synthesizeSpeechWithYandex(textToSpeak);
      response.setHeader("Content-Type", synthesisResult.contentType);
      response.setHeader("X-Voice-Tts-Chunks", String(synthesisResult.chunkCount));
      response.send(synthesisResult.audioBuffer);
    } catch (synthesisError) {
      response.status(502).json({
        error:
          synthesisError instanceof Error
            ? synthesisError.message
            : String(synthesisError),
      });
    }
  });
}

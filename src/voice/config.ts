import {
  getVoiceErrorBriefSpeechText,
  getVoiceErrorBusySpeechText,
} from "./voice-error-speech.js";

export interface YandexVoiceConfig {
  apiKey: string;
  folderId: string;
  sttLang: string;
  sttFormat: "oggopus" | "lpcm";
  ttsLang: string;
  ttsVoice: string;
  ttsFormat: "oggopus" | "lpcm";
  ttsSpeed: string;
  maxAudioBytes: number;
  maxTtsChars: number;
  autoSendTranscription: boolean;
}

const DEFAULT_STT_LANG = "ru-RU";
const DEFAULT_TTS_LANG = "ru-RU";
const DEFAULT_TTS_VOICE = "alena";
const DEFAULT_TTS_FORMAT = "oggopus";
const DEFAULT_STT_FORMAT = "oggopus";
const DEFAULT_MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TTS_CHARS = 4500;

export function isVoiceEnabled(): boolean {
  if (process.env.VOICE_ENABLED?.trim().toLowerCase() === "false") {
    return false;
  }
  return Boolean(process.env.YANDEX_API_KEY?.trim() && process.env.YANDEX_FOLDER_ID?.trim());
}

export function isVoiceAutoSendEnabled(): boolean {
  const rawValue = process.env.VOICE_AUTO_SEND?.trim().toLowerCase();
  if (rawValue === "false") {
    return false;
  }
  if (rawValue === "true") {
    return true;
  }
  return true;
}

export function loadYandexVoiceConfig(): YandexVoiceConfig {
  const apiKey = process.env.YANDEX_API_KEY?.trim() || "";
  const folderId = process.env.YANDEX_FOLDER_ID?.trim() || "";
  if (!apiKey || !folderId) {
    throw new Error("YANDEX_API_KEY и YANDEX_FOLDER_ID обязательны для голоса.");
  }

  const sttFormatRaw = process.env.YANDEX_STT_FORMAT?.trim() || DEFAULT_STT_FORMAT;
  const ttsFormatRaw = process.env.YANDEX_TTS_FORMAT?.trim() || DEFAULT_TTS_FORMAT;

  return {
    apiKey,
    folderId,
    sttLang: process.env.YANDEX_STT_LANG?.trim() || DEFAULT_STT_LANG,
    sttFormat: sttFormatRaw === "lpcm" ? "lpcm" : "oggopus",
    ttsLang: process.env.YANDEX_TTS_LANG?.trim() || DEFAULT_TTS_LANG,
    ttsVoice: process.env.YANDEX_TTS_VOICE?.trim() || DEFAULT_TTS_VOICE,
    ttsFormat: ttsFormatRaw === "lpcm" ? "lpcm" : "oggopus",
    ttsSpeed: process.env.YANDEX_TTS_SPEED?.trim() || "1.0",
    maxAudioBytes: Number.parseInt(
      process.env.VOICE_MAX_AUDIO_BYTES || String(DEFAULT_MAX_AUDIO_BYTES),
      10,
    ),
    maxTtsChars: Number.parseInt(
      process.env.VOICE_MAX_TTS_CHARS || String(DEFAULT_MAX_TTS_CHARS),
      10,
    ),
    autoSendTranscription: isVoiceAutoSendEnabled(),
  };
}

export function getVoicePublicConfig(): {
  enabled: boolean;
  autoSend: boolean;
  sttLang: string;
  ttsVoice: string;
  ttsLang: string;
  errorBriefSpeech: string;
  errorBusySpeech: string;
} {
  if (!isVoiceEnabled()) {
    return {
      enabled: false,
      autoSend: false,
      sttLang: DEFAULT_STT_LANG,
      ttsVoice: DEFAULT_TTS_VOICE,
      ttsLang: DEFAULT_TTS_LANG,
      errorBriefSpeech: getVoiceErrorBriefSpeechText(),
      errorBusySpeech: getVoiceErrorBusySpeechText(),
    };
  }
  try {
    const config = loadYandexVoiceConfig();
    return {
      enabled: true,
      autoSend: config.autoSendTranscription,
      sttLang: config.sttLang,
      ttsVoice: config.ttsVoice,
      ttsLang: config.ttsLang,
      errorBriefSpeech: getVoiceErrorBriefSpeechText(),
      errorBusySpeech: getVoiceErrorBusySpeechText(),
    };
  } catch {
    return {
      enabled: false,
      autoSend: false,
      sttLang: DEFAULT_STT_LANG,
      ttsVoice: DEFAULT_TTS_VOICE,
      ttsLang: DEFAULT_TTS_LANG,
      errorBriefSpeech: getVoiceErrorBriefSpeechText(),
      errorBusySpeech: getVoiceErrorBusySpeechText(),
    };
  }
}

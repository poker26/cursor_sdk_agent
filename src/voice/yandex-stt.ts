import { loadYandexVoiceConfig } from "./config.js";
import { prepareAudioBufferForYandexStt } from "./audio-convert.js";

export interface YandexSttResult {
  text: string;
  raw?: unknown;
}

export async function transcribeAudioWithYandex(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<YandexSttResult> {
  const voiceConfig = loadYandexVoiceConfig();
  const { audioBuffer: preparedBuffer, format } = await prepareAudioBufferForYandexStt(
    audioBuffer,
    mimeType,
  );

  const queryParameters = new URLSearchParams({
    folderId: voiceConfig.folderId,
    lang: voiceConfig.sttLang,
    format,
  });

  const recognizeUrl = `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?${queryParameters.toString()}`;

  const httpResponse = await fetch(recognizeUrl, {
    method: "POST",
    headers: {
      Authorization: `Api-Key ${voiceConfig.apiKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: preparedBuffer,
  });

  const responseBodyText = await httpResponse.text();
  if (!httpResponse.ok) {
    throw new Error(`Yandex STT HTTP ${httpResponse.status}: ${responseBodyText.slice(0, 400)}`);
  }

  let recognizedText = responseBodyText.trim();
  try {
    const parsedJson = JSON.parse(responseBodyText) as {
      result?: string;
      error_message?: string;
    };
    if (parsedJson.error_message) {
      throw new Error(parsedJson.error_message);
    }
    if (typeof parsedJson.result === "string") {
      recognizedText = parsedJson.result;
    }
  } catch (parseError) {
    if (!(parseError instanceof SyntaxError)) {
      throw parseError;
    }
  }

  const trimmedText = recognizedText.trim();
  if (!trimmedText) {
    throw new Error("Распознавание вернуло пустой текст. Повторите запись.");
  }

  return { text: trimmedText, raw: responseBodyText };
}

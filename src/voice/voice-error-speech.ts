const DEFAULT_BRIEF_ERROR_SPEECH = "Не удалось выполнить запрос. Подробности в чате.";
const DEFAULT_BUSY_ERROR_SPEECH =
  "Подождите, агент занят. Повторите через минуту.";

export function getVoiceErrorBriefSpeechText(): string {
  return (
    process.env.VOICE_ERROR_SPEECH_BRIEF?.trim() || DEFAULT_BRIEF_ERROR_SPEECH
  );
}

export function getVoiceErrorBusySpeechText(): string {
  return (
    process.env.VOICE_ERROR_SPEECH_BUSY?.trim() || DEFAULT_BUSY_ERROR_SPEECH
  );
}

/**
 * Короткая фраза для TTS при ошибке голосового запроса (без чтения длинного текста).
 */
export function resolveVoiceErrorBriefSpeechText(
  errorDetailMessage?: string,
): string {
  if (errorDetailMessage && /занят/i.test(errorDetailMessage)) {
    return getVoiceErrorBusySpeechText();
  }
  return getVoiceErrorBriefSpeechText();
}

export function buildVoiceTurnErrorPayload(errorDetail: string): {
  error: string;
  errorDetail: string;
  speechText: string;
  assistantText: string;
} {
  const trimmedDetail = errorDetail.trim() || "Неизвестная ошибка";
  return {
    error: trimmedDetail,
    errorDetail: trimmedDetail,
    speechText: resolveVoiceErrorBriefSpeechText(trimmedDetail),
    assistantText: "",
  };
}

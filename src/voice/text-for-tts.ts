/** Удаляет URL и похожие фрагменты — диктор их не читает. */
function stripUrlsFromTextForSpeech(text: string): string {
  let withoutUrls = text;

  const urlPatterns = [
    /(?:https?|ftp|mailto):\/\/[^\s<>"'`,)\]]+/gi,
    /<\s*(?:https?|ftp|mailto):\/\/[^>]+>/gi,
    /\bwww\.[^\s<>"'`,)\]]+/gi,
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/[^\s<>"'`,)\]]*)?/gi,
    /\b[a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)*\.[a-z]{2,}(?::\d{1,5})(?:\/[^\s<>"'`,)\]]*)?/gi,
    /\b[a-z0-9][-a-z0-9]*(?:\.[a-z0-9][-a-z0-9]*)*\.[a-z]{2,}\/[^\s<>"'`,)\]]+/gi,
  ];

  for (const urlPattern of urlPatterns) {
    withoutUrls = withoutUrls.replace(urlPattern, " ");
  }

  return withoutUrls;
}

/** Убирает преамбулы и блоки ссылок, которые портят озвучку. */
function stripVoiceUnfriendlyProse(text: string): string {
  let prose = text;

  prose = prose.replace(
    /^.*\b(?:уточняю|перечитываю|сейчас открою|через подключённый exchange|подключённый exchange)\b.*$/gim,
    " ",
  );

  const linksSectionMatch = prose.search(/\b(?:ссылки|ссылка)\s*:/i);
  if (linksSectionMatch !== -1) {
    prose = prose.slice(0, linksSectionMatch);
  }

  prose = prose.replace(
    /\b(?:посмотрите|откройте)\s+(?:поле\s+)?(?:место|ссылку).+$/gim,
    " ",
  );
  prose = prose.replace(/телемост\s+яндекс\s+[^\n.]{8,}/gi, " Телемост ");
  prose = prose.replace(/zoom\s+как\s+в\s+месте\s+встречи[^\n.]*/gi, " Zoom ");

  return prose;
}

/**
 * Убирает markdown и служебный шум перед Yandex TTS — диктор читает связный текст.
 */
export function prepareTextForSpeechSynthesis(rawText: string): string {
  let cleanedText = rawText.replace(/\r\n/g, "\n");

  cleanedText = stripVoiceUnfriendlyProse(cleanedText);

  cleanedText = cleanedText.replace(/```[\s\S]*?```/g, " ");
  cleanedText = cleanedText.replace(/`[^`\n]+`/g, " ");

  cleanedText = cleanedText.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  cleanedText = cleanedText.replace(/^#{1,6}\s+/gm, "");
  cleanedText = cleanedText.replace(/^\s{0,3}>\s?/gm, "");

  cleanedText = cleanedText.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleanedText = cleanedText.replace(/__([^_]+)__/g, "$1");
  cleanedText = cleanedText.replace(/\*([^*\n]+)\*/g, "$1");
  cleanedText = cleanedText.replace(/_([^_\n]+)_/g, "$1");
  cleanedText = cleanedText.replace(/~~([^~]+)~~/g, "$1");

  cleanedText = cleanedText.replace(/^\s*[-*+]\s+/gm, "");
  cleanedText = cleanedText.replace(/^\s*\d+\.\s+/gm, "");
  cleanedText = cleanedText.replace(/^[-*_]{3,}\s*$/gm, " ");
  cleanedText = cleanedText.replace(/^\s*\|.*\|\s*$/gm, " ");
  cleanedText = cleanedText.replace(/^\s*\|?[-:|\s]+\|?\s*$/gm, " ");

  cleanedText = cleanedText.replace(/^[▶✓✗]\s+\S+.*$/gm, " ");
  cleanedText = cleanedText.replace(/^\(.*UTC.*\)\s*$/gim, " ");
  cleanedText = cleanedText.replace(/Meeting ID|Passcode|сводка по/gi, " ");

  cleanedText = cleanedText.replace(/<[^>]+>/g, " ");

  cleanedText = stripUrlsFromTextForSpeech(cleanedText);

  cleanedText = cleanedText.replace(/[#*_~`|\\[\]{}]/g, " ");

  cleanedText = stripUrlsFromTextForSpeech(cleanedText);
  cleanedText = stripVoiceUnfriendlyProse(cleanedText);
  cleanedText = cleanedText.replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, " ");
  cleanedText = cleanedText.replace(/\s+/g, " ");
  cleanedText = cleanedText.replace(/\n+/g, ". ");

  return cleanedText.trim();
}

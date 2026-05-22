/**
 * Убирает markdown и служебный шум перед Yandex TTS — диктор читает связный текст.
 */
export function prepareTextForSpeechSynthesis(rawText: string): string {
  let cleanedText = rawText.replace(/\r\n/g, "\n");

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

  cleanedText = cleanedText.replace(/^[▶✓✗]\s+\S+.*$/gm, " ");

  cleanedText = cleanedText.replace(/<[^>]+>/g, " ");
  cleanedText = cleanedText.replace(/https?:\/\/\S+/gi, " ");

  cleanedText = cleanedText.replace(/[#*_~`|\\[\]{}]/g, " ");
  cleanedText = cleanedText.replace(/\s+/g, " ");
  cleanedText = cleanedText.replace(/\n+/g, ". ");

  return cleanedText.trim();
}

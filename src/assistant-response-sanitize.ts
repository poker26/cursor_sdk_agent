const PROCESS_LINE_PATTERN =
  /^(?:запрашиваю|загружаю|проверяю|смотрю|уточняю|сейчас\b|перечитываю|обращаюсь)/i;

const PROCESS_CONTENT_PATTERN =
  /(?:подключённ\w*\s+exchange|через\s+(?:подключённ\w*\s+)?exchange|запрашиваю\s+календарь)/i;

const TRAILING_LINE_PATTERN =
  /^(?:для краткой сводки|уточнение по|если под|по календарю\s+[«"]|взята как|ниже\s+список|###\s)/i;

const TRAILING_CONTENT_PATTERN =
  /(?:для краткой сводки|взята как|пн[–-]вс\s+после|следующая\s+(?:календарная\s+)?неделя\s+взята|уточнение\s+по\s+охвату)/i;

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function isProcessParagraph(paragraph: string): boolean {
  const firstLine = paragraph.split("\n")[0]?.trim() ?? paragraph;
  if (PROCESS_LINE_PATTERN.test(firstLine)) {
    return true;
  }
  return PROCESS_CONTENT_PATTERN.test(paragraph);
}

function isTrailingMetaParagraph(paragraph: string): boolean {
  const firstLine = paragraph.split("\n")[0]?.trim() ?? paragraph;
  if (TRAILING_LINE_PATTERN.test(firstLine)) {
    return true;
  }
  return TRAILING_CONTENT_PATTERN.test(paragraph);
}

function normalizeParagraphText(paragraph: string): string {
  return paragraph.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Убирает преамбулы («запрашиваю…») и хвосты («для краткой сводки…») из ответа агента.
 */
export function sanitizeAssistantResponseForChat(rawText: string): string {
  const trimmedRaw = rawText.trim();
  if (!trimmedRaw) {
    return "";
  }

  const paragraphs = splitIntoParagraphs(trimmedRaw);
  if (paragraphs.length === 0) {
    return trimmedRaw.replace(/\*\*/g, "");
  }

  const contentParagraphs = paragraphs.filter(
    (paragraph) => !isProcessParagraph(paragraph) && !isTrailingMetaParagraph(paragraph),
  );

  if (contentParagraphs.length === 0) {
    return trimmedRaw.replace(/\*\*/g, "");
  }

  const normalizedParagraphs = contentParagraphs.map(normalizeParagraphText);

  const overlapParagraphs = normalizedParagraphs.filter((paragraph) =>
    /пересеч/i.test(paragraph),
  );
  const closingParagraphs = normalizedParagraphs.filter((paragraph) =>
    /(?:других\s+совпадений|пересечений\s+нет|остальн\w+\s+дн)/i.test(paragraph),
  );

  if (overlapParagraphs.length > 0) {
    const mainParts = [...overlapParagraphs];
    for (const closingParagraph of closingParagraphs) {
      if (!mainParts.includes(closingParagraph)) {
        mainParts.push(closingParagraph);
      }
    }
    if (mainParts.length <= 2) {
      return mainParts.join(" ");
    }
  }

  if (normalizedParagraphs.length === 1) {
    return normalizedParagraphs[0];
  }

  return normalizedParagraphs.join("\n\n");
}

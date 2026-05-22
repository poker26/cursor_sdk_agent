const PROCESS_LINE_PATTERN =
  /^(?:запрашиваю|загружаю|проверяю|смотрю|уточняю|сейчас\b|перечитываю|обращаюсь)/i;

const PROCESS_CONTENT_PATTERN =
  /(?:подключённ\w*\s+exchange|через\s+(?:подключённ\w*\s+)?exchange|запрашиваю\s+календарь)/i;

const TRAILING_LINE_PATTERN =
  /^(?:для краткой сводки|уточнение по|если под|по календарю\s+[«"]|взята как|ниже\s+список|###\s)/i;

const TRAILING_CONTENT_PATTERN =
  /(?:для краткой сводки|взята как|пн[–-]вс\s+после|следующая\s+(?:календарная\s+)?неделя\s+взята|уточнение\s+по\s+охвату)/i;

const INLINE_META_TAIL_PATTERN =
  /\s[—–]\s*(?:по блоку|в выгрузке|из выгрузки|по списку|согласно|из файла|в файле|\/~\/\.cursor-agent|\.cursor-agent\/|confluence_pp|без строк|исключ\w*|руководитель направления).+$/i;

const SOURCE_META_PARAGRAPH_PATTERN =
  /(?:^|\s)(?:по блоку|в выгрузке|из выгрузки|взято из|источник:|согласно файлу)/i;

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
  if (TRAILING_CONTENT_PATTERN.test(paragraph)) {
    return true;
  }
  if (SOURCE_META_PARAGRAPH_PATTERN.test(paragraph) && !/@\w+\.\w+/.test(paragraph)) {
    return true;
  }
  return false;
}

function stripInlineMetaTail(paragraph: string): string {
  let cleaned = paragraph;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metaTailMatch = INLINE_META_TAIL_PATTERN.exec(cleaned);
    if (!metaTailMatch || metaTailMatch.index === undefined) {
      break;
    }
    cleaned = cleaned.slice(0, metaTailMatch.index).trim();
  }
  return cleaned;
}

function normalizeParagraphText(paragraph: string): string {
  const withoutBold = paragraph.replace(/\*\*/g, "").replace(/`/g, "");
  const withoutMetaTail = stripInlineMetaTail(withoutBold);
  return withoutMetaTail.replace(/\s+/g, " ").trim();
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

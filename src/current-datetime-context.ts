const DEFAULT_AGENT_TIMEZONE = "Europe/Moscow";

function resolveAgentTimezone(): string {
  const configuredTimezone = process.env.AGENT_TIMEZONE?.trim();
  return configuredTimezone || DEFAULT_AGENT_TIMEZONE;
}

function formatIsoDateInTimezone(referenceDate: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);

  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function formatCalendarWeekdayInTimezone(referenceDate: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    weekday: "long",
  }).format(referenceDate);
}

function formatCalendarDateInTimezone(referenceDate: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(referenceDate);
}

function formatClockTimeInTimezone(referenceDate: Date, timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(referenceDate);
}

/**
 * Якорь «сейчас» в каждом сообщении. Для «завтра / в понедельник» — MCP ru_calendar.
 */
export function buildCurrentDateTimeContextPrefix(): string {
  const timezone = resolveAgentTimezone();
  const now = new Date();
  const isoDate = formatIsoDateInTimezone(now, timezone);
  const weekdayLabel = formatCalendarWeekdayInTimezone(now, timezone);
  const dateLabel = formatCalendarDateInTimezone(now, timezone);
  const timeLabel = formatClockTimeInTimezone(now, timezone);

  return `[Текущие дата и время]
Часовой пояс: ${timezone}
Сейчас: ${weekdayLabel}, ${dateLabel}, ${timeLabel}
Календарная дата (ISO): ${isoDate}
Для «завтра», «в понедельник», «на этой неделе» — вызывай MCP ru_calendar (resolve_phrase / get_calendar_context), не считай даты сам.

---

`;
}

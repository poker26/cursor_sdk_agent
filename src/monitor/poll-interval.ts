const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FALLBACK_POLL_INTERVAL_MS = 30 * 60 * 1000;

export function getDefaultPollIntervalMs(): number {
  const fromEnv = Number.parseInt(
    process.env.MONITOR_POLL_INTERVAL_MS?.trim() ||
      process.env.MONITOR_POLL_MS?.trim() ||
      "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv >= MIN_POLL_INTERVAL_MS) {
    return clampPollIntervalMs(fromEnv);
  }
  return FALLBACK_POLL_INTERVAL_MS;
}

export function clampPollIntervalMs(intervalMs: number): number {
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, intervalMs));
}

/**
 * Parses a poll interval from natural Russian phrases in a chat message.
 * Returns undefined when no interval is mentioned (caller should use the default).
 */
export function parsePollIntervalMsFromText(text: string): number | undefined {
  const normalized = text.toLowerCase().replace(/ё/g, "е");

  if (
    /(раз в (сутки|день)|ежедневно|1 раз в сутки|каждые сутки|раз в 24\s*час)/.test(
      normalized,
    )
  ) {
    return clampPollIntervalMs(24 * 60 * 60 * 1000);
  }
  if (/раз в неделю/.test(normalized)) {
    return clampPollIntervalMs(7 * 24 * 60 * 60 * 1000);
  }
  if (/(каждый час|раз в час|ежечасно)/.test(normalized)) {
    return clampPollIntervalMs(60 * 60 * 1000);
  }
  if (/полчаса/.test(normalized)) {
    return clampPollIntervalMs(30 * 60 * 1000);
  }

  const hoursMatch = normalized.match(
    /(?:каждые|раз в)\s*(\d+)\s*(?:час(?:а|ов)?|ч\.?)\b/,
  );
  if (hoursMatch) {
    return clampPollIntervalMs(Number.parseInt(hoursMatch[1], 10) * 60 * 60 * 1000);
  }

  const minutesMatch = normalized.match(
    /(?:каждые|раз в)\s*(\d+)\s*(?:минут(?:ы)?|мин\.?)\b/,
  );
  if (minutesMatch) {
    return clampPollIntervalMs(Number.parseInt(minutesMatch[1], 10) * 60 * 1000);
  }

  const bareMinutesMatch = normalized.match(/\b(\d+)\s*(?:минут(?:ы)?|мин\.?)\b/);
  if (bareMinutesMatch && /(интервал|частот|монитор|провер)/.test(normalized)) {
    return clampPollIntervalMs(Number.parseInt(bareMinutesMatch[1], 10) * 60 * 1000);
  }

  return undefined;
}

export function formatPollIntervalLabel(intervalMs: number): string {
  const clampedMs = clampPollIntervalMs(intervalMs);
  if (clampedMs >= 24 * 60 * 60 * 1000) {
    const days = Math.round(clampedMs / (24 * 60 * 60 * 1000));
    if (days === 1) {
      return "раз в сутки";
    }
    return `раз в ${days} суток`;
  }
  if (clampedMs >= 60 * 60 * 1000) {
    const hours = Math.round(clampedMs / (60 * 60 * 1000));
    if (hours === 1) {
      return "раз в час";
    }
    return `раз в ${hours} ч`;
  }
  const minutes = Math.round(clampedMs / (60 * 1000));
  return `раз в ${minutes} мин`;
}

export function resolveEpicPollIntervalMs(
  epicRow: { poll_interval_ms?: number | null },
  fallbackMs?: number,
): number {
  const stored = epicRow.poll_interval_ms;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= MIN_POLL_INTERVAL_MS) {
    return clampPollIntervalMs(stored);
  }
  return fallbackMs ?? getDefaultPollIntervalMs();
}

export function isEpicDueForPoll(
  epicRow: { last_checked_at: string | null; poll_interval_ms?: number | null },
  nowMs = Date.now(),
): boolean {
  if (!epicRow.last_checked_at) {
    return true;
  }
  const lastCheckedMs = new Date(epicRow.last_checked_at).getTime();
  if (!Number.isFinite(lastCheckedMs)) {
    return true;
  }
  const intervalMs = resolveEpicPollIntervalMs(epicRow);
  return nowMs - lastCheckedMs >= intervalMs;
}

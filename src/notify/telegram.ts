const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 4000;

export function getTelegramBotToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

export function getDefaultTelegramChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID?.trim() || undefined;
}

export function isTelegramConfigured(): boolean {
  return Boolean(getTelegramBotToken() && getDefaultTelegramChatId());
}

function truncateForTelegram(messageText: string): string {
  if (messageText.length <= TELEGRAM_MESSAGE_LIMIT) {
    return messageText;
  }
  return `${messageText.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`;
}

/**
 * Sends an HTML message via the Telegram Bot API.
 * Resolves the chat id from the argument, falling back to TELEGRAM_CHAT_ID.
 */
export async function sendTelegramMessage(
  messageHtml: string,
  chatId?: string,
): Promise<void> {
  const botToken = getTelegramBotToken();
  const targetChatId = chatId?.trim() || getDefaultTelegramChatId();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN не задан.");
  }
  if (!targetChatId) {
    throw new Error("Не задан Telegram chat id (TELEGRAM_CHAT_ID).");
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: targetChatId,
      text: truncateForTelegram(messageHtml),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram sendMessage ${response.status}: ${errorBody.slice(0, 300)}`);
  }
}

export function escapeTelegramHtml(rawText: string): string {
  return rawText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

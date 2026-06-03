import fs from "node:fs/promises";
import path from "node:path";

const MEMORY_DIRECTORY_NAME = ".cursor-agent";
const MEMORY_FILE_NAME = "memory.md";

export const MEMORY_BOOTSTRAP_TEMPLATE = `## Стартовый контекст

### Роль и зона ответственности
- Руководитель направления **платежей / платежной платформы** в финтех-компании (разработка + эксплуатация продуктов).
- Платежи: **физлицо → юрлицо / госорган** (e-commerce, телеком, штрафы, налоги и т.д.).
- **Переводы (remittance), физлицо → физлицо** — отдельное подразделение; не смешивать без явной связи.

### Обязанности (что помнить между чатами)
- Ход разработки (Jira, GitLab).
- Бизнес-цикл: переговоры → запуск платёжного шлюза → эксплуатация → расчёты и сверки.

### Маппинг систем (ключи для MCP и ingest)
| Система | Ключ / пространство | Назначение |
|---------|---------------------|------------|
| Confluence | **PaymentPlatform** (ключ space часто **PP**) | Основное: концепты, требования, архитектура |
| Confluence | личное пространство (черновики) | Документы до публикации в общее пространство |
| Jira | **PP** | Задачи направления платежей |
| Jira | **FF** | Общие бизнес-задачи компании (в т.ч. подразделения) |
| GitLab | группа **payplatform** («Платежная платформа»), path payplatform/…; архитектура: arch/payment-platform | Код (+ GitLab MCP) |

### Источники правды
- Код: GitLab (+ GitLab MCP).
- Задачи: Jira PP и FF (+ Atlassian MCP).
- Архитектура: Confluence PaymentPlatform (+ Atlassian MCP).
- Почта: Exchange (+ Exchange MCP).
- Заметки: Notion (+ MCP notion, NOTION_TOKEN на gateway).

### Стиль ответов в веб-чате cursor_sdk_agent
- Только ответ на вопрос: без процесса, без «по блоку/в выгрузке», без объяснения кого не включили.
- Списки — только пункты/адреса; пересечения — да/нет + где.

### Текущий фокус
(обновляется после сессий: партнёр / шлюз / релиз / интеграция / эпик)

### Хронология сессий
`;

export function resolveMemoryFilePath(workspacePath: string): string {
  return path.join(workspacePath, MEMORY_DIRECTORY_NAME, MEMORY_FILE_NAME);
}

export function isMemoryEnabled(): boolean {
  const rawValue = process.env.MEMORY_ENABLED?.trim().toLowerCase();
  if (!rawValue) {
    return true;
  }
  return rawValue !== "false" && rawValue !== "0";
}

export function getMemoryMaxChars(): number {
  const parsed = Number.parseInt(process.env.MEMORY_MAX_CHARS || "32000", 10);
  return Number.isFinite(parsed) && parsed > 1000 ? parsed : 32000;
}

export async function ensureMemoryFileExists(workspacePath: string): Promise<string> {
  const memoryFilePath = resolveMemoryFilePath(workspacePath);
  const memoryDirectory = path.dirname(memoryFilePath);
  await fs.mkdir(memoryDirectory, { recursive: true });
  try {
    await fs.access(memoryFilePath);
  } catch {
    await fs.writeFile(memoryFilePath, `${MEMORY_BOOTSTRAP_TEMPLATE}\n`, "utf8");
  }
  return memoryFilePath;
}

export async function readMemoryFile(workspacePath: string): Promise<string> {
  if (!isMemoryEnabled()) {
    return "";
  }
  const memoryFilePath = await ensureMemoryFileExists(workspacePath);
  try {
    const rawContent = await fs.readFile(memoryFilePath, "utf8");
    return trimMemoryContent(rawContent, getMemoryMaxChars());
  } catch {
    return "";
  }
}

function trimMemoryContent(rawContent: string, maxChars: number): string {
  const trimmed = rawContent.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const truncatedNotice = "\n\n[... память обрезана по MEMORY_MAX_CHARS ...]\n\n";
  const tailLength = maxChars - truncatedNotice.length - 200;
  const head = trimmed.slice(0, 200);
  const tail = trimmed.slice(-Math.max(tailLength, 0));
  return `${head}${truncatedNotice}${tail}`;
}

export async function appendMemorySessionLog(
  workspacePath: string,
  userSummary: string,
  assistantSummary: string,
): Promise<void> {
  if (!isMemoryEnabled()) {
    return;
  }
  const memoryFilePath = await ensureMemoryFileExists(workspacePath);
  const timestamp = new Date().toISOString();
  const sessionBlock = [
    "",
    `## ${timestamp}`,
    "",
    "**Пользователь:**",
    userSummary.trim() || "(без текста)",
    "",
    "**Агент:**",
    assistantSummary.trim() || "(без ответа)",
    "",
  ].join("\n");

  let existingContent = "";
  try {
    existingContent = await fs.readFile(memoryFilePath, "utf8");
  } catch {
    existingContent = MEMORY_BOOTSTRAP_TEMPLATE;
  }

  let combined = `${existingContent.trimEnd()}${sessionBlock}`;
  const maxChars = getMemoryMaxChars();
  if (combined.length > maxChars) {
    combined = trimMemoryContent(combined, maxChars);
  }
  await fs.writeFile(memoryFilePath, `${combined}\n`, "utf8");
}

export async function clearMemoryFile(workspacePath: string): Promise<void> {
  const memoryFilePath = resolveMemoryFilePath(workspacePath);
  try {
    await fs.unlink(memoryFilePath);
  } catch {
    /* already absent */
  }
  await ensureMemoryFileExists(workspacePath);
}

export function buildMemoryPromptPrefix(memoryContent: string): string {
  if (!memoryContent.trim()) {
    return "";
  }
  return `[Контекст памяти workspace — memory.md]\n\n${memoryContent.trim()}\n\n---\n\n`;
}

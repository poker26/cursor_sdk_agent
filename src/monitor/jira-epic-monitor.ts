import { callMcpTool, loadMcpHttpServersFromEnv } from "../brain/mcp-http.js";
import { isSupabaseBrainEnabled } from "../brain/config.js";
import {
  escapeTelegramHtml,
  getDefaultTelegramChatId,
  isTelegramConfigured,
  sendTelegramMessage,
} from "../notify/telegram.js";
import {
  deleteIssueStates,
  deleteMonitoredEpic,
  listActiveMonitoredEpics,
  listMonitoredEpicsForWorkspace,
  loadIssueStateMap,
  replaceIssueStates,
  touchEpicChecked,
  upsertIssueStates,
  upsertMonitoredEpic,
  type MonitoredEpicRow,
  type MonitoredIssueState,
} from "./monitoring-store.js";

const JIRA_KEY_PATTERN = /\b([A-Za-z][A-Za-z0-9]+-\d+)\b/;
const JIRA_URL_PATTERN = /https?:\/\/[^\s/]+(?:\/[^\s]*)?/i;
const DEFAULT_JIRA_BASE_URL = "https://jira.inplatlabs.ru";
const MAX_CHANGE_LINES_PER_MESSAGE = 40;

export type MonitoringCommandAction = "register" | "unregister" | "list";

export interface MonitoringCommand {
  action: MonitoringCommandAction;
  epicKey?: string;
  jiraBaseUrl?: string;
}

interface NormalizedIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  resolution: string;
}

export function isMonitoringEnabled(): boolean {
  return (
    isSupabaseBrainEnabled() &&
    isTelegramConfigured() &&
    Boolean(loadMcpHttpServersFromEnv().atlassian)
  );
}

export function getJiraBaseUrl(): string {
  return process.env.JIRA_BASE_URL?.trim() || DEFAULT_JIRA_BASE_URL;
}

function coerceFieldString(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
  }
  if (typeof rawValue === "object") {
    const record = rawValue as Record<string, unknown>;
    const candidate = record.name ?? record.displayName ?? record.value;
    return candidate ? coerceFieldString(candidate) : "";
  }
  return String(rawValue);
}

function normalizeIssue(raw: Record<string, unknown>): NormalizedIssue {
  const fields = (raw.fields as Record<string, unknown> | undefined) ?? {};
  const key = coerceFieldString(raw.key ?? raw.issue_key ?? raw.id);
  const summary = coerceFieldString(raw.summary ?? fields.summary);
  const status = coerceFieldString(raw.status ?? raw.status_name ?? fields.status);
  const assignee = coerceFieldString(raw.assignee ?? fields.assignee);
  const resolution = coerceFieldString(raw.resolution ?? fields.resolution);
  return { key, summary, status, assignee, resolution };
}

function extractIssuesFromMcpResult(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    for (const collectionKey of ["issues", "items", "results"]) {
      const collection = record[collectionKey];
      if (Array.isArray(collection)) {
        return collection as Array<Record<string, unknown>>;
      }
    }
  }
  return [];
}

async function fetchEpicIssue(epicKey: string): Promise<NormalizedIssue> {
  const raw = await callMcpTool("atlassian", "jira_get_issue", { issue_key: epicKey });
  if (!raw || typeof raw !== "object") {
    throw new Error(`Jira не вернула задачу ${epicKey}.`);
  }
  const normalized = normalizeIssue(raw as Record<string, unknown>);
  if (!normalized.key) {
    throw new Error(`Не удалось распознать задачу ${epicKey} в ответе Jira.`);
  }
  return normalized;
}

async function fetchEpicChildren(epicKey: string): Promise<NormalizedIssue[]> {
  const jqlVariants = [
    `"Epic Link" = ${epicKey} ORDER BY key ASC`,
    `parent = ${epicKey} ORDER BY key ASC`,
  ];
  for (const jql of jqlVariants) {
    try {
      const result = await callMcpTool("atlassian", "jira_search", {
        jql,
        max_results: 100,
        preset: "full",
        fields: "summary,status,assignee,resolution",
      });
      const issues = extractIssuesFromMcpResult(result)
        .map(normalizeIssue)
        .filter((issue) => issue.key && issue.key !== epicKey);
      if (issues.length > 0) {
        return issues;
      }
    } catch {
      // Try the next JQL variant (e.g. "Epic Link" field may be absent on next-gen projects).
    }
  }
  return [];
}

function toIssueState(issue: NormalizedIssue, isEpic: boolean): MonitoredIssueState {
  return {
    issueKey: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    resolution: issue.resolution,
    isEpic,
  };
}

async function fetchEpicSnapshot(epicKey: string): Promise<{
  epic: NormalizedIssue;
  trackedIssues: MonitoredIssueState[];
}> {
  const epic = await fetchEpicIssue(epicKey);
  const children = await fetchEpicChildren(epicKey);
  const trackedIssues = [
    toIssueState(epic, true),
    ...children.map((child) => toIssueState(child, false)),
  ];
  return { epic, trackedIssues };
}

export function parseEpicKey(text: string): string | undefined {
  const match = text.match(JIRA_KEY_PATTERN);
  return match ? match[1].toUpperCase() : undefined;
}

function parseJiraBaseUrl(text: string): string | undefined {
  const match = text.match(JIRA_URL_PATTERN);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = new URL(match[0]);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Recognizes natural-language monitoring commands in a chat message.
 * Returns null when the message is not a monitoring command.
 */
export function parseMonitoringCommand(text: string): MonitoringCommand | null {
  const normalized = text.toLowerCase();
  if (!/монитор/.test(normalized)) {
    return null;
  }

  const epicKey = parseEpicKey(text);
  const jiraBaseUrl = parseJiraBaseUrl(text);

  const isRemoval = /(сним|убер|останов|стоп|отключ|удал|прекрат)/.test(normalized);
  if (isRemoval && epicKey) {
    return { action: "unregister", epicKey, jiraBaseUrl };
  }

  const isListing = /(список|покаж|какие|что.*монитор|перечисл)/.test(normalized);
  if (isListing && !epicKey) {
    return { action: "list" };
  }

  if (epicKey) {
    return { action: "register", epicKey, jiraBaseUrl };
  }

  if (isListing) {
    return { action: "list" };
  }

  return null;
}

function issueBrowseUrl(jiraBaseUrl: string, issueKey: string): string {
  return `${jiraBaseUrl.replace(/\/$/, "")}/browse/${issueKey}`;
}

export async function registerEpicMonitoring(
  workspaceId: string,
  epicKey: string,
  jiraBaseUrl: string,
): Promise<{ epicSummary: string; childCount: number }> {
  const { epic, trackedIssues } = await fetchEpicSnapshot(epicKey);
  const childCount = trackedIssues.length - 1;

  await upsertMonitoredEpic({
    workspaceId,
    epicKey,
    epicSummary: epic.summary,
    jiraBaseUrl,
    telegramChatId: getDefaultTelegramChatId() ?? null,
  });
  await replaceIssueStates(workspaceId, epicKey, trackedIssues);

  const confirmationHtml = [
    `✅ <b>${escapeTelegramHtml(epicKey)}</b> поставлен на мониторинг`,
    epic.summary ? escapeTelegramHtml(epic.summary) : "",
    `Задач в эпике: <b>${childCount}</b>. Сообщу об изменениях статусов, новых задачах, смене исполнителя/резолюции.`,
    `<a href="${issueBrowseUrl(jiraBaseUrl, epicKey)}">${issueBrowseUrl(jiraBaseUrl, epicKey)}</a>`,
  ]
    .filter(Boolean)
    .join("\n");
  await sendTelegramMessage(confirmationHtml);

  return { epicSummary: epic.summary, childCount };
}

export async function unregisterEpicMonitoring(
  workspaceId: string,
  epicKey: string,
): Promise<boolean> {
  return deleteMonitoredEpic(workspaceId, epicKey);
}

export async function listEpicMonitoring(
  workspaceId: string,
): Promise<MonitoredEpicRow[]> {
  return listMonitoredEpicsForWorkspace(workspaceId);
}

interface IssueChange {
  kind: "new" | "status" | "assignee" | "resolution" | "removed";
  issueKey: string;
  summary: string;
  isEpic: boolean;
  from?: string;
  to?: string;
}

function diffEpicState(
  storedStates: Map<string, MonitoredIssueState>,
  currentIssues: MonitoredIssueState[],
): IssueChange[] {
  const changes: IssueChange[] = [];
  const currentKeys = new Set<string>();

  for (const current of currentIssues) {
    currentKeys.add(current.issueKey);
    const previous = storedStates.get(current.issueKey);
    if (!previous) {
      if (!current.isEpic) {
        changes.push({
          kind: "new",
          issueKey: current.issueKey,
          summary: current.summary,
          isEpic: current.isEpic,
          to: current.status,
        });
      }
      continue;
    }
    if (previous.status !== current.status) {
      changes.push({
        kind: "status",
        issueKey: current.issueKey,
        summary: current.summary,
        isEpic: current.isEpic,
        from: previous.status,
        to: current.status,
      });
    }
    if (previous.assignee !== current.assignee) {
      changes.push({
        kind: "assignee",
        issueKey: current.issueKey,
        summary: current.summary,
        isEpic: current.isEpic,
        from: previous.assignee,
        to: current.assignee,
      });
    }
    if (previous.resolution !== current.resolution) {
      changes.push({
        kind: "resolution",
        issueKey: current.issueKey,
        summary: current.summary,
        isEpic: current.isEpic,
        from: previous.resolution,
        to: current.resolution,
      });
    }
  }

  for (const [issueKey, previous] of storedStates) {
    if (!currentKeys.has(issueKey) && !previous.isEpic) {
      changes.push({
        kind: "removed",
        issueKey,
        summary: previous.summary,
        isEpic: previous.isEpic,
        from: previous.status,
      });
    }
  }

  return changes;
}

function describeChange(change: IssueChange): string {
  const emptyLabel = "—";
  switch (change.kind) {
    case "new":
      return `🆕 новая задача · <b>${change.to || emptyLabel}</b>`;
    case "status":
      return `▶ статус: ${change.from || emptyLabel} → <b>${change.to || emptyLabel}</b>`;
    case "assignee":
      return `👤 исполнитель: ${change.from || emptyLabel} → <b>${change.to || emptyLabel}</b>`;
    case "resolution":
      return `🏁 резолюция: ${change.from || emptyLabel} → <b>${change.to || emptyLabel}</b>`;
    case "removed":
      return `❌ удалена из эпика (была: ${change.from || emptyLabel})`;
    default:
      return "изменение";
  }
}

function buildChangeMessage(
  epicRow: MonitoredEpicRow,
  changes: IssueChange[],
): string {
  const jiraBaseUrl = epicRow.jira_base_url ?? getJiraBaseUrl();
  const headerSummary = epicRow.epic_summary ? ` — ${escapeTelegramHtml(epicRow.epic_summary)}` : "";
  const lines: string[] = [
    `🔔 <b>Мониторинг ${escapeTelegramHtml(epicRow.epic_key)}</b>${headerSummary}`,
    "",
  ];

  const visibleChanges = changes.slice(0, MAX_CHANGE_LINES_PER_MESSAGE);
  for (const change of visibleChanges) {
    const label = change.isEpic ? `${change.issueKey} (эпик)` : change.issueKey;
    const summaryText = change.summary ? ` ${escapeTelegramHtml(change.summary)}` : "";
    const link = issueBrowseUrl(jiraBaseUrl, change.issueKey);
    lines.push(`<a href="${link}">${escapeTelegramHtml(label)}</a>${summaryText}`);
    lines.push(`   ${describeChange(change)}`);
  }

  if (changes.length > visibleChanges.length) {
    lines.push("");
    lines.push(`…и ещё изменений: ${changes.length - visibleChanges.length}`);
  }

  return lines.join("\n");
}

async function pollSingleEpic(epicRow: MonitoredEpicRow): Promise<number> {
  const { epic, trackedIssues } = await fetchEpicSnapshot(epicRow.epic_key);
  const storedStates = await loadIssueStateMap(epicRow.workspace_id, epicRow.epic_key);

  if (storedStates.size === 0) {
    await replaceIssueStates(epicRow.workspace_id, epicRow.epic_key, trackedIssues);
    await touchEpicChecked(epicRow.workspace_id, epicRow.epic_key, epic.summary);
    return 0;
  }

  const changes = diffEpicState(storedStates, trackedIssues);

  if (changes.length > 0) {
    const messageHtml = buildChangeMessage(
      { ...epicRow, epic_summary: epic.summary || epicRow.epic_summary },
      changes,
    );
    await sendTelegramMessage(messageHtml, epicRow.telegram_chat_id ?? undefined);
  }

  await upsertIssueStates(epicRow.workspace_id, epicRow.epic_key, trackedIssues);
  const removedKeys = changes
    .filter((change) => change.kind === "removed")
    .map((change) => change.issueKey);
  await deleteIssueStates(epicRow.workspace_id, epicRow.epic_key, removedKeys);
  await touchEpicChecked(epicRow.workspace_id, epicRow.epic_key, epic.summary);

  return changes.length;
}

/**
 * Polls every active monitored epic once, sending Telegram notifications for changes.
 * Returns a per-epic summary; never throws (errors are collected per epic).
 */
export async function pollAllActiveEpics(): Promise<
  Array<{ epicKey: string; changes: number; error?: string }>
> {
  const activeEpics = await listActiveMonitoredEpics();
  const results: Array<{ epicKey: string; changes: number; error?: string }> = [];
  for (const epicRow of activeEpics) {
    try {
      const changeCount = await pollSingleEpic(epicRow);
      results.push({ epicKey: epicRow.epic_key, changes: changeCount });
    } catch (error) {
      results.push({
        epicKey: epicRow.epic_key,
        changes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

import type { ConversationTurn, Run, RunResult } from "@cursor/sdk";
import type { SDKMessage, SDKToolUseMessage } from "@cursor/sdk";

const MAX_DIAGNOSTIC_EVENTS = 24;
const MAX_SNIPPET_CHARS = 900;

export interface RunDiagnosticEvent {
  kind: string;
  summary: string;
}

export class RunDiagnosticsCollector {
  private readonly diagnosticEvents: RunDiagnosticEvent[] = [];
  private readonly recentCompletedToolNames: string[] = [];

  observeStreamMessage(streamMessage: SDKMessage): void {
    try {
      this.observeStreamMessageCore(streamMessage);
    } catch {
      /* не прерываем run из-за диагностики */
    }
  }

  private observeStreamMessageCore(streamMessage: SDKMessage): void {
    if (streamMessage.type === "status") {
      const statusValue = streamMessage.status;
      if (
        statusValue === "ERROR" ||
        statusValue === "CANCELLED" ||
        statusValue === "EXPIRED"
      ) {
        this.pushDiagnosticEvent(
          "status",
          `${statusValue}${streamMessage.message ? `: ${streamMessage.message}` : ""}`,
        );
      }
      return;
    }

    if (streamMessage.type === "tool_call") {
      const toolMessage = streamMessage as SDKToolUseMessage;
      if (toolMessage.status === "error") {
        this.pushDiagnosticEvent(
          "tool_error",
          formatToolCallDiagnosticLine(toolMessage),
        );
        return;
      }
      if (toolMessage.status === "completed") {
        this.recentCompletedToolNames.push(toolMessage.name);
        if (this.recentCompletedToolNames.length > 10) {
          this.recentCompletedToolNames.shift();
        }
      }
      return;
    }

    if (streamMessage.type === "task") {
      const taskStatusNormalized = streamMessage.status?.trim().toLowerCase() ?? "";
      const taskText = streamMessage.text?.trim();
      const taskLooksLikeFailure =
        taskStatusNormalized.length > 0 &&
        (taskStatusNormalized.includes("error") ||
          taskStatusNormalized.includes("fail") ||
          taskStatusNormalized.includes("cancel"));
      if (taskLooksLikeFailure) {
        this.pushDiagnosticEvent(
          "task",
          [streamMessage.status, taskText].filter(Boolean).join(": "),
        );
      }
    }
  }

  getRecentCompletedToolNames(): string[] {
    return [...this.recentCompletedToolNames];
  }

  getDiagnosticEvents(): RunDiagnosticEvent[] {
    return [...this.diagnosticEvents];
  }

  observeExternalError(errorMessage: string): void {
    this.pushDiagnosticEvent("stream_error", errorMessage);
  }

  formatCollectedDiagnostics(): string | undefined {
    if (this.diagnosticEvents.length === 0) {
      return undefined;
    }
    const lines = this.diagnosticEvents.map(
      (event, index) => `${index + 1}. [${event.kind}] ${event.summary}`,
    );
    if (this.recentCompletedToolNames.length > 0) {
      lines.push(
        `Последние успешные инструменты: ${this.recentCompletedToolNames.join(" → ")}`,
      );
    }
    return lines.join("\n");
  }

  private pushDiagnosticEvent(kind: string, summary: string): void {
    const trimmedSummary = truncateDiagnosticText(summary.trim());
    if (!trimmedSummary) {
      return;
    }
    this.diagnosticEvents.push({ kind, summary: trimmedSummary });
    if (this.diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
      this.diagnosticEvents.shift();
    }
  }
}

export async function resolveRunErrorDetailText(
  agentRun: Run,
  terminalResult: RunResult,
  diagnosticsCollector: RunDiagnosticsCollector,
): Promise<string> {
  try {
    const primaryCandidates = [terminalResult.result, agentRun.result];
    for (const candidate of primaryCandidates) {
      const trimmed = candidate?.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    const fromConversation = await tryExtractErrorDetailFromConversation(agentRun);
    if (fromConversation) {
      return fromConversation;
    }

    const fromStreamDiagnostics = diagnosticsCollector.formatCollectedDiagnostics();
    if (fromStreamDiagnostics) {
      const emptyResultHint = buildEmptySdkResultHint(terminalResult, agentRun);
      return [emptyResultHint, fromStreamDiagnostics].join("\n");
    }

    const durationHint =
      terminalResult.durationMs !== undefined
        ? `Длительность run: ${terminalResult.durationMs} мс.`
        : undefined;
    const modelHint = terminalResult.model?.id
      ? `Модель: ${terminalResult.model.id}.`
      : undefined;

    return [
      "Run завершился со статусом error, но Cursor SDK не передал result и в потоке нет явной ошибки инструмента.",
      "Частые причины: сбой локального агента, таймаут, обрыв MCP, нехватка памяти на VDS.",
      durationHint,
      modelHint,
      `runId: ${terminalResult.id || agentRun.id}`,
    ]
      .filter((line): line is string => Boolean(line?.trim()))
      .join("\n");
  } catch (diagnosticsError) {
    const diagnosticsMessage =
      diagnosticsError instanceof Error
        ? diagnosticsError.message
        : String(diagnosticsError);
    return [
      terminalResult.result?.trim(),
      agentRun.result?.trim(),
      `runId: ${terminalResult.id || agentRun.id}`,
      `Не удалось собрать диагностику: ${diagnosticsMessage}`,
    ]
      .filter((line): line is string => Boolean(line?.trim()))
      .join("\n");
  }
}

async function tryExtractErrorDetailFromConversation(
  agentRun: Run,
): Promise<string | undefined> {
  if (!agentRun.supports("conversation")) {
    return undefined;
  }
  try {
    const conversationTurns = await agentRun.conversation();
    return extractErrorDetailFromConversationTurns(conversationTurns);
  } catch {
    return undefined;
  }
}

function extractErrorDetailFromConversationTurns(
  conversationTurns: ConversationTurn[],
): string | undefined {
  for (let turnIndex = conversationTurns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turnRecord = conversationTurns[turnIndex] as Record<string, unknown>;
    if (turnRecord.type !== "agentConversationTurn") {
      continue;
    }
    const steps = turnRecord.steps;
    if (!Array.isArray(steps)) {
      continue;
    }
    for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const stepRecord = steps[stepIndex] as Record<string, unknown>;
      if (stepRecord.type !== "toolCall") {
        continue;
      }
      const toolMessage = stepRecord.message as Record<string, unknown> | undefined;
      if (!toolMessage) {
        continue;
      }
      const toolResult = toolMessage.result as Record<string, unknown> | undefined;
      if (toolResult?.status !== "error") {
        continue;
      }
      return formatConversationToolError(toolMessage, toolResult);
    }
  }
  return undefined;
}

function formatConversationToolError(
  toolMessage: Record<string, unknown>,
  toolResult: Record<string, unknown>,
): string {
  const toolType = String(toolMessage.type ?? "tool");
  const argsRecord = toolMessage.args as Record<string, unknown> | undefined;
  const lines = [`Инструмент «${toolType}» завершился с ошибкой.`];

  if (toolType === "shell" && typeof argsRecord?.command === "string") {
    lines.push(`Команда: ${truncateDiagnosticText(argsRecord.command, 300)}`);
  }
  if (typeof argsRecord?.path === "string") {
    lines.push(`Путь: ${argsRecord.path}`);
  }

  const errorPayload = toolResult.error;
  if (errorPayload !== undefined) {
    lines.push(`Детали: ${stringifyUnknownValue(errorPayload)}`);
  }

  const successValue = toolResult.value as Record<string, unknown> | undefined;
  if (successValue) {
    if (typeof successValue.stderr === "string" && successValue.stderr.trim()) {
      lines.push(`stderr: ${truncateDiagnosticText(successValue.stderr, 400)}`);
    }
    if (typeof successValue.exitCode === "number") {
      lines.push(`exitCode: ${successValue.exitCode}`);
    }
  }

  return lines.join("\n");
}

function formatToolCallDiagnosticLine(toolMessage: SDKToolUseMessage): string {
  const parts = [`${toolMessage.name} (tool_call error)`];
  if (toolMessage.result !== undefined) {
    parts.push(stringifyUnknownValue(toolMessage.result));
  }
  if (toolMessage.args !== undefined) {
    parts.push(`args: ${stringifyUnknownValue(toolMessage.args, 400)}`);
  }
  return parts.join(" — ");
}

function stringifyUnknownValue(value: unknown, maxLength = MAX_SNIPPET_CHARS): string {
  if (typeof value === "string") {
    return truncateDiagnosticText(value, maxLength);
  }
  try {
    return truncateDiagnosticText(JSON.stringify(value, null, 2), maxLength);
  } catch {
    return truncateDiagnosticText(String(value), maxLength);
  }
}

function truncateDiagnosticText(text: string, maxLength = MAX_SNIPPET_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

function buildEmptySdkResultHint(
  terminalResult: RunResult,
  agentRun: Run,
): string {
  const runIdentifier = terminalResult.id || agentRun.id;
  const diagnosticEvents = [
    "Cursor SDK завершил run со статусом error, но не передал текст result.",
    `runId: ${runIdentifier}`,
    "Что проверить:",
    "1. Нажмите «Сбросить агента» — часто помогает после смены MCP или долгого простоя.",
    "2. Проверьте MCP (historical-recipes, ru_calendar): доступность /mcp и API-ключ.",
    "3. Если ошибка повторяется — «WritableIterable is closed» означает обрыв потока SDK (перезагрузка вкладки, таймаут nginx, сбой MCP).",
  ];
  if (terminalResult.durationMs !== undefined) {
    diagnosticEvents.push(`Длительность run: ${terminalResult.durationMs} мс.`);
  }
  if (terminalResult.model?.id) {
    diagnosticEvents.push(`Модель: ${terminalResult.model.id}.`);
  }
  return diagnosticEvents.join("\n");
}

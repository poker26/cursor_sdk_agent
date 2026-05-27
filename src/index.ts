import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  AgentBusyError,
  AuthenticationError,
  convertError,
  CursorAgentError,
  type McpServerConfig,
  type Run,
  type SDKAgent,
  type SDKAssistantMessage,
  type SDKImage,
  type SDKMessage,
  type SDKToolUseMessage,
  type SDKUserMessage,
} from "@cursor/sdk";
import { buildBrainContextPrefix } from "./brain/context-builder.js";
import {
  getEmbeddingProviderLabel,
  isEmbeddingEnabled,
  isQdrantBrainEnabled,
  isSupabaseBrainEnabled,
} from "./brain/config.js";
import { persistBrainAfterRun } from "./brain/post-run.js";
import { clearWorkspaceBrain } from "./brain/supabase-brain.js";
import { deleteQdrantCollection } from "./brain/qdrant-brain.js";
import { clearMemoryFile } from "./memory.js";
import {
  getDefaultAgentModelId,
  InvalidAgentModelIdError,
  listAgentModelOptions,
  resolveRequestedAgentModelId,
} from "./agent-model.js";
import {
  clearPersistedAgentId,
  loadPersistedAgentId,
  loadPersistedModelId,
  savePersistedAgentId,
} from "./workspace-state.js";
import {
  loadWorkspaceRegistryFromEnv,
  type WorkspaceEntry,
} from "./workspace-registry.js";
import {
  getVpnHealthPollIntervalMs,
  getVpnHealthUrl,
  probeVpnHealth,
} from "./vpn-health.js";
import { getVoicePublicConfig } from "./voice/config.js";
import { registerVoiceRoutes } from "./voice/routes.js";
import { registerVoiceTurnRoute } from "./voice/voice-turn.js";
import {
  buildChatResponseStylePrefix,
  buildChatResponseStyleSuffix,
  parseChatResponseMode,
  type ChatResponseMode,
} from "./chat-response-style.js";
import { sanitizeAssistantResponseForChat } from "./assistant-response-sanitize.js";
import { buildCurrentDateTimeContextPrefix } from "./current-datetime-context.js";
import {
  RunDiagnosticsCollector,
  resolveRunErrorDetailText,
} from "./run-diagnostics.js";

const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
const publicDirPath = path.join(currentDirPath, "..", "public");

const SESSION_IDLE_DISPOSE_MS = Number.parseInt(
  process.env.SESSION_IDLE_DISPOSE_MS || String(30 * 60 * 1000),
  10,
);

const UPLOAD_MAX_BYTES = Number.parseInt(
  process.env.UPLOAD_MAX_BYTES || String(3 * 1024 * 1024),
  10,
);

const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT?.trim() || "8mb";

interface ClientAttachmentPayload {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

interface WorkspaceAgentRecord {
  agent: SDKAgent;
  workspaceId: string;
  modelId: string;
  busy: boolean;
  lastActivityAt: number;
  idleDisposeTimer: ReturnType<typeof setTimeout> | undefined;
}

interface SessionLockRecord {
  busy: boolean;
  workspaceId: string;
}

const workspaceRegistry = loadWorkspaceRegistryFromEnv();
const defaultWorkspaceId = workspaceRegistry[0].id;

const application = express();
application.disable("x-powered-by");
application.use((_request, response, next) => {
  response.setHeader("Permissions-Policy", "microphone=(self)");
  next();
});
application.use(express.json({ limit: JSON_BODY_LIMIT }));

const basicAuthUser = process.env.CHAT_BASIC_USER?.trim();
const basicAuthPassword = process.env.CHAT_BASIC_PASSWORD?.trim();

const workspaceAgents = new Map<string, WorkspaceAgentRecord>();
const sessionLocks = new Map<string, SessionLockRecord>();

function sendUnauthorizedResponse(response: express.Response): void {
  response.setHeader("WWW-Authenticate", 'Basic realm="cursor-chat"');
  response.status(401).send("Authentication required");
}

function optionalBasicAuthMiddleware(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!basicAuthUser || !basicAuthPassword) {
    next();
    return;
  }
  const headerValue = request.get("authorization");
  if (!headerValue?.startsWith("Basic ")) {
    sendUnauthorizedResponse(response);
    return;
  }
  const decodedCredentials = Buffer.from(headerValue.slice(6), "base64").toString("utf8");
  const separatorIndex = decodedCredentials.indexOf(":");
  const providedUser =
    separatorIndex === -1 ? decodedCredentials : decodedCredentials.slice(0, separatorIndex);
  const providedPassword =
    separatorIndex === -1 ? "" : decodedCredentials.slice(separatorIndex + 1);
  if (providedUser !== basicAuthUser || providedPassword !== basicAuthPassword) {
    sendUnauthorizedResponse(response);
    return;
  }
  next();
}

function logServerMessage(message: string): void {
  const timestamp = new Date().toISOString();
  console.error(`[cursor-sdk-chat ${timestamp}] ${message}`);
}

function isAuthenticationFailure(error: unknown): boolean {
  if (error instanceof AuthenticationError) {
    return true;
  }
  const convertedError = convertError(error);
  if (convertedError instanceof AuthenticationError) {
    return true;
  }
  if (error instanceof Error && /unauthenticated/i.test(error.message)) {
    return true;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const errorCode = String((error as { code?: unknown }).code);
    if (errorCode === "unauthenticated" || errorCode === "16") {
      return true;
    }
  }
  return false;
}

function isAgentBusyFailure(error: unknown): boolean {
  if (error instanceof AgentBusyError) {
    return true;
  }
  if (convertError(error) instanceof AgentBusyError) {
    return true;
  }
  const errorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /already has active run/i.test(errorMessage);
}

function clearSessionLocksForWorkspace(workspaceId: string): number {
  let clearedCount = 0;
  for (const [sessionId, sessionLock] of sessionLocks.entries()) {
    if (sessionLock.workspaceId === workspaceId) {
      sessionLocks.delete(sessionId);
      clearedCount += 1;
    }
  }
  return clearedCount;
}

async function recoverStuckWorkspaceAgent(workspaceId: string, reason: string): Promise<void> {
  const clearedLocks = clearSessionLocksForWorkspace(workspaceId);
  const workspaceRecord = workspaceAgents.get(workspaceId);
  if (workspaceRecord) {
    workspaceRecord.busy = false;
  }
  await disposeWorkspaceAgent(workspaceId, reason);
  await clearPersistedAgentId(workspaceId);
  if (clearedLocks > 0) {
    logServerMessage(
      `workspace ${workspaceId} cleared ${clearedLocks} session lock(s) (${reason})`,
    );
  }
}

function normalizeThrownError(error: unknown): Error {
  const converted = convertError(error);
  if (converted instanceof Error) {
    return converted;
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function readRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeSessionId(rawSessionId: unknown): string {
  if (typeof rawSessionId !== "string") {
    return randomUUID();
  }
  const trimmed = rawSessionId.trim();
  if (trimmed.length < 8 || trimmed.length > 128) {
    return randomUUID();
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return randomUUID();
  }
  return trimmed;
}

function resolveWorkspace(rawWorkspaceId: unknown): WorkspaceEntry {
  if (typeof rawWorkspaceId === "string" && rawWorkspaceId.trim()) {
    const found = workspaceRegistry.find((entry) => entry.id === rawWorkspaceId.trim());
    if (found) {
      return found;
    }
  }
  const defaultEntry = workspaceRegistry.find((entry) => entry.id === defaultWorkspaceId);
  return defaultEntry ?? workspaceRegistry[0];
}

function parseClientAttachments(rawAttachments: unknown): ClientAttachmentPayload[] {
  if (!Array.isArray(rawAttachments)) {
    return [];
  }
  const parsed: ClientAttachmentPayload[] = [];
  for (const item of rawAttachments) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const filename = typeof record.filename === "string" ? record.filename.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType.trim() : "application/octet-stream";
    const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64.trim() : "";
    if (!filename || !dataBase64) {
      continue;
    }
    parsed.push({ filename, mimeType, dataBase64 });
  }
  return parsed.slice(0, 5);
}

function addHttpMcpServerIfConfigured(
  targetServers: Record<string, McpServerConfig>,
  serverLabel: string,
  baseUrl: string | undefined,
  apiKeyValue: string | undefined,
): void {
  const trimmedUrl = baseUrl?.trim();
  const trimmedKey = apiKeyValue?.trim();
  if (!trimmedUrl && !trimmedKey) {
    return;
  }
  if (!trimmedUrl || !trimmedKey) {
    throw new Error(
      `MCP "${serverLabel}": задайте оба параметра — URL и ключ API, либо уберите оба.`,
    );
  }
  targetServers[serverLabel] = {
    type: "http",
    url: trimmedUrl,
    headers: { "X-API-Key": trimmedKey },
  };
}

function mergeMcpServersFromJsonEnv(targetServers: Record<string, McpServerConfig>): void {
  const rawJson = process.env.MCP_EXTRA_JSON?.trim();
  if (!rawJson) {
    return;
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rawJson) as unknown;
  } catch {
    throw new Error("MCP_EXTRA_JSON не является корректным JSON.");
  }
  if (parsedValue === null || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
    throw new Error('MCP_EXTRA_JSON должен быть JSON-объектом вида {"имя_сервера": { ... }}');
  }
  const entriesFromJson = parsedValue as Record<string, unknown>;
  for (const [serverLabel, configValue] of Object.entries(entriesFromJson)) {
    targetServers[serverLabel] = configValue as McpServerConfig;
  }
}

function buildMcpServersConfiguration(): Record<string, McpServerConfig> | undefined {
  const servers: Record<string, McpServerConfig> = {};

  addHttpMcpServerIfConfigured(
    servers,
    "atlassian",
    process.env.ATLASSIAN_MCP_URL,
    process.env.ATLASSIAN_MCP_API_KEY,
  );
  addHttpMcpServerIfConfigured(
    servers,
    "gitlab",
    process.env.GITLAB_MCP_URL,
    process.env.GITLAB_MCP_API_KEY,
  );
  addHttpMcpServerIfConfigured(
    servers,
    "minio",
    process.env.MINIO_MCP_URL,
    process.env.MINIO_MCP_API_KEY,
  );
  addHttpMcpServerIfConfigured(
    servers,
    "exchange_work",
    process.env.EXCHANGE_MCP_URL,
    process.env.EXCHANGE_MCP_API_KEY,
  );

  mergeMcpServersFromJsonEnv(servers);

  return Object.keys(servers).length > 0 ? servers : undefined;
}

function listConfiguredMcpServersForDiagnostics(): Array<{ id: string; transport: string; endpoint: string }> {
  const servers = buildMcpServersConfiguration();
  if (!servers) {
    return [];
  }
  return Object.entries(servers).map(([serverId, config]) => {
    if ("url" in config) {
      return {
        id: serverId,
        transport: config.type ?? "http",
        endpoint: config.url,
      };
    }
    return {
      id: serverId,
      transport: "stdio",
      endpoint: config.command,
    };
  });
}

function resolveModelIdForRequest(
  response: express.Response,
  rawModelId: unknown,
): string | undefined {
  try {
    return resolveRequestedAgentModelId(rawModelId);
  } catch (modelError) {
    if (modelError instanceof InvalidAgentModelIdError) {
      response.status(400).json({ error: modelError.message });
      return undefined;
    }
    throw modelError;
  }
}

async function createChatAgent(
  workspace: WorkspaceEntry,
  modelId: string,
): Promise<SDKAgent> {
  const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
  const mcpServers = buildMcpServersConfiguration();
  const mcpServerIds = mcpServers ? Object.keys(mcpServers) : [];
  if (mcpServerIds.length > 0) {
    logServerMessage(`creating agent with MCP: ${mcpServerIds.join(", ")}`);
  } else {
    logServerMessage("creating agent without MCP servers");
  }

  return Agent.create({
    apiKey,
    model: { id: modelId },
    local: {
      cwd: workspace.path,
      settingSources: [],
    },
    ...(mcpServers ? { mcpServers } : {}),
  });
}

async function resumeOrCreateWorkspaceAgent(
  workspace: WorkspaceEntry,
  modelId: string,
): Promise<SDKAgent> {
  const persistedAgentId = await loadPersistedAgentId(workspace.id);
  const persistedModelId = await loadPersistedModelId(workspace.id);
  const canResumePersistedAgent =
    Boolean(persistedAgentId) &&
    (!persistedModelId || persistedModelId === modelId);

  if (persistedAgentId && !canResumePersistedAgent) {
    logServerMessage(
      `workspace ${workspace.id} skip resume: model ${persistedModelId ?? "?"} → ${modelId}`,
    );
    await clearPersistedAgentId(workspace.id);
  }

  if (persistedAgentId && canResumePersistedAgent) {
    try {
      const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
      const mcpServers = buildMcpServersConfiguration();
      const agent = await Agent.resume(persistedAgentId, {
        apiKey,
        model: { id: modelId },
        local: {
          cwd: workspace.path,
          settingSources: [],
        },
        ...(mcpServers ? { mcpServers } : {}),
      });
      logServerMessage(
        `workspace ${workspace.id} resumed agent ${agent.agentId} (model ${modelId})`,
      );
      return agent;
    } catch (resumeError) {
      logServerMessage(
        `workspace ${workspace.id} resume failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`,
      );
      await clearPersistedAgentId(workspace.id);
    }
  }
  return createChatAgent(workspace, modelId);
}

async function buildUserMessagePayload(
  messageText: string,
  sessionId: string,
  workspacePath: string,
  attachments: ClientAttachmentPayload[],
): Promise<string | SDKUserMessage> {
  const trimmedText = messageText.trim();
  if (attachments.length === 0) {
    return trimmedText;
  }

  const uploadRelativeDirectory = path.join(".cursor-chat-uploads", sessionId);
  const uploadAbsoluteDirectory = path.join(workspacePath, uploadRelativeDirectory);
  await fs.mkdir(uploadAbsoluteDirectory, { recursive: true });

  const imageBlocks: SDKImage[] = [];
  const savedFileLines: string[] = [];

  for (const attachment of attachments) {
    const safeFilename = path.basename(attachment.filename).replace(/[^\w.\-]+/g, "_");
    const fileBuffer = Buffer.from(attachment.dataBase64, "base64");
    if (fileBuffer.length > UPLOAD_MAX_BYTES) {
      throw new Error(
        `Файл «${safeFilename}» слишком большой (лимит ${UPLOAD_MAX_BYTES} байт).`,
      );
    }

    const relativeFilePath = path.join(uploadRelativeDirectory, safeFilename);
    const absoluteFilePath = path.join(workspacePath, relativeFilePath);
    await fs.writeFile(absoluteFilePath, fileBuffer);

    const mimeType = attachment.mimeType || "application/octet-stream";
    const posixRelativePath = relativeFilePath.split(path.sep).join("/");

    if (mimeType.startsWith("image/")) {
      imageBlocks.push({
        data: attachment.dataBase64,
        mimeType,
      });
      savedFileLines.push(`${safeFilename} (изображение, также сохранено в ${posixRelativePath})`);
    } else {
      savedFileLines.push(`${safeFilename} → ${posixRelativePath}`);
    }
  }

  const filesSection = savedFileLines.map((line) => `- ${line}`).join("\n");
  const textParts: string[] = [];
  if (trimmedText) {
    textParts.push(trimmedText);
  }
  if (savedFileLines.length > 0) {
    textParts.push(`[Прикреплённые файлы]\n${filesSection}`);
  }
  const composedText = textParts.join("\n\n");

  if (imageBlocks.length > 0) {
    return { text: composedText, images: imageBlocks };
  }
  return composedText;
}

function clearWorkspaceIdleTimer(workspaceRecord: WorkspaceAgentRecord): void {
  if (workspaceRecord.idleDisposeTimer !== undefined) {
    clearTimeout(workspaceRecord.idleDisposeTimer);
    workspaceRecord.idleDisposeTimer = undefined;
  }
}

function scheduleWorkspaceIdleDispose(
  workspaceId: string,
  workspaceRecord: WorkspaceAgentRecord,
): void {
  clearWorkspaceIdleTimer(workspaceRecord);
  workspaceRecord.idleDisposeTimer = setTimeout(() => {
    void disposeWorkspaceAgent(workspaceId, "idle timeout");
  }, SESSION_IDLE_DISPOSE_MS);
}

function touchWorkspaceActivity(workspaceRecord: WorkspaceAgentRecord): void {
  workspaceRecord.lastActivityAt = Date.now();
}

async function disposeWorkspaceAgent(workspaceId: string, reason: string): Promise<void> {
  const workspaceRecord = workspaceAgents.get(workspaceId);
  if (!workspaceRecord) {
    return;
  }
  workspaceAgents.delete(workspaceId);
  clearWorkspaceIdleTimer(workspaceRecord);
  try {
    await workspaceRecord.agent[Symbol.asyncDispose]();
    logServerMessage(`workspace ${workspaceId} agent disposed (${reason})`);
  } catch (disposeError) {
    logServerMessage(
      `workspace ${workspaceId} dispose failed (${reason}): ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
    );
  }
}

async function getOrCreateWorkspaceAgent(
  workspace: WorkspaceEntry,
  modelId: string,
): Promise<WorkspaceAgentRecord> {
  const existing = workspaceAgents.get(workspace.id);
  if (existing) {
    if (existing.modelId !== modelId) {
      await disposeWorkspaceAgent(workspace.id, `model ${existing.modelId} → ${modelId}`);
      await clearPersistedAgentId(workspace.id);
    } else {
      touchWorkspaceActivity(existing);
      clearWorkspaceIdleTimer(existing);
      return existing;
    }
  }

  const agent = await resumeOrCreateWorkspaceAgent(workspace, modelId);
  await savePersistedAgentId(workspace.id, agent.agentId, modelId);

  const workspaceRecord: WorkspaceAgentRecord = {
    agent,
    workspaceId: workspace.id,
    modelId,
    busy: false,
    lastActivityAt: Date.now(),
    idleDisposeTimer: undefined,
  };
  workspaceAgents.set(workspace.id, workspaceRecord);
  logServerMessage(
    `workspace ${workspace.id} agent ready (${agent.agentId}, model ${modelId})`,
  );
  return workspaceRecord;
}

function writeSseDataLine(
  response: express.Response,
  payload: Record<string, unknown>,
): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractAssistantTextDelta(message: SDKAssistantMessage): string {
  let combinedText = "";
  for (const block of message.message.content) {
    if (block.type === "text") {
      combinedText += block.text;
    }
  }
  return combinedText;
}

function describeStreamMessageForClient(message: SDKMessage): Record<string, unknown> | null {
  if (message.type === "assistant") {
    const text = extractAssistantTextDelta(message);
    if (text.length > 0) {
      return { kind: "assistant_text", text };
    }
    return null;
  }
  if (message.type === "thinking") {
    return { kind: "thinking", text: message.text };
  }
  if (message.type === "tool_call") {
    const toolMessage = message as SDKToolUseMessage;
    return {
      kind: "tool_call",
      name: toolMessage.name,
      status: toolMessage.status,
    };
  }
  if (message.type === "status") {
    return { kind: "status", status: message.status, message: message.message };
  }
  return null;
}

interface AgentRunStreamOptions {
  onAssistantText: (textDelta: string) => void;
  shouldContinue: () => boolean;
  writeClientEvent?: (payload: Record<string, unknown>) => void;
}

async function runAgentStreamToCompletion(
  agentRun: Run,
  streamOptions: AgentRunStreamOptions,
): Promise<{ status: string; result?: string; runId: string }> {
  const runDiagnosticsCollector = new RunDiagnosticsCollector();

  for await (const streamMessage of agentRun.stream()) {
    if (!streamOptions.shouldContinue()) {
      if (agentRun.supports("cancel")) {
        try {
          await agentRun.cancel();
        } catch (cancelError) {
          logServerMessage(
            `cancel after disconnect: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
          );
        }
      }
      break;
    }
    if (streamMessage.type === "assistant") {
      const textDelta = extractAssistantTextDelta(streamMessage);
      if (textDelta) {
        streamOptions.onAssistantText(textDelta);
      }
    }
    runDiagnosticsCollector.observeStreamMessage(streamMessage);
    const clientPayload = describeStreamMessageForClient(streamMessage);
    if (clientPayload && streamOptions.writeClientEvent) {
      streamOptions.writeClientEvent(clientPayload);
    }
  }

  if (!streamOptions.shouldContinue()) {
    return { status: "cancelled", runId: agentRun.id };
  }

  const terminalResult = await agentRun.wait();
  let resolvedResultText = terminalResult.result;
  if (terminalResult.status === "error") {
    resolvedResultText = await resolveRunErrorDetailText(
      agentRun,
      terminalResult,
      runDiagnosticsCollector,
    );
    logServerMessage(
      `run ${agentRun.id} finished with error:\n${resolvedResultText}`,
    );
  }
  if (streamOptions.writeClientEvent) {
    streamOptions.writeClientEvent({
      kind: "run_finished",
      status: terminalResult.status,
      result: resolvedResultText,
      runId: agentRun.id,
    });
  }
  return {
    status: terminalResult.status,
    result: resolvedResultText,
    runId: agentRun.id,
  };
}

async function streamAgentRunToClient(
  agentRun: Run,
  response: express.Response,
  isClientStillConnected: () => boolean,
  onAssistantText: (textDelta: string) => void,
): Promise<{ status: string; result?: string; runId: string }> {
  return runAgentStreamToCompletion(agentRun, {
    onAssistantText,
    shouldContinue: isClientStillConnected,
    writeClientEvent: (payload) => writeSseDataLine(response, payload),
  });
}

interface ChatMessageRunResult {
  assistantText: string;
  runOutcome: { status: string; result?: string; runId: string };
}

function prependTextToUserPayload(
  userMessagePayload: string | SDKUserMessage,
  prefix: string,
): string | SDKUserMessage {
  if (!prefix.trim()) {
    return userMessagePayload;
  }
  if (typeof userMessagePayload === "string") {
    return `${prefix}${userMessagePayload}`;
  }
  return {
    ...userMessagePayload,
    text: `${prefix}${userMessagePayload.text ?? ""}`,
  };
}

function appendTextToUserPayload(
  userMessagePayload: string | SDKUserMessage,
  suffix: string,
): string | SDKUserMessage {
  if (!suffix.trim()) {
    return userMessagePayload;
  }
  if (typeof userMessagePayload === "string") {
    return `${userMessagePayload}${suffix}`;
  }
  return {
    ...userMessagePayload,
    text: `${userMessagePayload.text ?? ""}${suffix}`,
  };
}

async function executeChatMessageCore(
  workspace: WorkspaceEntry,
  userMessagePayload: string | SDKUserMessage,
  userMessageText: string,
  streamSink: {
    shouldContinue: () => boolean;
    writeClientEvent?: (payload: Record<string, unknown>) => void;
  },
  options: {
    forceLocalRun: boolean;
    recreateWorkspaceAgent: boolean;
    responseMode: ChatResponseMode;
    modelId: string;
  },
): Promise<ChatMessageRunResult> {
  if (options.recreateWorkspaceAgent) {
    await disposeWorkspaceAgent(workspace.id, "recreate before retry");
    await clearPersistedAgentId(workspace.id);
  }

  const workspaceRecord = await getOrCreateWorkspaceAgent(workspace, options.modelId);
  const dateTimePrefix = buildCurrentDateTimeContextPrefix();
  const stylePrefix = buildChatResponseStylePrefix(options.responseMode);
  const brainPrefix = await buildBrainContextPrefix({
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    userMessageText,
  });
  const combinedContextPrefix = [dateTimePrefix, stylePrefix, brainPrefix]
    .filter((section) => section.trim().length > 0)
    .join("");
  const styleSuffix = buildChatResponseStyleSuffix(options.responseMode);
  const payloadWithContext = prependTextToUserPayload(
    userMessagePayload,
    combinedContextPrefix,
  );
  const payloadWithBrain =
    styleSuffix.trim().length > 0
      ? appendTextToUserPayload(payloadWithContext, styleSuffix)
      : payloadWithContext;

  const sendOptions = options.forceLocalRun ? { local: { force: true } } : undefined;
  const agentRun = await workspaceRecord.agent.send(payloadWithBrain, sendOptions);

  let assistantAccumulatedText = "";
  const runOutcome = await runAgentStreamToCompletion(agentRun, {
    onAssistantText: (textDelta) => {
      assistantAccumulatedText += textDelta;
    },
    shouldContinue: streamSink.shouldContinue,
    writeClientEvent: streamSink.writeClientEvent,
  });

  const isVoiceResponseMode = options.responseMode === "voice";
  const sanitizedAssistantText = isVoiceResponseMode
    ? sanitizeAssistantResponseForChat(assistantAccumulatedText)
    : assistantAccumulatedText;
  if (
    isVoiceResponseMode &&
    sanitizedAssistantText &&
    sanitizedAssistantText !== assistantAccumulatedText &&
    streamSink.shouldContinue() &&
    streamSink.writeClientEvent
  ) {
    streamSink.writeClientEvent({
      kind: "assistant_text_final",
      text: sanitizedAssistantText,
    });
  }

  if (runOutcome.status !== "error" && streamSink.shouldContinue()) {
    try {
      await persistBrainAfterRun({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        userMessageText,
        assistantMessageText: sanitizedAssistantText,
        runId: runOutcome.runId,
        runStatus: runOutcome.status,
      });
    } catch (brainError) {
      logServerMessage(
        `brain persist failed: ${brainError instanceof Error ? brainError.message : String(brainError)}`,
      );
    }
  }

  return { assistantText: sanitizedAssistantText, runOutcome };
}

async function executeChatMessageForWorkspace(
  workspace: WorkspaceEntry,
  sessionId: string,
  userMessagePayload: string | SDKUserMessage,
  userMessageText: string,
  response: express.Response,
  isClientStillConnected: () => boolean,
  options: {
    forceLocalRun: boolean;
    recreateWorkspaceAgent: boolean;
    responseMode: ChatResponseMode;
    modelId: string;
  },
): Promise<void> {
  await executeChatMessageCore(
    workspace,
    userMessagePayload,
    userMessageText,
    {
      shouldContinue: isClientStillConnected,
      writeClientEvent: (payload) => writeSseDataLine(response, payload),
    },
    options,
  );
}

function releaseChatTurnLocks(sessionId: string, workspaceId: string): void {
  const sessionLockRecord = sessionLocks.get(sessionId);
  if (sessionLockRecord) {
    sessionLockRecord.busy = false;
  }
  const updatedWorkspace = workspaceAgents.get(workspaceId);
  if (updatedWorkspace) {
    updatedWorkspace.busy = false;
    touchWorkspaceActivity(updatedWorkspace);
    scheduleWorkspaceIdleDispose(workspaceId, updatedWorkspace);
  }
}

async function runChatTurnWithRetry(
  workspace: WorkspaceEntry,
  sessionId: string,
  userMessagePayload: string | SDKUserMessage,
  userMessageText: string,
  responseMode: ChatResponseMode,
  modelId: string,
  streamSink: {
    shouldContinue: () => boolean;
    writeClientEvent?: (payload: Record<string, unknown>) => void;
  },
): Promise<ChatMessageRunResult> {
  try {
    return await executeChatMessageCore(
      workspace,
      userMessagePayload,
      userMessageText,
      streamSink,
      { forceLocalRun: false, recreateWorkspaceAgent: false, responseMode, modelId },
    );
  } catch (firstAttemptError) {
    const normalizedError = normalizeThrownError(firstAttemptError);
    const agentIsBusy = isAgentBusyFailure(firstAttemptError);
    const shouldRecreateWorkspaceAgent =
      isAuthenticationFailure(firstAttemptError) || agentIsBusy;
    const shouldForceLocalRun = agentIsBusy || shouldRecreateWorkspaceAgent;

    if (!shouldRecreateWorkspaceAgent && !shouldForceLocalRun) {
      throw normalizedError;
    }

    if (agentIsBusy) {
      await recoverStuckWorkspaceAgent(workspace.id, "active run conflict before retry");
    }

    logServerMessage(
      `workspace ${workspace.id} retry: recreate=${shouldRecreateWorkspaceAgent} force=${shouldForceLocalRun} (${normalizedError.message})`,
    );

    if (!streamSink.shouldContinue()) {
      throw normalizedError;
    }

    return await executeChatMessageCore(
      workspace,
      userMessagePayload,
      userMessageText,
      streamSink,
      {
        forceLocalRun: shouldForceLocalRun || shouldRecreateWorkspaceAgent,
        recreateWorkspaceAgent: shouldRecreateWorkspaceAgent,
        responseMode,
        modelId,
      },
    );
  }
}

application.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    activeWorkspaceAgents: workspaceAgents.size,
    busyWorkspaceAgents: [...workspaceAgents.values()].filter((record) => record.busy).length,
    activeSessionLocks: sessionLocks.size,
    workspaces: workspaceRegistry.length,
    brain: {
      memory: true,
      supabase: isSupabaseBrainEnabled(),
      qdrant: isQdrantBrainEnabled(),
      embeddings: isEmbeddingEnabled(),
      embeddingProvider: getEmbeddingProviderLabel(),
    },
    voice: getVoicePublicConfig(),
  });
});

application.use(optionalBasicAuthMiddleware);

application.get("/api/config", (_request, response) => {
  const configuredMcpServers = listConfiguredMcpServersForDiagnostics();
  response.json({
    defaultWorkspaceId,
    workspaces: workspaceRegistry.map((entry) => ({
      id: entry.id,
      label: entry.label,
      path: entry.path,
    })),
    mcpServers: configuredMcpServers,
    mcpServerIds: configuredMcpServers.map((entry) => entry.id),
    uploadMaxBytes: UPLOAD_MAX_BYTES,
    defaultModelId: getDefaultAgentModelId(),
    models: listAgentModelOptions(),
    vpnHealth: {
      healthUrl: getVpnHealthUrl(),
      pollIntervalMs: getVpnHealthPollIntervalMs(),
    },
    brain: {
      memoryEnabled: true,
      supabase: isSupabaseBrainEnabled(),
      qdrant: isQdrantBrainEnabled(),
      embeddings: isEmbeddingEnabled(),
      embeddingProvider: getEmbeddingProviderLabel(),
    },
    voice: getVoicePublicConfig(),
  });
});

registerVoiceRoutes(application);

registerVoiceTurnRoute(application, {
  normalizeSessionId,
  resolveWorkspace,
  buildUserMessagePayload,
  isSessionBusy: (sessionId) => sessionLocks.get(sessionId)?.busy === true,
  isWorkspaceBusy: (workspaceId) => workspaceAgents.get(workspaceId)?.busy === true,
  acquireChatTurnLocks: async (sessionId, workspaceId, modelId) => {
    const workspaceForLock = resolveWorkspace(workspaceId);
    sessionLocks.set(sessionId, { busy: true, workspaceId: workspaceForLock.id });
    const ensuredWorkspace = await getOrCreateWorkspaceAgent(workspaceForLock, modelId);
    ensuredWorkspace.busy = true;
    touchWorkspaceActivity(ensuredWorkspace);
    clearWorkspaceIdleTimer(ensuredWorkspace);
  },
  releaseChatTurnLocks,
  runChatTurnWithRetry: (
    workspace,
    sessionId,
    userMessagePayload,
    userMessageText,
    responseMode,
    modelId,
  ) =>
    runChatTurnWithRetry(
      workspace,
      sessionId,
      userMessagePayload,
      userMessageText,
      responseMode,
      modelId,
      {
        shouldContinue: () => true,
      },
    ),
  recoverWorkspaceAfterFailure: async (workspaceId, reason, error) => {
    if (isAuthenticationFailure(error)) {
      await recoverStuckWorkspaceAgent(workspaceId, reason);
    } else if (isAgentBusyFailure(error)) {
      await recoverStuckWorkspaceAgent(workspaceId, reason);
    }
  },
  resolveModelId: resolveModelIdForRequest,
});

application.get("/api/vpn-health", async (_request, response) => {
  const probeResult = await probeVpnHealth();
  response.json(probeResult);
});

application.post("/api/chat", async (request, response) => {
  const sessionId = normalizeSessionId(request.body?.sessionId);
  const workspace = resolveWorkspace(request.body?.workspaceId);
  const userMessageText = typeof request.body?.message === "string" ? request.body.message : "";
  const responseMode = parseChatResponseMode(request.body?.responseMode);
  const attachments = parseClientAttachments(request.body?.attachments);
  const resolvedModelId = resolveModelIdForRequest(response, request.body?.modelId);
  if (!resolvedModelId) {
    return;
  }

  if (!userMessageText.trim() && attachments.length === 0) {
    response.status(400).json({ error: "Нужен текст сообщения и/или вложения." });
    return;
  }

  let userMessagePayload: string | SDKUserMessage;
  try {
    userMessagePayload = await buildUserMessagePayload(
      userMessageText,
      sessionId,
      workspace.path,
      attachments,
    );
  } catch (buildError) {
    response.status(400).json({
      error: buildError instanceof Error ? buildError.message : String(buildError),
    });
    return;
  }

  const sessionLock = sessionLocks.get(sessionId);
  if (sessionLock?.busy) {
    response.status(429).json({
      error: "Этот диалог ещё обрабатывает предыдущее сообщение. Дождитесь ответа.",
      sessionId,
    });
    return;
  }

  const workspaceRecord = workspaceAgents.get(workspace.id);
  if (workspaceRecord?.busy) {
    response.status(429).json({
      error: "Агент workspace занят другим запросом. Дождитесь ответа.",
      workspaceId: workspace.id,
    });
    return;
  }

  sessionLocks.set(sessionId, { busy: true, workspaceId: workspace.id });
  const ensuredWorkspace = await getOrCreateWorkspaceAgent(workspace, resolvedModelId);
  ensuredWorkspace.busy = true;
  touchWorkspaceActivity(ensuredWorkspace);
  clearWorkspaceIdleTimer(ensuredWorkspace);

  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Chat-Session-Id", sessionId);
  response.setHeader("X-Chat-Workspace-Id", workspace.id);
  response.setHeader("X-Chat-Model-Id", resolvedModelId);
  response.flushHeaders?.();

  writeSseDataLine(response, {
    kind: "session",
    sessionId,
    workspaceId: workspace.id,
    modelId: resolvedModelId,
  });

  let clientStillConnected = true;
  request.on("close", () => {
    clientStillConnected = false;
  });

  const isClientStillConnected = (): boolean => clientStillConnected && !response.writableEnded;

  try {
    try {
      await executeChatMessageForWorkspace(
        workspace,
        sessionId,
        userMessagePayload,
        userMessageText,
        response,
        isClientStillConnected,
        {
          forceLocalRun: false,
          recreateWorkspaceAgent: false,
          responseMode,
          modelId: resolvedModelId,
        },
      );
    } catch (firstAttemptError) {
      const normalizedError = normalizeThrownError(firstAttemptError);
      const agentIsBusy = isAgentBusyFailure(firstAttemptError);
      const shouldRecreateWorkspaceAgent =
        isAuthenticationFailure(firstAttemptError) || agentIsBusy;
      const shouldForceLocalRun = agentIsBusy || shouldRecreateWorkspaceAgent;

      if (!shouldRecreateWorkspaceAgent && !shouldForceLocalRun) {
        throw normalizedError;
      }

      if (agentIsBusy) {
        await recoverStuckWorkspaceAgent(
          workspace.id,
          "active run conflict before retry",
        );
      }

      logServerMessage(
        `workspace ${workspace.id} retry: recreate=${shouldRecreateWorkspaceAgent} force=${shouldForceLocalRun} (${normalizedError.message})`,
      );

      if (!isClientStillConnected()) {
        return;
      }

      await executeChatMessageForWorkspace(
        workspace,
        sessionId,
        userMessagePayload,
        userMessageText,
        response,
        isClientStillConnected,
        {
          forceLocalRun: shouldForceLocalRun || shouldRecreateWorkspaceAgent,
          recreateWorkspaceAgent: shouldRecreateWorkspaceAgent,
          responseMode,
          modelId: resolvedModelId,
        },
      );
    }

    if (isClientStillConnected()) {
      response.end();
    }
  } catch (error) {
    const normalizedError = normalizeThrownError(error);
    if (isAuthenticationFailure(error)) {
      await recoverStuckWorkspaceAgent(workspace.id, "authentication failure");
    } else if (isAgentBusyFailure(error)) {
      await recoverStuckWorkspaceAgent(workspace.id, "active run conflict after retry");
    }
    logServerMessage(`session ${sessionId} chat failed: ${normalizedError.message}`);
    if (isClientStillConnected()) {
      const cursorAgentError = normalizedError instanceof CursorAgentError ? normalizedError : undefined;
      writeSseDataLine(response, {
        kind: "error",
        message: normalizedError.message,
        isRetryable: cursorAgentError?.isRetryable ?? false,
        sessionId,
      });
      response.end();
    }
  } finally {
    const sessionLockRecord = sessionLocks.get(sessionId);
    if (sessionLockRecord) {
      sessionLockRecord.busy = false;
    }
    const updatedWorkspace = workspaceAgents.get(workspace.id);
    if (updatedWorkspace) {
      updatedWorkspace.busy = false;
      touchWorkspaceActivity(updatedWorkspace);
      scheduleWorkspaceIdleDispose(workspace.id, updatedWorkspace);
    }
  }
});

application.post("/api/new-chat", async (request, response) => {
  const previousSessionId =
    typeof request.body?.sessionId === "string" ? normalizeSessionId(request.body.sessionId) : undefined;
  const workspace = resolveWorkspace(request.body?.workspaceId);

  if (previousSessionId) {
    const previousLock = sessionLocks.get(previousSessionId);
    if (previousLock?.busy) {
      response.status(429).json({ error: "Дождитесь окончания текущего ответа." });
      return;
    }
    sessionLocks.delete(previousSessionId);
  }

  const newSessionId = randomUUID();
  response.json({
    ok: true,
    sessionId: newSessionId,
    workspaceId: workspace.id,
    agentPreserved: workspaceAgents.has(workspace.id),
  });
});

application.post("/api/reset-memory", async (request, response) => {
  const workspace = resolveWorkspace(request.body?.workspaceId);
  const workspaceRecord = workspaceAgents.get(workspace.id);
  if (workspaceRecord?.busy) {
    response.status(429).json({ error: "Дождитесь окончания текущего ответа." });
    return;
  }

  await clearMemoryFile(workspace.path);
  try {
    await clearWorkspaceBrain(workspace.id);
  } catch (brainError) {
    logServerMessage(
      `reset-memory supabase: ${brainError instanceof Error ? brainError.message : String(brainError)}`,
    );
  }
  try {
    await deleteQdrantCollection(workspace.id);
  } catch (qdrantError) {
    logServerMessage(
      `reset-memory qdrant: ${qdrantError instanceof Error ? qdrantError.message : String(qdrantError)}`,
    );
  }

  await disposeWorkspaceAgent(workspace.id, "reset memory");
  await clearPersistedAgentId(workspace.id);

  response.json({ ok: true, workspaceId: workspace.id });
});

application.post("/api/reset-agent", async (request, response) => {
  const workspace = resolveWorkspace(request.body?.workspaceId);
  const forceReset = request.body?.force === true;
  const workspaceRecord = workspaceAgents.get(workspace.id);
  if (workspaceRecord?.busy && !forceReset) {
    response.status(429).json({
      error:
        "Дождитесь окончания текущего ответа или вызовите сброс с force: true.",
    });
    return;
  }
  await recoverStuckWorkspaceAgent(
    workspace.id,
    forceReset ? "manual force reset" : "manual reset",
  );
  response.json({
    ok: true,
    workspaceId: workspace.id,
    disposed: true,
    force: forceReset,
    newAgentOnNextMessage: true,
  });
});

application.use(
  express.static(publicDirPath, {
    setHeaders(response, servedFilePath) {
      if (servedFilePath.endsWith(`${path.sep}index.html`)) {
        response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  }),
);

const listenPort = Number.parseInt(process.env.PORT || "3847", 10);

application.listen(listenPort, () => {
  logServerMessage(`listening on http://0.0.0.0:${listenPort}`);
  logServerMessage(
    `workspaces: ${workspaceRegistry.map((entry) => `${entry.id}=${entry.path}`).join(", ")}`,
  );
  const configuredMcpServers = listConfiguredMcpServersForDiagnostics();
  if (configuredMcpServers.length === 0) {
    logServerMessage("MCP at startup: (none)");
  } else {
    logServerMessage(
      `MCP at startup: ${configuredMcpServers.map((entry) => entry.id).join(", ")}`,
    );
  }
  if (isSupabaseBrainEnabled()) {
    logServerMessage("Brain Supabase: enabled");
  }
  if (isQdrantBrainEnabled()) {
    logServerMessage("Brain Qdrant: enabled");
  }
});

async function disposeAllWorkspaceAgentsOnShutdown(): Promise<void> {
  const workspaceIds = [...workspaceAgents.keys()];
  for (const workspaceId of workspaceIds) {
    await disposeWorkspaceAgent(workspaceId, "shutdown");
  }
}

process.on("SIGINT", () => {
  void disposeAllWorkspaceAgentsOnShutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void disposeAllWorkspaceAgentsOnShutdown().finally(() => process.exit(0));
});

process.on("unhandledRejection", (reason) => {
  logServerMessage(
    `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  if (isAuthenticationFailure(reason)) {
    const workspaceIds = [...workspaceAgents.keys()];
    for (const workspaceId of workspaceIds) {
      void disposeWorkspaceAgent(workspaceId, "unhandled auth rejection");
      void clearPersistedAgentId(workspaceId);
    }
  }
});

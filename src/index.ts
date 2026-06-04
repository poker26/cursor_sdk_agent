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
  Cursor,
  convertError,
  CursorAgentError,
  type ModelSelection,
  type SDKModel,
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
  findConfiguredModelLabel,
  hasCustomModelConfiguration,
  listAgentModelOptions,
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
import {
  formatPollIntervalLabel,
  getJiraBaseUrl,
  getDefaultPollIntervalMs,
  isMonitoringEnabled,
  listEpicMonitoring,
  parseMonitoringCommand,
  pollDueActiveEpics,
  registerEpicMonitoring,
  resolveEpicPollIntervalMs,
  setEpicMonitoringPollInterval,
  unregisterEpicMonitoring,
  type MonitoringCommand,
} from "./monitor/jira-epic-monitor.js";

const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
const publicDirPath = path.join(currentDirPath, "..", "public");

const SESSION_IDLE_DISPOSE_MS = Number.parseInt(
  process.env.SESSION_IDLE_DISPOSE_MS || String(30 * 60 * 1000),
  10,
);

const MONITOR_TICK_MS = Number.parseInt(
  process.env.MONITOR_TICK_MS || String(60 * 1000),
  10,
);

function isEnvFlagEnabled(rawValue: string | undefined, defaultEnabled: boolean): boolean {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized) {
    return defaultEnabled;
  }
  return normalized !== "false" && normalized !== "0" && normalized !== "no";
}

function getUiFeatureFlags(): { showVpnIndicator: boolean; allowAttachments: boolean } {
  return {
    showVpnIndicator: isEnvFlagEnabled(process.env.UI_SHOW_VPN_INDICATOR, true),
    allowAttachments: isEnvFlagEnabled(process.env.UI_ALLOW_ATTACHMENTS, true),
  };
}

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

interface ActiveChatRunRecord {
  run: Run;
  workspaceId: string;
}

const activeChatRunsBySession = new Map<string, ActiveChatRunRecord>();
const cancelledChatSessions = new Set<string>();

async function cancelActiveChatRunForSession(
  sessionId: string,
  workspaceId: string,
): Promise<boolean> {
  cancelledChatSessions.add(sessionId);
  const activeRecord = activeChatRunsBySession.get(sessionId);
  if (!activeRecord || activeRecord.workspaceId !== workspaceId) {
    return false;
  }
  if (activeRecord.run.supports("cancel")) {
    try {
      await activeRecord.run.cancel();
    } catch (cancelError) {
      logServerMessage(
        `chat cancel run ${activeRecord.run.id}: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
      );
    }
  }
  return true;
}

function clearChatCancellationState(sessionId: string): void {
  cancelledChatSessions.delete(sessionId);
  activeChatRunsBySession.delete(sessionId);
}

interface RuntimeModelCatalog {
  models: Array<{ id: string; label: string }>;
  ids: Set<string>;
  selectionById: Map<string, ModelSelection>;
  defaultModelId: string;
  fetchedAt: number;
}

const MODEL_CATALOG_TTL_MS = Number.parseInt(
  process.env.MODEL_CATALOG_TTL_MS || "60000",
  10,
);

let runtimeModelCatalogCache: RuntimeModelCatalog | undefined;
let runtimeModelCatalogInflight: Promise<RuntimeModelCatalog> | undefined;

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

function addHttpMcpServerWithOptionalApiKey(
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
  if (!trimmedUrl) {
    throw new Error(`MCP "${serverLabel}": нужен URL.`);
  }
  if (trimmedKey) {
    targetServers[serverLabel] = {
      type: "http",
      url: trimmedUrl,
      headers: { "X-API-Key": trimmedKey },
    };
    return;
  }
  targetServers[serverLabel] = {
    type: "http",
    url: trimmedUrl,
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
  addHttpMcpServerWithOptionalApiKey(
    servers,
    "historical-recipes",
    process.env.HISTORICAL_RECIPES_MCP_URL,
    process.env.HISTORICAL_RECIPES_MCP_API_KEY,
  );

  mergeMcpServersFromJsonEnv(servers);

  addNotionStdioMcpServerIfConfigured(servers);

  return Object.keys(servers).length > 0 ? servers : undefined;
}

function resolveNpxCommandPath(): string {
  const configuredPath = process.env.NOTION_MCP_NPX_PATH?.trim();
  if (configuredPath) {
    return configuredPath;
  }
  return path.join(path.dirname(process.execPath), "npx");
}

function addNotionStdioMcpServerIfConfigured(
  targetServers: Record<string, McpServerConfig>,
): void {
  if (targetServers.notion) {
    return;
  }
  const notionToken = process.env.NOTION_TOKEN?.trim();
  if (!notionToken) {
    return;
  }
  targetServers.notion = {
    type: "stdio",
    command: resolveNpxCommandPath(),
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_TOKEN: notionToken },
  };
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

async function fetchRuntimeModelCatalog(): Promise<RuntimeModelCatalog> {
  const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
  const sdkModels = await Cursor.models.list({ apiKey });
  const availableOptions = normalizeRuntimeModelOptions(sdkModels);
  const filteredOptions = filterRuntimeModelOptionsByConfiguration(availableOptions);
  if (filteredOptions.length === 0) {
    throw new Error(
      "Cursor API вернул пустой список моделей. Проверьте доступы API key и тариф.",
    );
  }
  const defaultFromEnvironment = getDefaultAgentModelId();
  const defaultModelId = filteredOptions.some(
    (option) => option.id === defaultFromEnvironment,
  )
    ? defaultFromEnvironment
    : filteredOptions[0].id;
  return {
    models: filteredOptions,
    ids: new Set(filteredOptions.map((option) => option.id)),
    selectionById: new Map(
      filteredOptions.map((option) => [option.id, option.selection] as [string, ModelSelection]),
    ),
    defaultModelId,
    fetchedAt: Date.now(),
  };
}

function normalizeRuntimeModelOptions(
  sdkModels: SDKModel[],
): Array<{ id: string; label: string; selection: ModelSelection }> {
  const uniqueById = new Map<string, { id: string; label: string; selection: ModelSelection }>();
  for (const modelItem of sdkModels) {
    const modelId = modelItem.id?.trim();
    if (!modelId) {
      continue;
    }
    const configuredLabel = findConfiguredModelLabel(modelId);
    const modelLabel = configuredLabel || modelItem.displayName?.trim() || modelId;
    const defaultVariant =
      modelItem.variants?.find((variant) => variant.isDefault) ??
      modelItem.variants?.[0];
    const selection: ModelSelection = defaultVariant?.params?.length
      ? { id: modelId, params: defaultVariant.params }
      : { id: modelId };
    uniqueById.set(modelId, { id: modelId, label: modelLabel, selection });
  }
  return [...uniqueById.values()];
}

function filterRuntimeModelOptionsByConfiguration(
  runtimeModels: Array<{ id: string; label: string; selection: ModelSelection }>,
): Array<{ id: string; label: string; selection: ModelSelection }> {
  if (!hasCustomModelConfiguration()) {
    return runtimeModels;
  }
  const configuredIds = new Set(listAgentModelOptions().map((option) => option.id));
  return runtimeModels.filter((option) => configuredIds.has(option.id));
}

async function resolveModelSelection(modelId: string): Promise<ModelSelection> {
  const modelCatalog = await getRuntimeModelCatalog();
  const selection = modelCatalog.selectionById.get(modelId);
  if (selection) {
    return selection;
  }
  return { id: modelId };
}

async function getRuntimeModelCatalog(forceRefresh = false): Promise<RuntimeModelCatalog> {
  if (
    !forceRefresh &&
    runtimeModelCatalogCache &&
    Date.now() - runtimeModelCatalogCache.fetchedAt < MODEL_CATALOG_TTL_MS
  ) {
    return runtimeModelCatalogCache;
  }
  if (runtimeModelCatalogInflight && !forceRefresh) {
    return runtimeModelCatalogInflight;
  }
  runtimeModelCatalogInflight = fetchRuntimeModelCatalog()
    .then((catalog) => {
      runtimeModelCatalogCache = catalog;
      return catalog;
    })
    .finally(() => {
      runtimeModelCatalogInflight = undefined;
    });
  return runtimeModelCatalogInflight;
}

async function resolveModelIdForRequest(
  response: express.Response,
  rawModelId: unknown,
): Promise<string | undefined> {
  try {
    const modelCatalog = await getRuntimeModelCatalog();
    if (rawModelId === undefined || rawModelId === null || rawModelId === "") {
      return modelCatalog.defaultModelId;
    }
    if (typeof rawModelId !== "string") {
      response.status(400).json({
        error: `Некорректный modelId: ${String(rawModelId)}.`,
      });
      return undefined;
    }
    const normalizedModelId = rawModelId.trim();
    if (!normalizedModelId) {
      return modelCatalog.defaultModelId;
    }
    if (!modelCatalog.ids.has(normalizedModelId)) {
      response.status(400).json({
        error: `Модель «${normalizedModelId}» недоступна для текущего API key. Доступны: ${modelCatalog.models
          .map((item) => item.id)
          .join(", ")}.`,
      });
      return undefined;
    }
    return normalizedModelId;
  } catch (modelCatalogError) {
    const message =
      modelCatalogError instanceof Error
        ? modelCatalogError.message
        : String(modelCatalogError);
    response.status(503).json({
      error: `Не удалось загрузить список моделей Cursor: ${message}`,
    });
    return undefined;
  }
}

async function createChatAgent(
  workspace: WorkspaceEntry,
  modelId: string,
): Promise<SDKAgent> {
  const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
  const modelSelection = await resolveModelSelection(modelId);
  const mcpServers = buildMcpServersConfiguration();
  const mcpServerIds = mcpServers ? Object.keys(mcpServers) : [];
  if (mcpServerIds.length > 0) {
    logServerMessage(`creating agent with MCP: ${mcpServerIds.join(", ")}`);
  } else {
    logServerMessage("creating agent without MCP servers");
  }

  return Agent.create({
    apiKey,
    model: modelSelection,
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
      const modelSelection = await resolveModelSelection(modelId);
      const mcpServers = buildMcpServersConfiguration();
      const agent = await Agent.resume(persistedAgentId, {
        apiKey,
        model: modelSelection,
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
  const responseWithFlush = response as express.Response & { flush?: () => void };
  if (typeof responseWithFlush.flush === "function") {
    responseWithFlush.flush();
  }
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
    const thinkingText = message.text?.trim() ?? "";
    const truncatedThinkingText =
      thinkingText.length > 240 ? `${thinkingText.slice(0, 240)}…` : thinkingText;
    return { kind: "thinking", text: truncatedThinkingText };
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
  if (message.type === "task") {
    const taskText = message.text?.trim() ?? "";
    const taskStatus = message.status?.trim() ?? "";
    if (!taskText && !taskStatus) {
      return null;
    }
    return { kind: "task", status: taskStatus, text: taskText };
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
    try {
      runDiagnosticsCollector.observeStreamMessage(streamMessage);
    } catch (diagnosticsObserveError) {
      logServerMessage(
        `run diagnostics observe skipped: ${diagnosticsObserveError instanceof Error ? diagnosticsObserveError.message : String(diagnosticsObserveError)}`,
      );
    }
    const clientPayload = describeStreamMessageForClient(streamMessage);
    if (clientPayload && streamOptions.writeClientEvent) {
      streamOptions.writeClientEvent(clientPayload);
    }
  }

  if (!streamOptions.shouldContinue()) {
    if (streamOptions.writeClientEvent) {
      streamOptions.writeClientEvent({
        kind: "run_finished",
        status: "cancelled",
        runId: agentRun.id,
      });
    }
    return { status: "cancelled", runId: agentRun.id };
  }

  let terminalResult: Awaited<ReturnType<Run["wait"]>>;
  try {
    terminalResult = await agentRun.wait();
  } catch (waitError) {
    const waitErrorMessage =
      waitError instanceof Error ? waitError.message : String(waitError);
    logServerMessage(`run ${agentRun.id} wait() failed: ${waitErrorMessage}`);
    const fallbackResult = await resolveRunErrorDetailText(
      agentRun,
      {
        id: agentRun.id,
        status: "error",
        result: waitErrorMessage,
      },
      runDiagnosticsCollector,
    );
    if (streamOptions.writeClientEvent) {
      streamOptions.writeClientEvent({
        kind: "run_finished",
        status: "error",
        result: fallbackResult,
        runId: agentRun.id,
      });
    }
    return { status: "error", result: fallbackResult, runId: agentRun.id };
  }

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
    sessionId?: string;
  },
): Promise<ChatMessageRunResult> {
  if (options.recreateWorkspaceAgent) {
    await disposeWorkspaceAgent(workspace.id, "recreate before retry");
    await clearPersistedAgentId(workspace.id);
  }

  const workspaceRecord = await getOrCreateWorkspaceAgent(workspace, options.modelId);
  streamSink.writeClientEvent?.({
    kind: "activity",
    message: "Сбор контекста и памяти…",
  });
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
  streamSink.writeClientEvent?.({
    kind: "activity",
    message: "Запуск агента…",
  });
  const agentRun = await workspaceRecord.agent.send(payloadWithBrain, sendOptions);
  streamSink.writeClientEvent?.({
    kind: "activity",
    message: "Агент выполняет задачу…",
    runId: agentRun.id,
  });

  if (options.sessionId) {
    activeChatRunsBySession.set(options.sessionId, {
      run: agentRun,
      workspaceId: workspace.id,
    });
  }

  let assistantAccumulatedText = "";
  let runOutcome: { status: string; result?: string; runId: string };
  try {
    runOutcome = await runAgentStreamToCompletion(agentRun, {
      onAssistantText: (textDelta) => {
        assistantAccumulatedText += textDelta;
      },
      shouldContinue: streamSink.shouldContinue,
      writeClientEvent: streamSink.writeClientEvent,
    });
  } finally {
    if (options.sessionId) {
      activeChatRunsBySession.delete(options.sessionId);
    }
  }

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
    { ...options, sessionId },
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
      {
        forceLocalRun: false,
        recreateWorkspaceAgent: false,
        responseMode,
        modelId,
        sessionId,
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
        sessionId,
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

application.get("/api/config", async (_request, response) => {
  const configuredMcpServers = listConfiguredMcpServersForDiagnostics();
  let runtimeModelCatalog: RuntimeModelCatalog;
  try {
    runtimeModelCatalog = await getRuntimeModelCatalog();
  } catch (modelCatalogError) {
    const message =
      modelCatalogError instanceof Error
        ? modelCatalogError.message
        : String(modelCatalogError);
    response.status(503).json({
      error: `Не удалось загрузить список моделей Cursor: ${message}`,
    });
    return;
  }
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
    defaultModelId: runtimeModelCatalog.defaultModelId,
    models: runtimeModelCatalog.models,
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
    ui: getUiFeatureFlags(),
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

application.post("/api/chat/cancel", async (request, response) => {
  const sessionId = normalizeSessionId(request.body?.sessionId);
  const workspace = resolveWorkspace(request.body?.workspaceId);

  if (!sessionId) {
    response.status(400).json({ error: "Нужен sessionId." });
    return;
  }

  const runWasCancelled = await cancelActiveChatRunForSession(sessionId, workspace.id);
  releaseChatTurnLocks(sessionId, workspace.id);
  logServerMessage(
    `session ${sessionId} chat cancel requested (run=${runWasCancelled ? "stopped" : "not found"})`,
  );
  response.json({ ok: true, cancelled: runWasCancelled });
});

function beginMonitoringSseResponse(
  response: express.Response,
  sessionId: string,
  workspace: WorkspaceEntry,
  modelId: string,
): void {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Chat-Session-Id", sessionId);
  response.setHeader("X-Chat-Workspace-Id", workspace.id);
  response.setHeader("X-Chat-Model-Id", modelId);
  response.flushHeaders?.();
  writeSseDataLine(response, {
    kind: "session",
    sessionId,
    workspaceId: workspace.id,
    modelId,
  });
}

async function resolveMonitoringCommandReply(
  workspace: WorkspaceEntry,
  command: MonitoringCommand,
): Promise<string> {
  if (!isMonitoringEnabled()) {
    return (
      "Мониторинг Jira пока не настроен на сервере. Нужны переменные окружения: " +
      "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL/SUPABASE_SERVICE_KEY и ATLASSIAN_MCP_URL."
    );
  }

  if (command.action === "list") {
    const epics = await listEpicMonitoring(workspace.id);
    if (epics.length === 0) {
      return "Сейчас на мониторинге нет ни одного эпика.";
    }
    const lines = epics.map((epic) => {
      const summary = epic.epic_summary ? ` — ${epic.epic_summary}` : "";
      const pausedMark = epic.status === "active" ? "" : " (на паузе)";
      const intervalLabel = formatPollIntervalLabel(resolveEpicPollIntervalMs(epic));
      return `• ${epic.epic_key}${summary}${pausedMark} · ${intervalLabel}`;
    });
    return `На мониторинге (${epics.length}):\n${lines.join("\n")}`;
  }

  if (command.action === "set_interval") {
    if (!command.epicKey || command.pollIntervalMs === undefined) {
      return "Уточните эпик и интервал, например: «измени интервал MNT-14980 на раз в сутки».";
    }
    try {
      const result = await setEpicMonitoringPollInterval(
        workspace.id,
        command.epicKey,
        command.pollIntervalMs,
      );
      const intervalLabel = formatPollIntervalLabel(result.pollIntervalMs);
      return `Интервал для ${command.epicKey}: ${intervalLabel}. Подтверждение отправил в Telegram.`;
    } catch (intervalError) {
      const message =
        intervalError instanceof Error ? intervalError.message : String(intervalError);
      return message;
    }
  }

  if (command.action === "unregister") {
    if (!command.epicKey) {
      return "Уточните ключ эпика, который нужно снять с мониторинга (например, MNT-14980).";
    }
    const removed = await unregisterEpicMonitoring(workspace.id, command.epicKey);
    return removed
      ? `Снял ${command.epicKey} с мониторинга.`
      : `${command.epicKey} не был на мониторинге.`;
  }

  if (!command.epicKey) {
    return "Уточните ссылку или ключ эпика Jira (например, MNT-14980).";
  }
  const jiraBaseUrl = command.jiraBaseUrl ?? getJiraBaseUrl();
  const pollIntervalMs = command.pollIntervalMs ?? getDefaultPollIntervalMs();
  const intervalLabel = formatPollIntervalLabel(pollIntervalMs);
  try {
    const result = await registerEpicMonitoring(
      workspace.id,
      command.epicKey,
      jiraBaseUrl,
      pollIntervalMs,
    );
    const summarySuffix = result.epicSummary ? ` («${result.epicSummary}»)` : "";
    return (
      `Поставил ${command.epicKey}${summarySuffix} на мониторинг: ${result.childCount} задач(и). ` +
      `Проверка: ${intervalLabel}. Уведомления в Telegram: статусы, новые задачи, исполнитель/резолюция. ` +
      "Подтверждение отправил в Telegram."
    );
  } catch (registerError) {
    const message =
      registerError instanceof Error ? registerError.message : String(registerError);
    return `Не удалось поставить ${command.epicKey} на мониторинг: ${message}`;
  }
}

async function respondToMonitoringCommand(
  response: express.Response,
  sessionId: string,
  workspace: WorkspaceEntry,
  modelId: string,
  command: MonitoringCommand,
): Promise<void> {
  beginMonitoringSseResponse(response, sessionId, workspace, modelId);
  try {
    const replyText = await resolveMonitoringCommandReply(workspace, command);
    writeSseDataLine(response, { kind: "assistant_text", text: replyText });
    writeSseDataLine(response, {
      kind: "run_finished",
      status: "completed",
      runId: `monitor-${Date.now()}`,
    });
  } catch (commandError) {
    const message =
      commandError instanceof Error ? commandError.message : String(commandError);
    logServerMessage(`monitoring command failed: ${message}`);
    writeSseDataLine(response, { kind: "error", message, sessionId });
  } finally {
    response.end();
  }
}

application.post("/api/chat", async (request, response) => {
  const sessionId = normalizeSessionId(request.body?.sessionId);
  const workspace = resolveWorkspace(request.body?.workspaceId);
  const userMessageText = typeof request.body?.message === "string" ? request.body.message : "";
  const responseMode = parseChatResponseMode(request.body?.responseMode);
  const attachments = parseClientAttachments(request.body?.attachments);
  const resolvedModelId = await resolveModelIdForRequest(response, request.body?.modelId);
  if (!resolvedModelId) {
    return;
  }

  if (!userMessageText.trim() && attachments.length === 0) {
    response.status(400).json({ error: "Нужен текст сообщения и/или вложения." });
    return;
  }

  const monitoringCommand =
    attachments.length === 0 ? parseMonitoringCommand(userMessageText) : null;
  if (monitoringCommand) {
    logServerMessage(
      `session ${sessionId} monitoring command: ${monitoringCommand.action} ${monitoringCommand.epicKey ?? ""}`.trim(),
    );
    await respondToMonitoringCommand(
      response,
      sessionId,
      workspace,
      resolvedModelId,
      monitoringCommand,
    );
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

  const isClientStillConnected = (): boolean =>
    clientStillConnected && !response.writableEnded && !cancelledChatSessions.has(sessionId);

  const chatRunStartedAtMs = Date.now();
  const activityHeartbeatTimer = setInterval(() => {
    if (!isClientStillConnected()) {
      return;
    }
    writeSseDataLine(response, {
      kind: "heartbeat",
      elapsedMs: Date.now() - chatRunStartedAtMs,
    });
  }, 12000);

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
    clearInterval(activityHeartbeatTimer);
    clearChatCancellationState(sessionId);
    releaseChatTurnLocks(sessionId, workspace.id);
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

let monitoringPollInFlight = false;

async function runMonitoringPollCycle(): Promise<void> {
  if (monitoringPollInFlight) {
    return;
  }
  monitoringPollInFlight = true;
  try {
    const results = await pollDueActiveEpics();
    const polledEpics = results.filter((entry) => !entry.skipped);
    const epicsWithChanges = polledEpics.filter((entry) => entry.changes > 0);
    const failedEpics = polledEpics.filter((entry) => entry.error);
    if (epicsWithChanges.length > 0 || failedEpics.length > 0) {
      logServerMessage(
        `monitor poll: due=${polledEpics.length} changed=${epicsWithChanges.length} failed=${failedEpics.length}`,
      );
    }
    for (const failed of failedEpics) {
      logServerMessage(`monitor poll error ${failed.epicKey}: ${failed.error}`);
    }
  } catch (pollError) {
    logServerMessage(
      `monitor poll cycle failed: ${pollError instanceof Error ? pollError.message : String(pollError)}`,
    );
  } finally {
    monitoringPollInFlight = false;
  }
}

function startMonitoringScheduler(): void {
  if (!isMonitoringEnabled()) {
    logServerMessage("Jira monitoring: disabled (нет Telegram/Supabase/Atlassian MCP)");
    return;
  }
  const defaultIntervalLabel = formatPollIntervalLabel(getDefaultPollIntervalMs());
  logServerMessage(
    `Jira monitoring: enabled (tick ${Math.round(MONITOR_TICK_MS / 1000)}s, default interval ${defaultIntervalLabel})`,
  );
  const monitoringTimer = setInterval(() => {
    void runMonitoringPollCycle();
  }, MONITOR_TICK_MS);
  monitoringTimer.unref?.();
}

startMonitoringScheduler();

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

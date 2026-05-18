import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
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
  type SDKMessage,
  type SDKToolUseMessage,
} from "@cursor/sdk";

const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
const publicDirPath = path.join(currentDirPath, "..", "public");

const SESSION_IDLE_DISPOSE_MS = Number.parseInt(
  process.env.SESSION_IDLE_DISPOSE_MS || String(30 * 60 * 1000),
  10,
);

const application = express();
application.disable("x-powered-by");
application.use(express.json({ limit: "512kb" }));

const basicAuthUser = process.env.CHAT_BASIC_USER?.trim();
const basicAuthPassword = process.env.CHAT_BASIC_PASSWORD?.trim();

interface ChatSessionRecord {
  agent: SDKAgent;
  busy: boolean;
  lastActivityAt: number;
  idleDisposeTimer: ReturnType<typeof setTimeout> | undefined;
}

const chatSessions = new Map<string, ChatSessionRecord>();

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
  return convertError(error) instanceof AgentBusyError;
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

  mergeMcpServersFromJsonEnv(servers);

  return Object.keys(servers).length > 0 ? servers : undefined;
}

async function createChatAgent(): Promise<SDKAgent> {
  const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
  const agentWorkingDirectory = readRequiredEnvironmentVariable("AGENT_CWD");
  const modelId = process.env.CURSOR_MODEL_ID?.trim() || "composer-2";
  const mcpServers = buildMcpServersConfiguration();

  return Agent.create({
    apiKey,
    model: { id: modelId },
    local: {
      cwd: agentWorkingDirectory,
      settingSources: [],
    },
    ...(mcpServers ? { mcpServers } : {}),
  });
}

function clearSessionIdleTimer(sessionRecord: ChatSessionRecord): void {
  if (sessionRecord.idleDisposeTimer !== undefined) {
    clearTimeout(sessionRecord.idleDisposeTimer);
    sessionRecord.idleDisposeTimer = undefined;
  }
}

function scheduleSessionIdleDispose(sessionId: string, sessionRecord: ChatSessionRecord): void {
  clearSessionIdleTimer(sessionRecord);
  sessionRecord.idleDisposeTimer = setTimeout(() => {
    void disposeChatSession(sessionId, "idle timeout");
  }, SESSION_IDLE_DISPOSE_MS);
}

function touchSessionActivity(sessionRecord: ChatSessionRecord): void {
  sessionRecord.lastActivityAt = Date.now();
}

async function disposeChatSession(sessionId: string, reason: string): Promise<void> {
  const sessionRecord = chatSessions.get(sessionId);
  if (!sessionRecord) {
    return;
  }
  chatSessions.delete(sessionId);
  clearSessionIdleTimer(sessionRecord);
  try {
    await sessionRecord.agent[Symbol.asyncDispose]();
    logServerMessage(`session ${sessionId} disposed (${reason})`);
  } catch (disposeError) {
    logServerMessage(
      `session ${sessionId} dispose failed (${reason}): ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
    );
  }
}

async function getOrCreateChatSession(sessionId: string): Promise<ChatSessionRecord> {
  const existing = chatSessions.get(sessionId);
  if (existing) {
    touchSessionActivity(existing);
    clearSessionIdleTimer(existing);
    return existing;
  }
  const agent = await createChatAgent();
  const sessionRecord: ChatSessionRecord = {
    agent,
    busy: false,
    lastActivityAt: Date.now(),
    idleDisposeTimer: undefined,
  };
  chatSessions.set(sessionId, sessionRecord);
  logServerMessage(`session ${sessionId} created (agent ${agent.agentId})`);
  return sessionRecord;
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

async function streamAgentRunToClient(
  agentRun: Run,
  response: express.Response,
  isClientStillConnected: () => boolean,
): Promise<void> {
  for await (const streamMessage of agentRun.stream()) {
    if (!isClientStillConnected()) {
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
    const clientPayload = describeStreamMessageForClient(streamMessage);
    if (clientPayload) {
      writeSseDataLine(response, clientPayload);
    }
  }

  if (!isClientStillConnected()) {
    return;
  }

  const terminalResult = await agentRun.wait();
  writeSseDataLine(response, {
    kind: "run_finished",
    status: terminalResult.status,
    result: terminalResult.result,
    runId: agentRun.id,
  });
}

async function executeChatMessageForSession(
  sessionId: string,
  response: express.Response,
  userMessageText: string,
  isClientStillConnected: () => boolean,
  options: { forceLocalRun: boolean; recreateSession: boolean },
): Promise<void> {
  if (options.recreateSession) {
    await disposeChatSession(sessionId, "recreate before retry");
  }

  const sessionRecord = await getOrCreateChatSession(sessionId);
  const sendOptions = options.forceLocalRun ? { local: { force: true } } : undefined;
  const agentRun = await sessionRecord.agent.send(userMessageText, sendOptions);
  await streamAgentRunToClient(agentRun, response, isClientStillConnected);
}

application.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    activeSessions: chatSessions.size,
    busySessions: [...chatSessions.values()].filter((record) => record.busy).length,
  });
});

application.use(optionalBasicAuthMiddleware);

application.post("/api/chat", async (request, response) => {
  const sessionId = normalizeSessionId(request.body?.sessionId);
  const userMessageText = typeof request.body?.message === "string" ? request.body.message : "";

  if (!userMessageText.trim()) {
    response.status(400).json({ error: 'Field "message" must be a non-empty string.' });
    return;
  }

  const existingSession = chatSessions.get(sessionId);
  if (existingSession?.busy) {
    response.status(429).json({
      error: "Этот диалог ещё обрабатывает предыдущее сообщение. Дождитесь ответа.",
      sessionId,
    });
    return;
  }

  const sessionRecord = existingSession ?? (await getOrCreateChatSession(sessionId));
  sessionRecord.busy = true;
  touchSessionActivity(sessionRecord);
  clearSessionIdleTimer(sessionRecord);

  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Chat-Session-Id", sessionId);
  response.flushHeaders?.();

  writeSseDataLine(response, { kind: "session", sessionId });

  let clientStillConnected = true;
  request.on("close", () => {
    clientStillConnected = false;
  });

  const isClientStillConnected = (): boolean => clientStillConnected && !response.writableEnded;

  try {
    try {
      await executeChatMessageForSession(sessionId, response, userMessageText, isClientStillConnected, {
        forceLocalRun: false,
        recreateSession: false,
      });
    } catch (firstAttemptError) {
      const normalizedError = normalizeThrownError(firstAttemptError);
      const shouldRecreateSession = isAuthenticationFailure(firstAttemptError);
      const shouldForceLocalRun = isAgentBusyFailure(firstAttemptError);

      if (!shouldRecreateSession && !shouldForceLocalRun) {
        throw normalizedError;
      }

      logServerMessage(
        `session ${sessionId} retry: recreate=${shouldRecreateSession} force=${shouldForceLocalRun} (${normalizedError.message})`,
      );

      if (!isClientStillConnected()) {
        return;
      }

      await executeChatMessageForSession(sessionId, response, userMessageText, isClientStillConnected, {
        forceLocalRun: shouldForceLocalRun || shouldRecreateSession,
        recreateSession: shouldRecreateSession,
      });
    }

    if (isClientStillConnected()) {
      response.end();
    }
  } catch (error) {
    const normalizedError = normalizeThrownError(error);
    if (isAuthenticationFailure(error)) {
      await disposeChatSession(sessionId, "authentication failure");
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
    const updatedSession = chatSessions.get(sessionId);
    if (updatedSession) {
      updatedSession.busy = false;
      touchSessionActivity(updatedSession);
      scheduleSessionIdleDispose(sessionId, updatedSession);
    }
  }
});

application.post("/api/new-chat", async (request, response) => {
  const previousSessionId =
    typeof request.body?.sessionId === "string" ? normalizeSessionId(request.body.sessionId) : undefined;

  if (previousSessionId) {
    const previousSession = chatSessions.get(previousSessionId);
    if (previousSession?.busy) {
      response.status(429).json({ error: "Дождитесь окончания текущего ответа." });
      return;
    }
    await disposeChatSession(previousSessionId, "new chat requested");
  }

  const newSessionId = randomUUID();
  response.json({ ok: true, sessionId: newSessionId });
});

application.post("/api/reset-agent", async (request, response) => {
  const sessionId =
    typeof request.body?.sessionId === "string" ? normalizeSessionId(request.body.sessionId) : undefined;

  if (sessionId) {
    const sessionRecord = chatSessions.get(sessionId);
    if (sessionRecord?.busy) {
      response.status(429).json({ error: "Дождитесь окончания текущего ответа." });
      return;
    }
    await disposeChatSession(sessionId, "manual reset");
    response.json({ ok: true, sessionId, disposed: true });
    return;
  }

  const sessionIds = [...chatSessions.keys()];
  for (const id of sessionIds) {
    const record = chatSessions.get(id);
    if (record?.busy) {
      response.status(429).json({ error: `Сессия ${id} занята. Повторите позже.` });
      return;
    }
  }
  for (const id of sessionIds) {
    await disposeChatSession(id, "reset all");
  }
  response.json({ ok: true, disposedSessions: sessionIds.length });
});

application.use(express.static(publicDirPath));

const listenPort = Number.parseInt(process.env.PORT || "3847", 10);

application.listen(listenPort, () => {
  logServerMessage(`listening on http://0.0.0.0:${listenPort}`);
});

async function disposeAllSessionsOnShutdown(): Promise<void> {
  const sessionIds = [...chatSessions.keys()];
  for (const sessionId of sessionIds) {
    await disposeChatSession(sessionId, "shutdown");
  }
}

process.on("SIGINT", () => {
  void disposeAllSessionsOnShutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void disposeAllSessionsOnShutdown().finally(() => process.exit(0));
});

process.on("unhandledRejection", (reason) => {
  logServerMessage(
    `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  if (isAuthenticationFailure(reason)) {
    const sessionIds = [...chatSessions.keys()];
    for (const sessionId of sessionIds) {
      void disposeChatSession(sessionId, "unhandled auth rejection");
    }
  }
});

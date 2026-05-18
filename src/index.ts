import "dotenv/config";
import express from "express";
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

const application = express();
application.disable("x-powered-by");
application.use(express.json({ limit: "512kb" }));

const basicAuthUser = process.env.CHAT_BASIC_USER?.trim();
const basicAuthPassword = process.env.CHAT_BASIC_PASSWORD?.trim();

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

application.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    agentLoaded: Boolean(sharedChatAgent),
    chatRequestInFlight,
  });
});

application.use(optionalBasicAuthMiddleware);

let sharedChatAgent: SDKAgent | undefined;
let chatRequestInFlight = false;

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

async function disposeSharedChatAgentSilently(): Promise<void> {
  if (!sharedChatAgent) {
    return;
  }
  const agentToDispose = sharedChatAgent;
  sharedChatAgent = undefined;
  try {
    await agentToDispose[Symbol.asyncDispose]();
  } catch (disposeError) {
    logServerMessage(
      `dispose agent failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
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
    throw new Error("MCP_EXTRA_JSON должен быть JSON-объектом вида {\"имя_сервера\": { ... }}");
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

async function getOrCreateSharedChatAgent(): Promise<SDKAgent> {
  if (sharedChatAgent) {
    return sharedChatAgent;
  }
  const apiKey = readRequiredEnvironmentVariable("CURSOR_API_KEY");
  const agentWorkingDirectory = readRequiredEnvironmentVariable("AGENT_CWD");
  const modelId = process.env.CURSOR_MODEL_ID?.trim() || "composer-2";
  const mcpServers = buildMcpServersConfiguration();

  sharedChatAgent = await Agent.create({
    apiKey,
    model: { id: modelId },
    local: {
      cwd: agentWorkingDirectory,
      settingSources: [],
    },
    ...(mcpServers ? { mcpServers } : {}),
  });
  return sharedChatAgent;
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
            `cancel after client disconnect failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
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

async function executeChatMessage(
  response: express.Response,
  userMessageText: string,
  isClientStillConnected: () => boolean,
  options: { forceLocalRun: boolean; recreateAgentFirst: boolean },
): Promise<void> {
  if (options.recreateAgentFirst) {
    await disposeSharedChatAgentSilently();
  }

  const chatAgent = await getOrCreateSharedChatAgent();
  const sendOptions = options.forceLocalRun ? { local: { force: true } } : undefined;
  const agentRun = await chatAgent.send(userMessageText, sendOptions);
  await streamAgentRunToClient(agentRun, response, isClientStillConnected);
}

application.post("/api/chat", async (request, response) => {
  if (chatRequestInFlight) {
    response.status(429).json({
      error: "Another message is still being processed. Wait for it to finish.",
    });
    return;
  }

  const userMessageText = typeof request.body?.message === "string" ? request.body.message : "";
  if (!userMessageText.trim()) {
    response.status(400).json({ error: "Field \"message\" must be a non-empty string." });
    return;
  }

  chatRequestInFlight = true;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  let clientStillConnected = true;
  request.on("close", () => {
    clientStillConnected = false;
  });

  const isClientStillConnected = (): boolean => clientStillConnected && !response.writableEnded;

  try {
    try {
      await executeChatMessage(response, userMessageText, isClientStillConnected, {
        forceLocalRun: false,
        recreateAgentFirst: false,
      });
    } catch (firstAttemptError) {
      const normalizedError = normalizeThrownError(firstAttemptError);
      const shouldRecreateAgent = isAuthenticationFailure(firstAttemptError);
      const shouldForceLocalRun = isAgentBusyFailure(firstAttemptError);

      if (!shouldRecreateAgent && !shouldForceLocalRun) {
        throw normalizedError;
      }

      logServerMessage(
        `chat retry: recreateAgent=${shouldRecreateAgent} forceLocal=${shouldForceLocalRun} reason=${normalizedError.message}`,
      );

      if (!isClientStillConnected()) {
        return;
      }

      await executeChatMessage(response, userMessageText, isClientStillConnected, {
        forceLocalRun: shouldForceLocalRun || shouldRecreateAgent,
        recreateAgentFirst: shouldRecreateAgent,
      });
    }
    if (isClientStillConnected()) {
      response.end();
    }
  } catch (error) {
    const normalizedError = normalizeThrownError(error);
    if (isAuthenticationFailure(error)) {
      await disposeSharedChatAgentSilently();
    }
    if (isAgentBusyFailure(error)) {
      logServerMessage("agent busy after failed run; next message will use force or call /api/reset-agent");
    }
    logServerMessage(`chat failed: ${normalizedError.message}`);
    if (isClientStillConnected()) {
      const cursorAgentError = normalizedError instanceof CursorAgentError ? normalizedError : undefined;
      writeSseDataLine(response, {
        kind: "error",
        message: normalizedError.message,
        isRetryable: cursorAgentError?.isRetryable ?? false,
        hint: isAuthenticationFailure(error)
          ? "Проверьте CURSOR_API_KEY в .env. Агент в памяти сброшен; pm2 restart обычно не нужен."
          : undefined,
      });
      response.end();
    }
  } finally {
    chatRequestInFlight = false;
  }
});

application.post("/api/reset-agent", async (_request, response) => {
  if (chatRequestInFlight) {
    response.status(429).json({ error: "Wait until the current message finishes." });
    return;
  }
  await disposeSharedChatAgentSilently();
  response.json({ ok: true, detail: sharedChatAgent ? "still loaded" : "agent disposed" });
});

application.use(express.static(publicDirPath));

const listenPort = Number.parseInt(process.env.PORT || "3847", 10);

application.listen(listenPort, () => {
  // eslint-disable-next-line no-console -- minimal server bootstrap log
  console.log(`cursor-sdk-chat-gateway listening on http://0.0.0.0:${listenPort}`);
});

async function disposeSharedAgentOnShutdown(): Promise<void> {
  if (!sharedChatAgent) {
    return;
  }
  const agentToDispose = sharedChatAgent;
  sharedChatAgent = undefined;
  await agentToDispose[Symbol.asyncDispose]();
}

process.on("SIGINT", () => {
  void disposeSharedAgentOnShutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void disposeSharedAgentOnShutdown().finally(() => process.exit(0));
});

process.on("unhandledRejection", (reason) => {
  logServerMessage(
    `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  chatRequestInFlight = false;
  if (isAuthenticationFailure(reason)) {
    void disposeSharedChatAgentSilently();
  }
});

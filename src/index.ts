import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent,
  CursorAgentError,
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
  response.json({ status: "ok" });
});

application.use(optionalBasicAuthMiddleware);

let sharedChatAgent: SDKAgent | undefined;
let chatRequestInFlight = false;

function readRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildMcpServersConfiguration():
  | Record<
      string,
      {
        type: "http";
        url: string;
        headers: Record<string, string>;
      }
    >
  | undefined {
  const atlassianMcpBaseUrl = process.env.ATLASSIAN_MCP_URL?.trim();
  const atlassianMcpApiKey = process.env.ATLASSIAN_MCP_API_KEY?.trim();
  if (!atlassianMcpBaseUrl && !atlassianMcpApiKey) {
    return undefined;
  }
  if (!atlassianMcpBaseUrl || !atlassianMcpApiKey) {
    throw new Error(
      "Set both ATLASSIAN_MCP_URL and ATLASSIAN_MCP_API_KEY, or omit both to run without MCP.",
    );
  }
  return {
    atlassian: {
      type: "http",
      url: atlassianMcpBaseUrl,
      headers: { "X-API-Key": atlassianMcpApiKey },
    },
  };
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

  try {
    const chatAgent = await getOrCreateSharedChatAgent();
    const agentRun = await chatAgent.send(userMessageText);

    for await (const streamMessage of agentRun.stream()) {
      const clientPayload = describeStreamMessageForClient(streamMessage);
      if (clientPayload) {
        writeSseDataLine(response, clientPayload);
      }
    }

    const terminalResult = await agentRun.wait();
    writeSseDataLine(response, {
      kind: "run_finished",
      status: terminalResult.status,
      result: terminalResult.result,
      runId: agentRun.id,
    });
    response.end();
  } catch (error) {
    const errorMessage =
      error instanceof CursorAgentError ? error.message : error instanceof Error ? error.message : String(error);
    const isRetryable = error instanceof CursorAgentError ? error.isRetryable : false;
    writeSseDataLine(response, {
      kind: "error",
      message: errorMessage,
      isRetryable,
    });
    response.end();
  } finally {
    chatRequestInFlight = false;
  }
});

application.post("/api/reset-agent", async (_request, response) => {
  if (chatRequestInFlight) {
    response.status(429).json({ error: "Wait until the current message finishes." });
    return;
  }
  if (!sharedChatAgent) {
    response.json({ ok: true, detail: "No agent was loaded yet." });
    return;
  }
  const agentToDispose = sharedChatAgent;
  sharedChatAgent = undefined;
  await agentToDispose[Symbol.asyncDispose]();
  response.json({ ok: true });
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

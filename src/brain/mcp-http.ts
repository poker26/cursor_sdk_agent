export interface McpHttpServerConfig {
  url: string;
  apiKey: string;
}

interface McpJsonRpcEnvelope {
  result?: {
    sessionId?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { message?: string };
}

export function loadMcpHttpServersFromEnv(): Record<string, McpHttpServerConfig> {
  const servers: Record<string, McpHttpServerConfig> = {};
  const entries: Array<[string, string | undefined, string | undefined]> = [
    ["atlassian", process.env.ATLASSIAN_MCP_URL, process.env.ATLASSIAN_MCP_API_KEY],
    ["gitlab", process.env.GITLAB_MCP_URL, process.env.GITLAB_MCP_API_KEY],
    ["exchange_work", process.env.EXCHANGE_MCP_URL, process.env.EXCHANGE_MCP_API_KEY],
  ];
  for (const [label, url, apiKey] of entries) {
    const trimmedUrl = url?.trim();
    const trimmedKey = apiKey?.trim();
    if (trimmedUrl && trimmedKey) {
      servers[label] = { url: trimmedUrl, apiKey: trimmedKey };
    }
  }
  return servers;
}

let mcpSessionIds: Record<string, string> = {};

function isServerSentEventsBody(rawText: string, contentType: string): boolean {
  if (contentType.includes("text/event-stream")) {
    return true;
  }
  const trimmed = rawText.trimStart();
  return trimmed.startsWith("event:") || trimmed.includes("\ndata:");
}

function parseServerSentEventsToJsonObjects(rawText: string): McpJsonRpcEnvelope[] {
  const envelopes: McpJsonRpcEnvelope[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const dataPayload = line.slice(5).trim();
    if (!dataPayload || dataPayload === "[DONE]") {
      continue;
    }
    try {
      envelopes.push(JSON.parse(dataPayload) as McpJsonRpcEnvelope);
    } catch {
      /* skip non-json data lines */
    }
  }
  return envelopes;
}

async function parseMcpHttpResponse(response: Response): Promise<McpJsonRpcEnvelope> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawText = await response.text();

  let envelope: McpJsonRpcEnvelope | undefined;
  if (isServerSentEventsBody(rawText, contentType)) {
    const envelopes = parseServerSentEventsToJsonObjects(rawText);
    envelope = envelopes.find((item) => item.result !== undefined || item.error !== undefined);
  } else {
    envelope = JSON.parse(rawText) as McpJsonRpcEnvelope;
  }

  if (!envelope) {
    throw new Error(`MCP empty response: ${rawText.slice(0, 200)}`);
  }
  if (envelope.error) {
    throw new Error(envelope.error.message ?? "MCP JSON-RPC error");
  }
  return envelope;
}

function extractToolResultPayload(envelope: McpJsonRpcEnvelope): unknown {
  const textParts =
    envelope.result?.content
      ?.filter((block) => block.type === "text" && block.text)
      .map((block) => block.text ?? "") ?? [];
  if (textParts.length === 0) {
    return envelope.result;
  }
  const combinedText = textParts.join("\n");
  try {
    return JSON.parse(combinedText);
  } catch {
    return combinedText;
  }
}

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

export async function callMcpTool(
  serverLabel: string,
  toolName: string,
  argumentsPayload: Record<string, unknown>,
): Promise<unknown> {
  const servers = loadMcpHttpServersFromEnv();
  const serverConfig = servers[serverLabel];
  if (!serverConfig) {
    throw new Error(`MCP server "${serverLabel}" is not configured in environment.`);
  }

  const baseUrl = serverConfig.url.replace(/\/$/, "");
  let sessionId = mcpSessionIds[serverLabel];
  if (!sessionId) {
    const initResponse = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
        "X-API-Key": serverConfig.apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cursor-sdk-brain-ingest", version: "1.0.0" },
        },
      }),
    });
    if (!initResponse.ok) {
      const initErrorBody = await initResponse.text();
      throw new Error(
        `MCP initialize failed (${serverLabel}): ${initResponse.status} ${initErrorBody.slice(0, 200)}`,
      );
    }
    const sessionHeader =
      initResponse.headers.get("mcp-session-id") ??
      initResponse.headers.get("Mcp-Session-Id");
    const initEnvelope = await parseMcpHttpResponse(initResponse);
    sessionId = sessionHeader ?? initEnvelope.result?.sessionId ?? "default";
    mcpSessionIds[serverLabel] = sessionId;
    await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT_HEADER,
        "X-API-Key": serverConfig.apiKey,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  }

  const toolResponse = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT_HEADER,
      "X-API-Key": serverConfig.apiKey,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argumentsPayload,
      },
    }),
  });
  if (!toolResponse.ok) {
    const errorBody = await toolResponse.text();
    throw new Error(`MCP tools/call ${toolResponse.status}: ${errorBody.slice(0, 400)}`);
  }

  const toolEnvelope = await parseMcpHttpResponse(toolResponse);
  return extractToolResultPayload(toolEnvelope);
}

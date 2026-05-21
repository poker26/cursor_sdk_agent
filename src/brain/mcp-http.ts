export interface McpHttpServerConfig {
  url: string;
  apiKey: string;
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
        Accept: "application/json, text/event-stream",
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
      throw new Error(`MCP initialize failed: ${initResponse.status}`);
    }
    const initJson = (await initResponse.json()) as {
      result?: { sessionId?: string };
    };
    sessionId = initJson.result?.sessionId ?? "default";
    mcpSessionIds[serverLabel] = sessionId;
    await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
      Accept: "application/json",
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
  const toolJson = (await toolResponse.json()) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    error?: { message?: string };
  };
  if (toolJson.error) {
    throw new Error(toolJson.error.message ?? "MCP tool error");
  }
  const textParts =
    toolJson.result?.content
      ?.filter((block) => block.type === "text" && block.text)
      .map((block) => block.text ?? "") ?? [];
  if (textParts.length === 0) {
    return toolJson.result;
  }
  const combinedText = textParts.join("\n");
  try {
    return JSON.parse(combinedText);
  } catch {
    return combinedText;
  }
}

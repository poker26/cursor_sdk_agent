import path from "node:path";

export interface WorkspaceEntry {
  id: string;
  label: string;
  path: string;
}

export function loadWorkspaceRegistryFromEnv(): WorkspaceEntry[] {
  const rawJson = process.env.AGENT_WORKSPACES_JSON?.trim();
  if (rawJson) {
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(rawJson) as unknown;
    } catch {
      throw new Error("AGENT_WORKSPACES_JSON: некорректный JSON.");
    }
    if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
      throw new Error('AGENT_WORKSPACES_JSON: ожидается объект {"id":"/abs/path", ...}.');
    }
    const entries: WorkspaceEntry[] = [];
    for (const [workspaceId, pathValue] of Object.entries(parsedValue as Record<string, unknown>)) {
      if (typeof pathValue !== "string" || !pathValue.trim()) {
        throw new Error(`AGENT_WORKSPACES_JSON: пустой путь для "${workspaceId}".`);
      }
      entries.push({
        id: workspaceId,
        label: workspaceId,
        path: path.resolve(pathValue.trim()),
      });
    }
    if (entries.length === 0) {
      throw new Error("AGENT_WORKSPACES_JSON: пустой объект.");
    }
    return entries;
  }

  const singlePath = process.env.AGENT_CWD?.trim();
  if (!singlePath) {
    throw new Error("Задайте AGENT_CWD или AGENT_WORKSPACES_JSON.");
  }
  return [{ id: "default", label: "default", path: path.resolve(singlePath) }];
}

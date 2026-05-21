import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirPath = path.dirname(fileURLToPath(import.meta.url));
const dataDirectoryPath = path.join(currentDirPath, "..", "data");
const workspaceStateFilePath = path.join(dataDirectoryPath, "workspace-state.json");

export interface WorkspacePersistedState {
  agentId: string;
  updatedAt: string;
}

export interface WorkspaceStateFile {
  workspaces: Record<string, WorkspacePersistedState>;
}

export function isPersistAgentIdEnabled(): boolean {
  const rawValue = process.env.PERSIST_AGENT_ID?.trim().toLowerCase();
  if (!rawValue) {
    return true;
  }
  return rawValue !== "false" && rawValue !== "0";
}

async function readWorkspaceStateFile(): Promise<WorkspaceStateFile> {
  try {
    const rawJson = await fs.readFile(workspaceStateFilePath, "utf8");
    const parsed = JSON.parse(rawJson) as WorkspaceStateFile;
    if (parsed && typeof parsed.workspaces === "object" && parsed.workspaces !== null) {
      return parsed;
    }
  } catch {
    /* first run */
  }
  return { workspaces: {} };
}

async function writeWorkspaceStateFile(stateFile: WorkspaceStateFile): Promise<void> {
  await fs.mkdir(dataDirectoryPath, { recursive: true });
  await fs.writeFile(workspaceStateFilePath, `${JSON.stringify(stateFile, null, 2)}\n`, "utf8");
}

export async function loadPersistedAgentId(workspaceId: string): Promise<string | undefined> {
  if (!isPersistAgentIdEnabled()) {
    return undefined;
  }
  const stateFile = await readWorkspaceStateFile();
  return stateFile.workspaces[workspaceId]?.agentId;
}

export async function savePersistedAgentId(
  workspaceId: string,
  agentId: string,
): Promise<void> {
  if (!isPersistAgentIdEnabled()) {
    return;
  }
  const stateFile = await readWorkspaceStateFile();
  stateFile.workspaces[workspaceId] = {
    agentId,
    updatedAt: new Date().toISOString(),
  };
  await writeWorkspaceStateFile(stateFile);
}

export async function clearPersistedAgentId(workspaceId: string): Promise<void> {
  const stateFile = await readWorkspaceStateFile();
  delete stateFile.workspaces[workspaceId];
  await writeWorkspaceStateFile(stateFile);
}

import { readMemoryFile, buildMemoryPromptPrefix } from "../memory.js";
import { loadWorkspaceContext } from "./supabase-brain.js";
import { searchQdrantBrain } from "./qdrant-brain.js";
import { isQdrantBrainEnabled, isSupabaseBrainEnabled } from "./config.js";

export interface BrainContextBuildInput {
  workspaceId: string;
  workspacePath: string;
  userMessageText: string;
}

export async function buildBrainContextPrefix(
  input: BrainContextBuildInput,
): Promise<string> {
  const sections: string[] = [];

  const memoryContent = await readMemoryFile(input.workspacePath);
  const memoryPrefix = buildMemoryPromptPrefix(memoryContent);
  if (memoryPrefix) {
    sections.push(memoryPrefix.trimEnd());
  }

  if (isSupabaseBrainEnabled()) {
    try {
      const workspaceContext = await loadWorkspaceContext(input.workspaceId);
      if (workspaceContext?.compiled_summary?.trim()) {
        sections.push(
          `[Brain Supabase — сводка]\n${workspaceContext.compiled_summary.trim()}`,
        );
      }
      if (workspaceContext?.current_focus?.trim()) {
        sections.push(
          `[Текущий фокус]\n${workspaceContext.current_focus.trim()}`,
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  if (isQdrantBrainEnabled() && input.userMessageText.trim()) {
    try {
      const hits = await searchQdrantBrain(
        input.workspaceId,
        input.userMessageText,
        Number.parseInt(process.env.QDRANT_TOP_K || "6", 10),
      );
      if (hits.length > 0) {
        const hitLines = hits.map(
          (hit, index) =>
            `${index + 1}. (${hit.source}, score=${hit.score.toFixed(3)})\n${hit.text}`,
        );
        sections.push(
          `[Релевантная память из brain — Qdrant]\n${hitLines.join("\n\n")}`,
        );
      }
    } catch {
      /* non-fatal */
    }
  }

  if (sections.length === 0) {
    return "";
  }
  return `${sections.join("\n\n")}\n\n---\n\n`;
}

export function summarizeForMemoryLog(text: string, maxLength = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}…`;
}

import { appendMemorySessionLog } from "../memory.js";
import { extractCompiledSummaryFromMemoryMarkdown, importMemoryMarkdownToSupabase, insertBrainEvent, upsertWorkspaceContextSummary } from "./supabase-brain.js";
import { backfillQdrantFromTexts } from "./qdrant-brain.js";
import { isQdrantBrainEnabled, isSupabaseBrainEnabled } from "./config.js";
import { readMemoryFile } from "../memory.js";
import { summarizeForMemoryLog } from "./context-builder.js";

export interface PostRunBrainInput {
  workspaceId: string;
  workspacePath: string;
  userMessageText: string;
  assistantMessageText: string;
  runId?: string;
  runStatus?: string;
}

export async function persistBrainAfterRun(input: PostRunBrainInput): Promise<void> {
  const userSummary = summarizeForMemoryLog(input.userMessageText, 1500);
  const assistantSummary = summarizeForMemoryLog(input.assistantMessageText, 2500);

  await appendMemorySessionLog(input.workspacePath, userSummary, assistantSummary);

  if (isSupabaseBrainEnabled()) {
    await insertBrainEvent({
      workspaceId: input.workspaceId,
      source: "chat_gateway",
      eventType: "chat_turn",
      title: userSummary.slice(0, 120) || "chat",
      payload: {
        user: userSummary,
        assistant: assistantSummary,
        run_id: input.runId ?? null,
        run_status: input.runStatus ?? null,
      },
    });

    const memoryMarkdown = await readMemoryFile(input.workspacePath);
    const compiledSummary = extractCompiledSummaryFromMemoryMarkdown(memoryMarkdown);
    await upsertWorkspaceContextSummary(input.workspaceId, compiledSummary);
  }

  if (isQdrantBrainEnabled()) {
    const combinedChunk = `User:\n${userSummary}\n\nAssistant:\n${assistantSummary}`;
    await backfillQdrantFromTexts(input.workspaceId, [
      { text: combinedChunk, source: "chat_turn" },
    ]);
  }
}

export async function importExistingMemoryToSupabaseOnce(
  workspaceId: string,
  workspacePath: string,
): Promise<void> {
  if (!isSupabaseBrainEnabled()) {
    return;
  }
  const memoryMarkdown = await readMemoryFile(workspacePath);
  await importMemoryMarkdownToSupabase(workspaceId, memoryMarkdown);
}

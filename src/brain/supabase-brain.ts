import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseBrainEnabled } from "./config.js";

export interface BrainEventInsert {
  workspaceId: string;
  source: string;
  eventType: string;
  title?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

export interface WorkspaceContextRow {
  workspace_id: string;
  current_focus: string | null;
  compiled_summary: string;
  updated_at: string;
}

let cachedSupabaseClient: SupabaseClient | undefined;

export function getSupabaseBrainClient(): SupabaseClient | undefined {
  if (!isSupabaseBrainEnabled()) {
    return undefined;
  }
  if (cachedSupabaseClient) {
    return cachedSupabaseClient;
  }
  const supabaseUrl = process.env.SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_KEY?.trim() ?? "";
  cachedSupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedSupabaseClient;
}

export async function insertBrainEvent(eventInsert: BrainEventInsert): Promise<void> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return;
  }
  const { error } = await client.from("events").insert({
    workspace_id: eventInsert.workspaceId,
    source: eventInsert.source,
    event_type: eventInsert.eventType,
    title: eventInsert.title ?? null,
    payload: eventInsert.payload ?? {},
    occurred_at: eventInsert.occurredAt ?? new Date().toISOString(),
  });
  if (error) {
    throw new Error(`Supabase events insert: ${error.message}`);
  }
}

export async function loadWorkspaceContext(
  workspaceId: string,
): Promise<WorkspaceContextRow | undefined> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return undefined;
  }
  const { data, error } = await client
    .from("workspace_context")
    .select("workspace_id, current_focus, compiled_summary, updated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) {
    throw new Error(`Supabase workspace_context read: ${error.message}`);
  }
  return data ?? undefined;
}

export async function upsertWorkspaceContextSummary(
  workspaceId: string,
  compiledSummary: string,
  currentFocus?: string,
): Promise<void> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return;
  }
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    compiled_summary: compiledSummary,
    updated_at: new Date().toISOString(),
  };
  if (currentFocus !== undefined) {
    row.current_focus = currentFocus;
  }
  const { error } = await client.from("workspace_context").upsert(row);
  if (error) {
    throw new Error(`Supabase workspace_context upsert: ${error.message}`);
  }
}

export async function clearWorkspaceBrain(workspaceId: string): Promise<void> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return;
  }
  await client.from("events").delete().eq("workspace_id", workspaceId);
  await client.from("facts").delete().eq("workspace_id", workspaceId);
  await client.from("relationships").delete().eq("workspace_id", workspaceId);
  await client.from("entities").delete().eq("workspace_id", workspaceId);
  await client.from("workspace_context").delete().eq("workspace_id", workspaceId);
}

export async function listRecentEventsForWorkspace(
  workspaceId: string,
  limit = 30,
): Promise<Array<{ id: string; title: string | null; payload: Record<string, unknown>; occurred_at: string; source: string }>> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return [];
  }
  const { data, error } = await client
    .from("events")
    .select("id, title, payload, occurred_at, source")
    .eq("workspace_id", workspaceId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Supabase events list: ${error.message}`);
  }
  return (data ?? []) as Array<{
    id: string;
    title: string | null;
    payload: Record<string, unknown>;
    occurred_at: string;
    source: string;
  }>;
}

export function extractCompiledSummaryFromMemoryMarkdown(memoryMarkdown: string): string {
  const chronologyIndex = memoryMarkdown.indexOf("### Хронология сессий");
  if (chronologyIndex === -1) {
    return memoryMarkdown.trim();
  }
  return memoryMarkdown.slice(0, chronologyIndex).trim();
}

export async function importMemoryMarkdownToSupabase(
  workspaceId: string,
  memoryMarkdown: string,
): Promise<{ eventsImported: number }> {
  const client = getSupabaseBrainClient();
  if (!client) {
    return { eventsImported: 0 };
  }

  const compiledSummary = extractCompiledSummaryFromMemoryMarkdown(memoryMarkdown);
  await upsertWorkspaceContextSummary(workspaceId, compiledSummary);

  const sessionHeadingPattern = /^## (\d{4}-\d{2}-\d{2}T[^\n]+)$/gm;
  const matches = [...memoryMarkdown.matchAll(sessionHeadingPattern)];
  let eventsImported = 0;

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = match[0];
    const occurredAt = match[1];
    const startIndex = (match.index ?? 0) + heading.length;
    const endIndex =
      index + 1 < matches.length ? (matches[index + 1].index ?? memoryMarkdown.length) : memoryMarkdown.length;
    const sectionBody = memoryMarkdown.slice(startIndex, endIndex).trim();
    if (!sectionBody || heading.includes("Стартовый контекст")) {
      continue;
    }
    await insertBrainEvent({
      workspaceId,
      source: "memory_import",
      eventType: "chat_session",
      title: `Session ${occurredAt}`,
      payload: { body: sectionBody },
      occurredAt,
    });
    eventsImported += 1;
  }

  return { eventsImported };
}

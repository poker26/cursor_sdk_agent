import { getSupabaseBrainClient } from "../brain/supabase-brain.js";

export interface MonitoredEpicRow {
  workspace_id: string;
  epic_key: string;
  epic_summary: string | null;
  jira_base_url: string | null;
  telegram_chat_id: string | null;
  status: string;
  poll_interval_ms: number | null;
  last_checked_at: string | null;
}

export interface MonitoredIssueState {
  issueKey: string;
  summary: string;
  status: string;
  assignee: string;
  resolution: string;
  isEpic: boolean;
}

function requireSupabaseClient() {
  const client = getSupabaseBrainClient();
  if (!client) {
    throw new Error("Supabase не настроен (SUPABASE_URL / SUPABASE_SERVICE_KEY).");
  }
  return client;
}

export async function upsertMonitoredEpic(epic: {
  workspaceId: string;
  epicKey: string;
  epicSummary: string;
  jiraBaseUrl: string | null;
  telegramChatId: string | null;
  pollIntervalMs: number;
}): Promise<void> {
  const client = requireSupabaseClient();
  const { error } = await client.from("monitored_epics").upsert(
    {
      workspace_id: epic.workspaceId,
      epic_key: epic.epicKey,
      epic_summary: epic.epicSummary,
      jira_base_url: epic.jiraBaseUrl,
      telegram_chat_id: epic.telegramChatId,
      poll_interval_ms: epic.pollIntervalMs,
      status: "active",
      last_checked_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,epic_key" },
  );
  if (error) {
    throw new Error(`monitored_epics upsert: ${error.message}`);
  }
}

export async function setMonitoredEpicStatus(
  workspaceId: string,
  epicKey: string,
  status: "active" | "paused",
): Promise<boolean> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("monitored_epics")
    .update({ status })
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey)
    .select("epic_key");
  if (error) {
    throw new Error(`monitored_epics status update: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function deleteMonitoredEpic(
  workspaceId: string,
  epicKey: string,
): Promise<boolean> {
  const client = requireSupabaseClient();
  await client
    .from("monitored_issue_state")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey);
  const { data, error } = await client
    .from("monitored_epics")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey)
    .select("epic_key");
  if (error) {
    throw new Error(`monitored_epics delete: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function updateMonitoredEpicPollInterval(
  workspaceId: string,
  epicKey: string,
  pollIntervalMs: number,
): Promise<boolean> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("monitored_epics")
    .update({ poll_interval_ms: pollIntervalMs })
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey)
    .select("epic_key");
  if (error) {
    throw new Error(`monitored_epics poll_interval update: ${error.message}`);
  }
  return (data ?? []).length > 0;
}

export async function listActiveMonitoredEpics(): Promise<MonitoredEpicRow[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("monitored_epics")
    .select(
      "workspace_id, epic_key, epic_summary, jira_base_url, telegram_chat_id, status, poll_interval_ms, last_checked_at",
    )
    .eq("status", "active");
  if (error) {
    throw new Error(`monitored_epics list active: ${error.message}`);
  }
  return (data ?? []) as MonitoredEpicRow[];
}

export async function listMonitoredEpicsForWorkspace(
  workspaceId: string,
): Promise<MonitoredEpicRow[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("monitored_epics")
    .select(
      "workspace_id, epic_key, epic_summary, jira_base_url, telegram_chat_id, status, poll_interval_ms, last_checked_at",
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`monitored_epics list: ${error.message}`);
  }
  return (data ?? []) as MonitoredEpicRow[];
}

export async function loadIssueStateMap(
  workspaceId: string,
  epicKey: string,
): Promise<Map<string, MonitoredIssueState>> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("monitored_issue_state")
    .select("issue_key, summary, status, assignee, resolution, is_epic")
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey);
  if (error) {
    throw new Error(`monitored_issue_state load: ${error.message}`);
  }
  const stateMap = new Map<string, MonitoredIssueState>();
  for (const row of data ?? []) {
    const typedRow = row as {
      issue_key: string;
      summary: string | null;
      status: string | null;
      assignee: string | null;
      resolution: string | null;
      is_epic: boolean | null;
    };
    stateMap.set(typedRow.issue_key, {
      issueKey: typedRow.issue_key,
      summary: typedRow.summary ?? "",
      status: typedRow.status ?? "",
      assignee: typedRow.assignee ?? "",
      resolution: typedRow.resolution ?? "",
      isEpic: Boolean(typedRow.is_epic),
    });
  }
  return stateMap;
}

export async function upsertIssueStates(
  workspaceId: string,
  epicKey: string,
  issues: MonitoredIssueState[],
): Promise<void> {
  if (issues.length === 0) {
    return;
  }
  const client = requireSupabaseClient();
  const rows = issues.map((issue) => ({
    workspace_id: workspaceId,
    epic_key: epicKey,
    issue_key: issue.issueKey,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    resolution: issue.resolution,
    is_epic: issue.isEpic,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await client
    .from("monitored_issue_state")
    .upsert(rows, { onConflict: "workspace_id,epic_key,issue_key" });
  if (error) {
    throw new Error(`monitored_issue_state upsert: ${error.message}`);
  }
}

export async function deleteIssueStates(
  workspaceId: string,
  epicKey: string,
  issueKeys: string[],
): Promise<void> {
  if (issueKeys.length === 0) {
    return;
  }
  const client = requireSupabaseClient();
  const { error } = await client
    .from("monitored_issue_state")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey)
    .in("issue_key", issueKeys);
  if (error) {
    throw new Error(`monitored_issue_state delete: ${error.message}`);
  }
}

export async function replaceIssueStates(
  workspaceId: string,
  epicKey: string,
  issues: MonitoredIssueState[],
): Promise<void> {
  const client = requireSupabaseClient();
  await client
    .from("monitored_issue_state")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey);
  await upsertIssueStates(workspaceId, epicKey, issues);
}

export async function touchEpicChecked(
  workspaceId: string,
  epicKey: string,
  epicSummary?: string,
): Promise<void> {
  const client = requireSupabaseClient();
  const patch: Record<string, unknown> = {
    last_checked_at: new Date().toISOString(),
  };
  if (epicSummary !== undefined) {
    patch.epic_summary = epicSummary;
  }
  await client
    .from("monitored_epics")
    .update(patch)
    .eq("workspace_id", workspaceId)
    .eq("epic_key", epicKey);
}

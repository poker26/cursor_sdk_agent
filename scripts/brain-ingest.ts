import "dotenv/config";
import { loadWorkspaceRegistryFromEnv } from "../src/workspace-registry.js";
import { callMcpTool } from "../src/brain/mcp-http.js";
import { insertBrainEvent } from "../src/brain/supabase-brain.js";
import { backfillQdrantFromTexts } from "../src/brain/qdrant-brain.js";
import { isSupabaseBrainEnabled } from "../src/brain/config.js";

const JIRA_PP_PROJECT = process.env.BRAIN_JIRA_PP_KEY?.trim() || "PP";
const JIRA_FF_PROJECT = process.env.BRAIN_JIRA_FF_KEY?.trim() || "FF";
const CONFLUENCE_PP_SPACE = process.env.BRAIN_CONFLUENCE_PP_SPACE?.trim() || "PaymentPlatform";

async function ingestJiraProject(
  workspaceId: string,
  projectKey: string,
): Promise<number> {
  const searchResult = await callMcpTool("atlassian", "jira_search", {
    jql: `project = ${projectKey} ORDER BY updated DESC`,
    limit: 20,
  });
  const issues = extractIssuesFromMcpResult(searchResult);
  let inserted = 0;
  for (const issue of issues) {
    await insertBrainEvent({
      workspaceId,
      source: "mcp_jira",
      eventType: "jira_issue_snapshot",
      title: `${String(issue.key ?? issue.id ?? "?")}: ${String(issue.summary ?? (issue.fields as Record<string, unknown>)?.summary ?? "")}`,
      payload: issue,
    });
    inserted += 1;
  }
  return inserted;
}

async function ingestConfluenceSpace(workspaceId: string, spaceKey: string): Promise<number> {
  const searchResult = await callMcpTool("atlassian", "confluence_search_cql", {
    cql: `space = "${spaceKey}" ORDER BY lastModified DESC`,
    limit: 15,
  });
  const pages = extractPagesFromMcpResult(searchResult);
  let inserted = 0;
  for (const page of pages) {
    await insertBrainEvent({
      workspaceId,
      source: "mcp_confluence",
      eventType: "confluence_page_snapshot",
      title: page.title ?? page.id,
      payload: page,
    });
    inserted += 1;
  }
  return inserted;
}

async function ingestExchangeInbox(workspaceId: string): Promise<number> {
  const mailResult = await callMcpTool("exchange_work", "exchange_get_new_emails", {
    limit: 15,
  });
  const emails = extractEmailsFromMcpResult(mailResult);
  let inserted = 0;
  for (const email of emails) {
    await insertBrainEvent({
      workspaceId,
      source: "mcp_exchange",
      eventType: "email_snapshot",
      title: email.subject ?? email.id,
      payload: email,
    });
    inserted += 1;
  }
  return inserted;
}

function extractIssuesFromMcpResult(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.issues)) {
      return record.issues as Array<Record<string, unknown>>;
    }
    if (Array.isArray(record.results)) {
      return record.results as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function extractPagesFromMcpResult(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.results)) {
      return record.results as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function extractEmailsFromMcpResult(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw as Array<Record<string, unknown>>;
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.emails)) {
      return record.emails as Array<Record<string, unknown>>;
    }
  }
  return [];
}

async function main(): Promise<void> {
  if (!isSupabaseBrainEnabled()) {
    console.error("Задайте SUPABASE_URL и SUPABASE_SERVICE_KEY.");
    process.exit(1);
  }

  const workspaceFilter = process.argv[2]?.trim();
  const workspaces = loadWorkspaceRegistryFromEnv();
  const targets = workspaceFilter
    ? workspaces.filter((entry) => entry.id === workspaceFilter)
    : workspaces;

  for (const workspace of targets) {
    let totalInserted = 0;
    try {
      totalInserted += await ingestJiraProject(workspace.id, JIRA_PP_PROJECT);
    } catch (error) {
      console.warn(`Jira PP ingest failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      totalInserted += await ingestJiraProject(workspace.id, JIRA_FF_PROJECT);
    } catch (error) {
      console.warn(`Jira FF ingest failed: ${error instanceof Error ? error.message : error}`);
    }
    try {
      totalInserted += await ingestConfluenceSpace(workspace.id, CONFLUENCE_PP_SPACE);
    } catch (error) {
      console.warn(
        `Confluence ingest failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    try {
      totalInserted += await ingestExchangeInbox(workspace.id);
    } catch (error) {
      console.warn(`Exchange ingest failed: ${error instanceof Error ? error.message : error}`);
    }

    const qdrantDocuments = [
      {
        text: `MCP ingest completed for workspace ${workspace.id}, events=${totalInserted}`,
        source: "mcp_ingest_summary",
      },
    ];
    await backfillQdrantFromTexts(workspace.id, qdrantDocuments);
    console.log(`workspace=${workspace.id} mcpEventsInserted=${totalInserted}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

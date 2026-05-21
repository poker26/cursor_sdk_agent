import "dotenv/config";
import { loadWorkspaceRegistryFromEnv } from "../src/workspace-registry.js";
import { callMcpTool, loadMcpHttpServersFromEnv } from "../src/brain/mcp-http.js";
import { insertBrainEvent } from "../src/brain/supabase-brain.js";
import { backfillQdrantFromTexts } from "../src/brain/qdrant-brain.js";
import { isQdrantBrainEnabled, isSupabaseBrainEnabled } from "../src/brain/config.js";

const JIRA_PP_PROJECT = process.env.BRAIN_JIRA_PP_KEY?.trim() || "PP";
const JIRA_FF_PROJECT = process.env.BRAIN_JIRA_FF_KEY?.trim() || "FF";
const CONFLUENCE_PP_SPACE_ENV = process.env.BRAIN_CONFLUENCE_PP_SPACE?.trim() || "PP";

interface IngestTextChunk {
  text: string;
  source: string;
}

async function ingestJiraProject(
  workspaceId: string,
  projectKey: string,
): Promise<{ inserted: number; chunks: IngestTextChunk[] }> {
  const searchResult = await callMcpTool("atlassian", "jira_search", {
    jql: `project = ${projectKey} ORDER BY updated DESC`,
    max_results: 20,
    preset: "digest",
  });
  const issues = extractIssuesFromMcpResult(searchResult);
  const chunks: IngestTextChunk[] = [];
  let inserted = 0;
  for (const issue of issues) {
    const issueKey = String(issue.key ?? issue.id ?? "?");
    const summary = String(
      issue.summary ??
        (issue.fields as Record<string, unknown> | undefined)?.summary ??
        "",
    );
    const status = String(issue.status ?? issue.status_name ?? "");
    const chunkText = [`Jira ${projectKey} ${issueKey}`, summary, status ? `Status: ${status}` : ""]
      .filter(Boolean)
      .join("\n");
    chunks.push({ text: chunkText, source: "mcp_jira" });
    await insertBrainEvent({
      workspaceId,
      source: "mcp_jira",
      eventType: "jira_issue_snapshot",
      title: `${issueKey}: ${summary}`.slice(0, 200),
      payload: issue,
    });
    inserted += 1;
  }
  return { inserted, chunks };
}

async function resolveConfluenceSpaceKey(): Promise<string> {
  const preferredKeys = [
    CONFLUENCE_PP_SPACE_ENV,
    "PP",
    "PaymentPlatform",
    "PAYMENTPLATFORM",
  ];
  try {
    const spacesResult = await callMcpTool("atlassian", "confluence_list_spaces", {
      limit: 100,
    });
    const spaces = extractSpacesFromMcpResult(spacesResult);
    for (const preferred of preferredKeys) {
      const exact = spaces.find(
        (space) => String(space.key ?? "").toUpperCase() === preferred.toUpperCase(),
      );
      if (exact?.key) {
        return String(exact.key);
      }
    }
    const byName = spaces.find((space) =>
      /payment/i.test(String(space.name ?? "")),
    );
    if (byName?.key) {
      return String(byName.key);
    }
  } catch {
    /* use env default */
  }
  return CONFLUENCE_PP_SPACE_ENV;
}

async function ingestConfluenceSpace(
  workspaceId: string,
  spaceKey: string,
): Promise<{ inserted: number; chunks: IngestTextChunk[] }> {
  let pages = extractPagesFromMcpResult(
    await callMcpTool("atlassian", "confluence_search_cql", {
      cql: `space = "${spaceKey}" ORDER BY lastModified DESC`,
      limit: 25,
      include_excerpt: true,
    }),
  );

  if (pages.length === 0) {
    const todayDate = new Date().toISOString().slice(0, 10);
    pages = extractPagesFromMcpResult(
      await callMcpTool("atlassian", "confluence_search_by_date", {
        date_from: todayDate,
        timezone: "Europe/Moscow",
        space_key: spaceKey,
        field: "lastmodified",
        max_results: 25,
      }),
    );
  }

  const chunks: IngestTextChunk[] = [];
  let inserted = 0;
  for (const page of pages) {
    const title = String(page.title ?? page.name ?? page.id ?? "page");
    const excerpt = String(page.excerpt ?? page.body ?? "");
    const chunkText = [`Confluence ${spaceKey}: ${title}`, excerpt].filter(Boolean).join("\n");
    chunks.push({ text: chunkText, source: "mcp_confluence" });
    await insertBrainEvent({
      workspaceId,
      source: "mcp_confluence",
      eventType: "confluence_page_snapshot",
      title: title.slice(0, 200),
      payload: page,
    });
    inserted += 1;
  }
  return { inserted, chunks };
}

async function ingestExchangeInbox(
  workspaceId: string,
): Promise<{ inserted: number; chunks: IngestTextChunk[] }> {
  const mailResult = await callMcpTool("exchange_work", "exchange_get_new_emails", {
    max_items: 15,
    include_body: false,
  });
  const emails = extractEmailsFromMcpResult(mailResult);
  const chunks: IngestTextChunk[] = [];
  let inserted = 0;
  for (const email of emails) {
    const subject = String(email.subject ?? email.id ?? "email");
    const sender = String(email.from ?? email.sender ?? "");
    const preview = String(email.preview ?? email.body_preview ?? "");
    const chunkText = [`Exchange: ${subject}`, sender ? `From: ${sender}` : "", preview]
      .filter(Boolean)
      .join("\n");
    chunks.push({ text: chunkText, source: "mcp_exchange" });
    await insertBrainEvent({
      workspaceId,
      source: "mcp_exchange",
      eventType: "email_snapshot",
      title: subject.slice(0, 200),
      payload: email,
    });
    inserted += 1;
  }
  return { inserted, chunks };
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
    if (Array.isArray(record.items)) {
      return record.items as Array<Record<string, unknown>>;
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
      const first = record.results[0];
      if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).results)) {
        return (first as Record<string, unknown>).results as Array<Record<string, unknown>>;
      }
      return record.results as Array<Record<string, unknown>>;
    }
    if (Array.isArray(record.pages)) {
      return record.pages as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function extractSpacesFromMcpResult(raw: unknown): Array<Record<string, unknown>> {
  return extractPagesFromMcpResult(raw);
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
    if (Array.isArray(record.items)) {
      return record.items as Array<Record<string, unknown>>;
    }
  }
  return [];
}

async function main(): Promise<void> {
  if (!isSupabaseBrainEnabled()) {
    console.error("Задайте SUPABASE_URL и SUPABASE_SERVICE_KEY.");
    process.exit(1);
  }
  if (!isQdrantBrainEnabled()) {
    console.error("Задайте QDRANT_URL и BGE_M3_URL.");
    process.exit(1);
  }

  const configuredServers = loadMcpHttpServersFromEnv();
  const requiredForIngest = ["atlassian", "exchange_work"] as const;
  for (const serverLabel of requiredForIngest) {
    if (!configuredServers[serverLabel]) {
      console.error(
        `В .env нужны ${serverLabel === "atlassian" ? "ATLASSIAN" : "EXCHANGE"}_MCP_URL и *_MCP_API_KEY (как в чате).`,
      );
      process.exit(1);
    }
  }

  const workspaceFilter = process.argv[2]?.trim();
  const workspaces = loadWorkspaceRegistryFromEnv();
  const targets = workspaceFilter
    ? workspaces.filter((entry) => entry.id === workspaceFilter)
    : workspaces;

  for (const workspace of targets) {
    const allChunks: IngestTextChunk[] = [];
    let totalInserted = 0;

    for (const [label, projectKey] of [
      ["jira_pp", JIRA_PP_PROJECT],
      ["jira_ff", JIRA_FF_PROJECT],
    ] as const) {
      try {
        const result = await ingestJiraProject(workspace.id, projectKey);
        totalInserted += result.inserted;
        allChunks.push(...result.chunks);
        console.log(`workspace=${workspace.id} ${label}=${result.inserted}`);
      } catch (error) {
        console.error(
          `workspace=${workspace.id} ${label} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exit(1);
      }
    }

    try {
      const confluenceSpaceKey = await resolveConfluenceSpaceKey();
      const confluenceResult = await ingestConfluenceSpace(workspace.id, confluenceSpaceKey);
      totalInserted += confluenceResult.inserted;
      allChunks.push(...confluenceResult.chunks);
      console.log(
        `workspace=${workspace.id} confluence=${confluenceResult.inserted} spaceKey=${confluenceSpaceKey}`,
      );
    } catch (error) {
      console.error(
        `workspace=${workspace.id} confluence failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }

    try {
      const exchangeResult = await ingestExchangeInbox(workspace.id);
      totalInserted += exchangeResult.inserted;
      allChunks.push(...exchangeResult.chunks);
      console.log(`workspace=${workspace.id} exchange=${exchangeResult.inserted}`);
    } catch (error) {
      console.error(
        `workspace=${workspace.id} exchange failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }

    const qdrantUpserted = await backfillQdrantFromTexts(workspace.id, allChunks);
    console.log(
      `workspace=${workspace.id} mcpEventsInserted=${totalInserted} qdrantChunks=${qdrantUpserted}`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

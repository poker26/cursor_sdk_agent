import "dotenv/config";
import { loadWorkspaceRegistryFromEnv } from "../src/workspace-registry.js";
import { readMemoryFile } from "../src/memory.js";
import { listRecentEventsForWorkspace } from "../src/brain/supabase-brain.js";
import { backfillQdrantFromTexts } from "../src/brain/qdrant-brain.js";
import { isQdrantBrainEnabled } from "../src/brain/config.js";
async function main() {
    if (!isQdrantBrainEnabled()) {
        console.error("Задайте QDRANT_URL (и OPENAI_API_KEY для эмбеддингов).");
        process.exit(1);
    }
    const workspaceFilter = process.argv[2]?.trim();
    const workspaces = loadWorkspaceRegistryFromEnv();
    const targets = workspaceFilter
        ? workspaces.filter((entry) => entry.id === workspaceFilter)
        : workspaces;
    for (const workspace of targets) {
        const documents = [];
        const memoryMarkdown = await readMemoryFile(workspace.path);
        if (memoryMarkdown.trim()) {
            documents.push({ text: memoryMarkdown, source: "memory_md" });
        }
        const events = await listRecentEventsForWorkspace(workspace.id, 500);
        for (const event of events) {
            const bodyText = typeof event.payload?.body === "string"
                ? event.payload.body
                : JSON.stringify(event.payload);
            documents.push({
                text: `${event.title ?? event.source}\n${bodyText}`,
                source: event.source,
                eventId: event.id,
            });
        }
        const upserted = await backfillQdrantFromTexts(workspace.id, documents);
        console.log(`workspace=${workspace.id} chunksUpserted=${upserted}`);
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

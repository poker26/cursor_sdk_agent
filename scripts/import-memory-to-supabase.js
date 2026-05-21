import "dotenv/config";
import { loadWorkspaceRegistryFromEnv } from "../src/workspace-registry.js";
import { readMemoryFile } from "../src/memory.js";
import { importMemoryMarkdownToSupabase } from "../src/brain/supabase-brain.js";
import { isSupabaseBrainEnabled } from "../src/brain/config.js";
async function main() {
    if (!isSupabaseBrainEnabled()) {
        console.error("Задайте SUPABASE_URL и SUPABASE_SERVICE_KEY.");
        process.exit(1);
    }
    const workspaceFilter = process.argv[2]?.trim();
    const workspaces = loadWorkspaceRegistryFromEnv();
    const targets = workspaceFilter
        ? workspaces.filter((entry) => entry.id === workspaceFilter)
        : workspaces;
    if (targets.length === 0) {
        console.error("Workspace не найден:", workspaceFilter);
        process.exit(1);
    }
    for (const workspace of targets) {
        const memoryMarkdown = await readMemoryFile(workspace.path);
        const result = await importMemoryMarkdownToSupabase(workspace.id, memoryMarkdown);
        console.log(`workspace=${workspace.id} eventsImported=${result.eventsImported}`);
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});

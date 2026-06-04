import "dotenv/config";
import {
  isMonitoringEnabled,
  pollAllActiveEpics,
} from "../src/monitor/jira-epic-monitor.js";

async function main(): Promise<void> {
  if (!isMonitoringEnabled()) {
    console.error(
      "Мониторинг выключен: нужны TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL/SUPABASE_SERVICE_KEY и ATLASSIAN_MCP_URL/ATLASSIAN_MCP_API_KEY.",
    );
    process.exit(1);
  }

  const results = await pollAllActiveEpics();
  for (const result of results) {
    if (result.error) {
      console.error(`epic=${result.epicKey} error=${result.error}`);
    } else {
      console.log(`epic=${result.epicKey} changes=${result.changes}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

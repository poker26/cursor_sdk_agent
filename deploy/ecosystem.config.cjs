/**
 * Пример PM2: поправьте `cwd` на каталог clone на сервере.
 * Переменные берутся из `.env` в этом каталоге (dotenv в приложении).
 */
module.exports = {
  apps: [
    {
      name: "cursor-sdk-agent",
      cwd: "/root/cursor_sdk_agent",
      script: "dist/index.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: "10s",
      exp_backoff_restart_delay: 200,
    },
  ],
};

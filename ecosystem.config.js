"use strict";

/**
 * PM2 Ecosystem Config — Deploy Manager
 *
 * PM2 управляет двумя процессами на хосте:
 *   {PROJECT_NAME}-dm       — Telegram Deploy Manager Bot (long polling)
 *   {PROJECT_NAME}-webhook  — сервер GitHub webhook
 *
 * Docker-контейнеры приложения управляются через docker compose.
 *
 * Использование:
 *   Первый запуск:  pm2 start ecosystem.config.js --env production
 *   Перезагрузка:   pm2 reload ecosystem.config.js --update-env
 *   Сохранить:      pm2 save
 *   Автозапуск:     pm2 startup
 */

const path = require("path");

const ROOT = __dirname;
const LOGS = path.join(ROOT, "logs");

// Имя проекта — берётся из .env.deploy или задаётся здесь
const PROJECT_NAME = process.env.PROJECT_NAME || "myapp";

module.exports = {
  apps: [
    // ─── Telegram Deploy Manager Bot ────────────────────────────────────────
    {
      name: `${PROJECT_NAME}-dm`,
      script: path.join(ROOT, "scripts/tg-bot.js"),
      cwd: ROOT,
      instances: 1,
      exec_mode: "fork",
      node_args: `--env-file ${path.join(ROOT, ".env.deploy")}`,
      env_production: {
        NODE_ENV: "production",
        PROJECT_DIR: ROOT,
      },
      max_memory_restart: "200M",
      error_file: path.join(LOGS, "dm-error.log"),
      out_file: path.join(LOGS, "dm-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      autorestart: true,
      restart_delay: 5000,
      watch: false,
    },

    // ─── GitHub Webhook Server ───────────────────────────────────────────────
    {
      name: `${PROJECT_NAME}-webhook`,
      script: path.join(ROOT, "scripts/webhook/index.js"),
      cwd: ROOT,
      instances: 1,
      exec_mode: "fork",
      node_args: `--env-file ${path.join(ROOT, ".env.deploy")}`,
      env_production: {
        NODE_ENV: "production",
        PROJECT_DIR: ROOT,
      },
      max_memory_restart: "64M",
      error_file: path.join(LOGS, "webhook-error.log"),
      out_file: path.join(LOGS, "webhook-out.log"),
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      autorestart: true,
      restart_delay: 2000,
      watch: false,
    },
  ],
};

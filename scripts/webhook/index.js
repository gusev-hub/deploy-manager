#!/usr/bin/env node
"use strict";

/**
 * GitHub Webhook Server — авто-деплой nbp
 *
 * Слушает входящие POST-запросы от GitHub, проверяет подпись
 * и кладёт задачу в webhook-queue.json.
 * tg-bot.js (nbp-dm) забирает задачу и выполняет деплой через
 * свою очередь (карточка + live-стриминг).
 *
 * Переменные окружения (из .env.deploy):
 *   DEPLOY_SECRET    — секрет из настроек GitHub webhook (обязательно)
 *   WEBHOOK_PORT     — порт сервера (по умолчанию: 3010)
 *   PROJECT_DIR      — корень проекта (по умолчанию: ../../ от этого файла)
 *   GIT_BRANCH       — ветка для деплоя (по умолчанию: main)
 */

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const SECRET = process.env.DEPLOY_SECRET || "nbp_deploy_2026_secret";
const PORT = parseInt(process.env.WEBHOOK_PORT || "3010", 10);
const PROJECT_DIR =
  process.env.PROJECT_DIR || path.resolve(__dirname, "..", "..");
const GIT_BRANCHES = (process.env.GIT_BRANCHES || process.env.GIT_BRANCH || "main")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOGS_DIR = path.join(PROJECT_DIR, "logs");
const LOG_FILE = path.join(LOGS_DIR, "webhook.log");
const MODE_FILE = path.join(LOGS_DIR, "deploy-mode.txt");
const LOCK_FILE = path.join(LOGS_DIR, "deploy.lock");
const WEBHOOK_QUEUE_FILE = path.join(LOGS_DIR, "webhook-queue.json");

const BOT_TOKEN = process.env.BOT_DEPLOY_MANAGER_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);

// ─── Логирование ──────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // игнорируем ошибки записи в лог
  }
}

// ─── Проверка подписи GitHub ──────────────────────────────────────────────────
function verifySignature(payload, signature) {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const hmac = crypto.createHmac("sha256", SECRET);
  const digest = "sha256=" + hmac.update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(signature, "utf8")
    );
  } catch {
    return false;
  }
}

// ─── Режим деплоя ─────────────────────────────────────────────────────────────
function getDeployMode() {
  try {
    return fs.readFileSync(MODE_FILE, "utf8").trim() === "manual" ? "manual" : "auto";
  } catch { return "auto"; }
}

function tgNotify(text, extra = {}) {
  if (!BOT_TOKEN || !ADMIN_IDS.length) return;
  const https = require("https");
  for (const chatId of ADMIN_IDS) {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra });
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.write(body);
    req.end();
  }
}

// ─── Управление webhook-очередью ──────────────────────────────────────────
function loadWebhookQueue() {
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_QUEUE_FILE, "utf8")) || [];
  } catch { return []; }
}

function saveWebhookQueue(queue) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(WEBHOOK_QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    log(`[WARN] Could not save webhook queue: ${e.message}`);
  }
}

function addToWebhookQueue(pusher, commitMsg, commitHash, branch, ref, prNumber) {
  const queue = loadWebhookQueue();
  queue.push({ pusher, commitMsg, commitHash, branch, ref, prNumber, timestamp: Date.now() });
  saveWebhookQueue(queue);
  log(`[INFO] Added to webhook queue: "${commitMsg}" by ${pusher}`);
}

// ─── HTTP сервер ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Healthcheck
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`${process.env.PROJECT_NAME || "deploy"}-webhook OK`);
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const signature = req.headers["x-hub-signature-256"];

    // Проверка подписи
    if (!verifySignature(body, signature)) {
      log(`[WARN] Invalid signature from ${req.socket.remoteAddress}`);
      res.writeHead(401).end("Unauthorized");
      return;
    }

    // Разбор payload
    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400).end("Bad Request");
      return;
    }

    // Проверка ветки
    const ref = payload.ref || "";
    const branch = ref.replace("refs/heads/", "");
    if (!GIT_BRANCHES.includes(branch)) {
      log(`[INFO] Skipping push to branch: ${branch} (watching: ${GIT_BRANCHES.join(", ")})`);
      res.writeHead(200).end("OK - skipped");
      return;
    }

    const pusher = payload.pusher?.name || "unknown";
    const commitMsg = payload.head_commit?.message?.split("\n")[0] || "";
    const commitHash = (payload.head_commit?.id || "").slice(0, 7);
    // PR номер: из commit message "(#123)" или из payload (merge commit)
    const prMatch = commitMsg.match(/\(#(\d+)\)/);
    const prNumber = prMatch ? prMatch[1] : "";
    const envLabel = branch === "develop" ? "🟡 DEV" : "🟢 PROD";
    const hashLine = commitHash ? `🔖 <code>${commitHash}</code>\n` : "";
    const prLine = prNumber ? `🔗 PR #${prNumber}\n` : "";

    // Ручной режим — уведомляем, деплой не запускаем
    const mode = getDeployMode();
    if (mode === "manual") {
      log(`[INFO] Manual mode — skipping auto-deploy. Push from ${pusher}: "${commitMsg}"`);
      tgNotify(
        `📨 <b>Новый пуш [${envLabel}]</b> — ручной режим\n\n` +
        `👤 ${pusher}\n${hashLine}${prLine}📝 ${commitMsg}`,
        { reply_markup: { inline_keyboard: [[{ text: "🚀 Полный деплой", callback_data: "deploy", style: "primary" }]] } }
      );
      res.writeHead(200).end("OK - manual mode");
      return;
    }

    // Кладём в очередь — tg-bot.js заберёт и выполнит с карточкой и live-стримингом
    addToWebhookQueue(pusher, commitMsg, commitHash, branch, payload.ref, prNumber);
    log(`[INFO] Auto-deploy queued for bot: "${commitMsg}" by ${pusher}`);

    const lockExists = fs.existsSync(LOCK_FILE);
    const queueNote = lockExists
      ? `\n\n<i>Деплой уже идёт — будет выполнен следующим.</i>`
      : `\n\n<i>Бот запустит деплой в течение нескольких секунд.</i>`;

    tgNotify(
      `🔔 <b>Авто-деплой [${envLabel}]</b>\n\n` +
      `👤 ${pusher}\n${hashLine}${prLine}📝 ${commitMsg}${queueNote}`
    );

    res.writeHead(200).end("Queued for bot");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`[INFO] Webhook server listening on 0.0.0.0:${PORT}`);
  log(`[INFO] Watching branches: ${GIT_BRANCHES.join(", ")}`);
});

// Корректное завершение
process.on("SIGTERM", () => {
  log("[INFO] SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});

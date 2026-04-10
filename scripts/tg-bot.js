#!/usr/bin/env node
"use strict";

/**
 * Deploy Manager Bot — управление деплоем через Telegram
 *
 * Поддерживает очередь деплоев с live-стримингом логов.
 * Каждый деплой — отдельная карточка со статусом и кнопками.
 *
 * Переменные (из .env.deploy):
 *   BOT_DEPLOY_MANAGER_TOKEN — токен бота
 *   ADMIN_TG_IDS             — разрешённые пользователи (через запятую)
 *   PROJECT_DIR              — корень проекта
 *   PROJECT_NAME             — имя проекта (для PM2, уведомлений)
 */

const https = require("https");
const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_DEPLOY_MANAGER_TOKEN;
const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, "..");
const PROJECT_NAME = process.env.PROJECT_NAME || "myapp";
const DM_PROCESS_NAME = `${PROJECT_NAME}-dm`;
const DEPLOY_SCRIPT = path.join(PROJECT_DIR, "scripts", "deploy.sh");
const DEPLOY_PARTIAL_SCRIPT = path.join(PROJECT_DIR, "scripts", "deploy-partial.sh");
const LOGS_DIR = path.join(PROJECT_DIR, "logs");
const LOCK_FILE = path.join(LOGS_DIR, "deploy.lock");
const MODE_FILE = path.join(LOGS_DIR, "deploy-mode.txt");
const NO_CACHE_FILE = path.join(LOGS_DIR, "deploy-nocache.txt");
const LAST_SUCCESS_FILE = path.join(LOGS_DIR, "last-success.json");
const WEBHOOK_QUEUE_FILE = path.join(LOGS_DIR, "webhook-queue.json");
const CONTEXT_FILE = path.join(LOGS_DIR, "deploy-context.txt");
const QUEUE_MAX_HISTORY = 10; // сколько завершённых деплоев хранить

// ─── Сервисы проекта (настраиваются через DEPLOY_SERVICES) ──────────────────
// Формат: "web bot worker" (через пробел)
const SERVICES_LIST = (process.env.DEPLOY_SERVICES || "web bot worker").split(/\s+/).filter(Boolean);

// Строит объект services: { web: "web", bot: "bot" } или { web: "dev-web", ... }
function buildServicesMap(prefix = "") {
  const map = {};
  for (const svc of SERVICES_LIST) map[svc] = `${prefix}${svc}`;
  return map;
}

// ─── Конфигурация контекста (prod / dev) ────────────────────────────────────
function getContextConfig(ctx) {
  if (ctx === "dev") return {
    composeFile: process.env.DEV_COMPOSE_FILE || "docker-compose.dev.yml",
    workDir: process.env.DEV_WORK_DIR || `${PROJECT_DIR}-dev`,
    branch: "develop",
    services: buildServicesMap("dev-"),
    label: "🟡 DEV",
    logFile: "deploy-dev.log",
    projectName: `${PROJECT_NAME}-dev`,
    servicePrefix: "dev-",
  };
  return {
    composeFile: process.env.PROD_COMPOSE_FILE || "docker-compose.yml",
    workDir: PROJECT_DIR,
    branch: "main",
    services: buildServicesMap(),
    label: "🟢 PROD",
    logFile: "deploy-prod.log",
    projectName: PROJECT_NAME,
    servicePrefix: "",
  };
}

// ─── Текущий контекст UI (prod | dev) ──────────────────────────────────────
let currentContext = "prod";

function loadContext() {
  try {
    const val = fs.readFileSync(CONTEXT_FILE, "utf8").trim();
    currentContext = val === "dev" ? "dev" : "prod";
  } catch { currentContext = "prod"; }
}

function saveContext() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(CONTEXT_FILE, currentContext);
  } catch {}
}

// ─── Режим деплоя (auto | manual) ────────────────────────────────────────────
let deployMode = "auto";

function loadDeployMode() {
  try {
    deployMode = fs.readFileSync(MODE_FILE, "utf8").trim() === "manual" ? "manual" : "auto";
  } catch { deployMode = "auto"; }
}

function saveDeployMode() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(MODE_FILE, deployMode);
  } catch {}
}

// ─── Режим кеша для автодеплоя (с кешем | без кеша) ─────────────────────────
let noCacheAuto = false;

function loadNoCacheAuto() {
  try {
    noCacheAuto = fs.readFileSync(NO_CACHE_FILE, "utf8").trim() === "1";
  } catch { noCacheAuto = false; }
}

function saveNoCacheAuto() {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(NO_CACHE_FILE, noCacheAuto ? "1" : "0");
  } catch {}
}

// ─── Последний успешный деплой ────────────────────────────────────────────────
let lastSuccess = null; // { num, commit, time }

function loadLastSuccess() {
  try {
    lastSuccess = JSON.parse(fs.readFileSync(LAST_SUCCESS_FILE, "utf8"));
  } catch { lastSuccess = null; }
}

function saveLastSuccess(data) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(LAST_SUCCESS_FILE, JSON.stringify(data));
  } catch {}
}

function lastSuccessText() {
  if (!lastSuccess) return "";
  const ago = formatElapsed(Date.now() - lastSuccess.time);
  return `\n✅ Последний успешный: <b>#${lastSuccess.num}</b> · <code>${lastSuccess.commit}</code> · ${ago} назад`;
}

// ─── Webhook-очередь ──────────────────────────────────────────────────────
function loadWebhookQueue() {
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_QUEUE_FILE, "utf8")) || [];
  } catch { return []; }
}

function saveWebhookQueue(queue) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(WEBHOOK_QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch {}
}

function getNextWebhook() {
  const queue = loadWebhookQueue();
  if (queue.length === 0) return null;
  const item = queue.shift();
  saveWebhookQueue(queue);
  return item;
}

const ADMIN_IDS = (process.env.ADMIN_TG_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error("[ERROR] BOT_DEPLOY_MANAGER_TOKEN не задан");
  process.exit(1);
}

if (ADMIN_IDS.length === 0) {
  console.error("[ERROR] ADMIN_TG_IDS не задан");
  process.exit(1);
}

// ─── Состояние ────────────────────────────────────────────────────────────────
let offset = 0;
let deployCounter = 0; // порядковый номер деплоя

// ─── Логирование ──────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Telegram API ─────────────────────────────────────────────────────────────
function tgRequest(method, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch { resolve({ ok: false }); }
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error(`tgRequest ${method} timed out after ${timeoutMs}ms`)); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(chatId, text, extra = {}) {
  return tgRequest("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

function editMessage(chatId, messageId, text, extra = {}) {
  return tgRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function answerCallback(callbackQueryId, text = "") {
  return tgRequest("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Убираем ANSI escape-коды (цвета/форматирование терминала)
function stripAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")  // CSI sequences: ESC [ ... m
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC sequences
    .replace(/\x1b[()][0-9A-Za-z]/g, "")      // charset sequences
    .replace(/\x1b./g, "")                    // прочие ESC
    .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/g, ""); // непечатные символы
}

function readLastLines(file, n = 30) {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.trim().split("\n");
    return lines.slice(-n).join("\n") || "(файл пуст)";
  } catch {
    return "(файл не найден)";
  }
}

// Фильтрует строки с ошибками/предупреждениями из лога
function filterErrorLines(text) {
  if (!text || text === "(файл не найден)" || text === "(файл пуст)") return text;
  const errRx = /error|err |err:|fail|warn|exception|cannot|unable|enoent|eacces|exit code [^0]/i;
  const lines = text.split("\n").filter((l) => errRx.test(l));
  return lines.length > 0 ? lines.join("\n") : "(строк с ошибками не найдено)";
}

function formatElapsed(ms) {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  return mins > 0 ? `${mins}м ${secs % 60}с` : `${secs}с`;
}

// Обрезаем лог до безопасного размера для Telegram (max ~3800 символов в <pre>)
function truncateForTg(text, max = 3600) {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf("\n");
  return nl > 0 ? cut.slice(nl + 1) : cut;
}

// ─── Очередь деплоев ──────────────────────────────────────────────────────────
// Структура job: { id, chatId, msgId, script, label, status, startTime, endTime, cancelling }
// status: "queued" | "running" | "cancelled" | "done" | "error"
const deployQueue = [];
let currentJobId = null;
let currentChild = null;       // ChildProcess текущего деплоя
let currentLiveInterval = null; // интервал live-стриминга

// ─── Персистенция истории деплоев ────────────────────────────────────────────
// Завершённые деплои сохраняются в файл, чтобы кнопки (Логи, Ошибки, Передеплой)
// работали после рестарта PM2.
const DEPLOY_HISTORY_FILE = path.join(LOGS_DIR, "deploy-history.json");

function saveDeployHistory() {
  try {
    const completed = deployQueue
      .filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled")
      .slice(-QUEUE_MAX_HISTORY)
      .map((j) => ({
        id: j.id, chatId: j.chatId, msgId: j.msgId,
        script: j.script, label: j.label, num: j.num,
        status: j.status, noCache: j.noCache,
        contextConfig: j.contextConfig,
        startTime: j.startTime, endTime: j.endTime,
      }));
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(DEPLOY_HISTORY_FILE, JSON.stringify(completed, null, 2));
  } catch {}
}

function loadDeployHistory() {
  try {
    const items = JSON.parse(fs.readFileSync(DEPLOY_HISTORY_FILE, "utf8"));
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!getJob(item.id)) {
        deployQueue.push(item);
        if (item.num > deployCounter) deployCounter = item.num;
      }
    }
  } catch {}
}

function makeJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

function getJob(id) {
  return deployQueue.find((j) => j.id === id) ?? null;
}

// Клавиатура карточки деплоя (динамическая по статусу)
function deployJobKeyboard(job) {
  const id     = typeof job === "string" ? job : job.id;
  const status = typeof job === "string" ? (getJob(id)?.status ?? "done") : job.status;

  const logs   = { text: "📋 Логи",       callback_data: `dlogs_${id}` };
  const errs   = { text: "❌ Ошибки",     callback_data: `derr_${id}` };
  const redo   = { text: "🔄 Передеплой", callback_data: `dredo_${id}` };
  const cancel = { text: "🚫 Отменить",   callback_data: `dcancel_${id}`, style: "danger" };
  const stop   = { text: "⏹ Остановить", callback_data: `dcancel_${id}`, style: "danger" };

  switch (status) {
    case "queued":    return { inline_keyboard: [[logs, cancel]] };
    case "running":   return { inline_keyboard: [[stop]] };
    case "cancelled": return { inline_keyboard: [[redo]] };
    default:          return { inline_keyboard: [[logs, errs, redo]] };
  }
}

// Заголовок карточки деплоя
function buildJobHeader(job) {
  const elapsed = job.startTime
    ? ` — ⏱ ${formatElapsed((job.endTime ?? Date.now()) - job.startTime)}`
    : "";
  const id = `<code>#${job.num}</code>`;
  const statusMap = {
    queued:    `⏳ <b>В очереди</b> ${id}\n${job.label}`,
    running:   `🔄 <b>В процессе${elapsed}</b> ${id}\n${job.label}`,
    done:      `✅ <b>Завершён${elapsed}</b> ${id}\n${job.label}`,
    error:     `❌ <b>Ошибка${elapsed}</b> ${id}\n${job.label}`,
    cancelled: `🚫 <b>Отменён</b> ${id}\n${job.label}`,
  };
  return statusMap[job.status] ?? `❓ ${id} ${job.label}`;
}

// Полный текст карточки с логами
function buildJobText(job, logLines) {
  const header = buildJobHeader(job);
  if (!logLines) return header;
  const safe = truncateForTg(escapeHtml(stripAnsi(logLines)));
  return `${header}\n\n<pre>${safe}</pre>`;
}

// Обновить сообщение карточки
function updateJobCard(job, logLines) {
  if (!job.msgId) return Promise.resolve();
  return tgRequest("editMessageText", {
    chat_id: job.chatId,
    message_id: job.msgId,
    text: buildJobText(job, logLines),
    parse_mode: "HTML",
    reply_markup: deployJobKeyboard(job.id),
  }).catch(() => {});
}

// Добавить деплой в очередь и отправить карточку
async function enqueueDeployFor(chatId, script, label, noCache = false, ctxConfig = null) {
  const id = makeJobId();
  const contextConfig = ctxConfig || getContextConfig(currentContext);
  const job = {
    id, chatId, msgId: null,
    script, label,
    num: ++deployCounter,
    status: "queued",
    noCache,
    contextConfig,
    startTime: null, endTime: null,
  };
  deployQueue.push(job);

  const res = await sendMessage(chatId, buildJobHeader(job), {
    reply_markup: deployJobKeyboard(id),
  }).catch(() => null);
  job.msgId = res?.result?.message_id ?? null;

  log(`[INFO] Queued: "${label}" (id=${id}, queue=${deployQueue.filter(j => j.status === "queued").length})`);

  if (!currentJobId) runNextJob();
  return job;
}

// Запустить следующий деплой из очереди
function runNextJob() {
  if (currentJobId) return;
  const job = deployQueue.find((j) => j.status === "queued");
  if (!job) return;

  currentJobId = job.id;
  job.status = "running";
  job.startTime = Date.now();

  log(`[INFO] Starting deploy: "${job.label}" (id=${job.id})`);
  updateJobCard(job); // статус "в процессе"

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, job.id);

  // Live-стриминг: обновляем карточку каждые 4с
  let lastText = "";
  const jobLogFile = job.contextConfig?.logFile || "deploy-prod.log";
  currentLiveInterval = setInterval(() => {
    if (job.status !== "running") { clearInterval(currentLiveInterval); return; }
    const lines = readLastLines(path.join(LOGS_DIR, jobLogFile), 15);
    const text = buildJobText(job, lines);
    if (text === lastText) return;
    lastText = text;
    updateJobCard(job, lines);
  }, 4000);

  // spawn вместо execFile — не буферизируем stdout/stderr в памяти родительского процесса.
  // deploy.sh сам пишет логи в файл, tg-bot читает файл для live-обновлений.
  const ctx = job.contextConfig || getContextConfig("prod");
  currentChild = spawn("bash", job.script, {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PROJECT_DIR,
      WORK_DIR: ctx.workDir,
      COMPOSE_FILE: ctx.composeFile,
      DEPLOY_SERVICES: Object.values(ctx.services).join(" "),
      GIT_BRANCH: ctx.branch,
      STACK_NAME: ctx.label.toLowerCase(),
      PROJECT_NAME: ctx.projectName,
      SERVICE_PREFIX: ctx.servicePrefix,
      DEPLOY_SOURCE: "bot",
      GIT_TERMINAL_PROMPT: "0",      // не ждать ввода пароля/passphrase — сразу падать
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15", // не вешаться на SSH
      ...(job.noCache ? { NO_CACHE: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Дренаж потоков без буферизации — предотвращает рост памяти
  currentChild.stdout.resume();
  currentChild.stderr.resume();

  // Ручной таймаут (spawn не поддерживает опцию timeout)
  const DEPLOY_TIMEOUT = 15 * 60 * 1000;
  const deployTimer = setTimeout(() => {
    log(`[WARN] Deploy "${job.label}" timed out after 15 min — killing`);
    currentChild?.kill("SIGTERM");
  }, DEPLOY_TIMEOUT);

  currentChild.on("close", async (code, signal) => {
    clearTimeout(deployTimer);
    clearInterval(currentLiveInterval);
    currentLiveInterval = null;
    currentChild = null;
    currentJobId = null;
    try { fs.unlinkSync(LOCK_FILE); } catch {}

    const failed = code !== 0;

    // Если была запрошена отмена — cleanup без уведомлений
    if (job.cancelling) {
      log(`[INFO] Deploy "${job.label}" cancelled by user`);
      runNextJob();
      return;
    }

    if (failed) {
      log(`[ERROR] Deploy "${job.label}" failed: code=${code ?? "?"} signal=${signal ?? "-"}`);
    }

    job.status = failed ? "error" : "done";
    job.endTime = Date.now();
    saveDeployHistory();

    // Сохраняем последний успешный деплой
    if (!failed) {
      exec(`git -C ${PROJECT_DIR} rev-parse --short HEAD`, (_e, stdout) => {
        const commit = (stdout || "").trim() || "unknown";
        lastSuccess = { num: job.num, commit, time: job.endTime };
        saveLastSuccess(lastSuccess);
      });
    }

    const elapsed = formatElapsed(job.endTime - job.startTime);
    log(`[INFO] Deploy "${job.label}" ${job.status} in ${elapsed}`);

    // Финальная карточка с логами + reply-уведомление
    // Ждём обоих перед self-reload, чтобы pm2 не убил процесс раньше времени
    const finalLogFile = job.contextConfig?.logFile || "deploy-prod.log";
    const lines = readLastLines(path.join(LOGS_DIR, finalLogFile), failed ? 20 : 10);
    const elapsedFinal = formatElapsed(job.endTime - job.startTime);
    const replyText = failed
      ? `❌ <b>Деплой #${job.num} упал</b> — ⏱ ${elapsedFinal}\n${job.label}`
      : `✅ <b>Деплой #${job.num} завершён</b> — ⏱ ${elapsedFinal}\n${job.label}`;

    await Promise.all([
      // Обновляем карточку; если не получилось — шлём новым сообщением
      updateJobCard(job, lines).catch(() =>
        sendMessage(job.chatId, buildJobText(job, lines), {
          reply_markup: deployJobKeyboard(job.id),
        }).catch(() => {})
      ),
      // Reply-уведомление; если reply не принят — шлём без reply_to
      sendMessage(job.chatId, replyText, {
        reply_to_message_id: job.msgId,
        reply_markup: deployJobKeyboard(job.id),
      }).catch(() =>
        sendMessage(job.chatId, replyText, {
          reply_markup: deployJobKeyboard(job.id),
        }).catch(() => {})
      ),
    ]);

    // Чистим историю (оставляем QUEUE_MAX_HISTORY завершённых/отменённых)
    const done = deployQueue.filter((j) => j.status === "done" || j.status === "error" || j.status === "cancelled");
    while (done.length > QUEUE_MAX_HISTORY) {
      const old = done.shift();
      deployQueue.splice(deployQueue.indexOf(old), 1);
    }

    runNextJob();

    // Если нет следующего деплоя в очереди — проверяем webhook-очередь
    if (!currentJobId) {
      const webhook = getNextWebhook();
      if (webhook) {
        // Есть webhook в очереди — запускаем его как обычный деплой
        log(`[INFO] Processing webhook from queue: "${webhook.commitMsg}" (branch: ${webhook.branch})`);
        const chatId = ADMIN_IDS[0]; // используем первого админа для webhook-деплоев
        const whCtx = webhook.branch === "develop" ? "dev" : "prod";
        const whConfig = getContextConfig(whCtx);
        const whPrPart = webhook.prNumber ? ` · PR #${webhook.prNumber}` : "";
        const suffix = noCacheAuto ? " (--no-cache)" : "";
        await enqueueDeployFor(
          chatId,
          [DEPLOY_SCRIPT],
          `🔔 [${whConfig.label}] Webhook (${webhook.pusher})${whPrPart}: ${webhook.commitMsg}${suffix}`,
          noCacheAuto,
          whConfig
        );
        // runNextJob() уже вызвана внутри enqueueDeployFor()
      } else if (!failed) {
        // Перезапускаем только при успешном деплое — подхватываем новый код менеджера
        exec(`pm2 restart ${DM_PROCESS_NAME} --update-env --force`, (e) => {
          if (e) log(`[WARN] Self-restart failed: ${e.message}`);
        });
      } else {
        log(`[INFO] Deploy failed — skip self-restart, staying alive for investigation`);
      }
    }
  });
}

// ─── Текст очереди ────────────────────────────────────────────────────────────
function buildQueueText() {
  const icons = { queued: "⏳", running: "🔄", done: "✅", error: "❌", cancelled: "🚫" };
  const webhookQueue = loadWebhookQueue();

  if (deployQueue.length === 0 && webhookQueue.length === 0) {
    // Деплой мог быть запущен снаружи (webhook) — проверяем lock-файл
    const isLocked = fs.existsSync(LOCK_FILE);
    if (isLocked) {
      return "📋 <b>Очередь деплоев</b>\n\n🔄 <b>Деплой в процессе</b> (запущен вне бота)\n<i>Логи: кнопка «📋 Логи деплоя»</i>";
    }
    return "📋 <b>Очередь деплоев</b>\n\n✅ Деплоев не запускалось · система готова";
  }

  const lines = [...deployQueue].reverse().map((j) => {
    const elapsed = j.startTime
      ? ` · ⏱ ${formatElapsed((j.endTime ?? Date.now()) - j.startTime)}`
      : "";
    return `${icons[j.status]} <code>#${j.num}</code> <b>${j.label}</b>${elapsed}`;
  });

  // Добавляем webhook-очередь если есть
  if (webhookQueue.length > 0) {
    lines.push(""); // пустая строка для разделения
    webhookQueue.forEach((item, idx) => {
      lines.push(`📨 <b>[webhook-${idx + 1}]</b> ${item.pusher}: ${item.commitMsg.slice(0, 40)}`);
    });
  }

  const active = deployQueue.filter((j) => j.status === "queued" || j.status === "running").length;
  const webhookPending = webhookQueue.length > 0 ? ` + 📨 ${webhookQueue.length} webhook` : "";
  const summary = (active > 0 || webhookPending) ? `\n<i>Активных: ${active}${webhookPending}</i>` : "";

  return `📋 <b>Очередь деплоев</b>${summary}\n\n${lines.join("\n")}`;
}


// ─── PM2 статус ───────────────────────────────────────────────────────────────
function runCommand(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      const out = (stdout || stderr || err?.message || "").trim();
      resolve({ ok: !err, text: out.slice(-3000) || "(нет вывода)" });
    });
  });
}

function runCommandFull(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || err?.message || "").trim();
      resolve({ ok: !err, text: out });
    });
  });
}

async function getPm2Status() {
  const { ok, text } = await runCommandFull("pm2 jlist");
  if (!ok) return `📊 <b>Статус PM2</b>\n\n❌ Ошибка: ${escapeHtml(text.slice(-500))}`;

  let procs;
  try { procs = JSON.parse(text); }
  catch { return `📊 <b>Статус PM2</b>\n\n❌ Не удалось разобрать вывод`; }

  const statusIcon = (s) => ({ online: "🟢", stopped: "🔴", errored: "🔴", waiting: "⏳" }[s] ?? "⚪");

  function formatUptime(ms) {
    if (!ms) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}с`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}м`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}ч ${m % 60}м`;
    return `${Math.floor(h / 24)}д ${h % 24}ч`;
  }

  function formatMem(bytes) {
    if (!bytes) return "—";
    return `${Math.round(bytes / 1024 / 1024)}MB`;
  }

  const lines = procs.map((p) => {
    const icon = statusIcon(p.pm2_env?.status);
    const uptime = p.pm2_env?.status === "online"
      ? formatUptime(Date.now() - p.pm2_env.pm_uptime)
      : "—";
    const mem = formatMem(p.monit?.memory);
    const restarts = p.pm2_env?.restart_time ?? 0;
    return `${icon} <b>${p.name}</b> — ${p.pm2_env?.status ?? "?"}\n   ⏱ ${uptime}  💾 ${mem}  🔄 ${restarts}`;
  });

  return `📊 <b>Статус PM2</b>\n\n${lines.join("\n\n")}`;
}

// ─── Клавиатура управления ────────────────────────────────────────────────────
function mainKeyboard() {
  const config = getContextConfig(currentContext);
  const ci = currentContext === "prod" ? "🟢" : "🟡"; // context icon
  const ctxTarget = currentContext === "prod" ? "🟡 DEV" : "🟢 PROD";
  // PROD = success (зелёные 🟢), DEV = primary (синие 🟡)
  const actionStyle = currentContext === "prod" ? "success" : "primary";
  const contextBtn = { text: `${ci} ${config.label} — переключить на ${ctxTarget}`, callback_data: "switch_context", style: "primary" };
  const modeBtn = deployMode === "auto"
    ? { text: "🤖 Авто-деплой: ВКЛ", callback_data: "toggle_mode" }
    : { text: "✋ Ручной режим: ВКЛ", callback_data: "toggle_mode" };
  const cacheBtn = noCacheAuto
    ? { text: "🔥 Авто без кеша: ВКЛ", callback_data: "toggle_nocache" }
    : { text: "📦 Авто с кешем", callback_data: "toggle_nocache" };

  const btn = (text, callback_data, style) => {
    const b = { text, callback_data };
    if (style) b.style = style;
    return b;
  };

  return {
    inline_keyboard: [
      [contextBtn],
      [btn(`${ci} 🚀 Полный деплой [${config.label}]`, "deploy", actionStyle)],
      [
        btn(`${ci} 🚀 web`, "deploy_web", actionStyle),
        btn(`${ci} 🚀 bot`, "deploy_bot", actionStyle),
      ],
      [
        btn(`${ci} 🔥 все`, "deploy_force", actionStyle),
        btn(`${ci} 🔥 web`, "deploy_web_force", actionStyle),
      ],
      [modeBtn, cacheBtn],
      [
        { text: "📊 Статус PM2", callback_data: "status" },
        { text: "📋 Очередь", callback_data: "deploy_queue" },
      ],
      [
        btn(`${ci} 📋 Логи деплоя`, "logs_deploy"),
        { text: "📋 Логи ошибок", callback_data: "logs_errors" },
      ],
      [
        btn(`${ci} 🔄 ${config.services.web}`, "restart_svc-web", actionStyle),
        btn(`${ci} 🔄 ${config.services.bot}`, "restart_svc-bot", actionStyle),
        btn(`${ci} 🔄 ${config.services.worker}`, "restart_svc-worker", actionStyle),
      ],
      [btn(`${ci} 🔄 Рестарт всех [${config.label}]`, "restart_all", actionStyle)],
      [{ text: "⚙️ Перезагрузить менеджер", callback_data: "reload_manager" }],
      [{ text: "🛑 Стоп всё (очередь + деплой)", callback_data: "stop_all_confirm", style: "danger" }],
    ],
  };
}

// ─── Проверка прав ────────────────────────────────────────────────────────────
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// ─── Обработка callback-кнопок ────────────────────────────────────────────────
async function handleCallback(query) {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  if (!isAdmin(query.from.id)) {
    await answerCallback(query.id, "⛔ Нет доступа");
    return;
  }

  // ── Карточки деплоев: dlogs_*, derr_*, dredo_*, dcancel_* ───────────────
  const JOB_PREFIXES = ["dlogs_", "dredo_", "derr_", "dcancel_"];
  const jobPrefix = JOB_PREFIXES.find((p) => data.startsWith(p));
  if (jobPrefix) {
    const jobId = data.slice(jobPrefix.length);
    const job = getJob(jobId);
    if (!job) {
      await answerCallback(query.id, "⚠️ Деплой не найден");
      return;
    }

    // ── Отмена / остановка ──────────────────────────────────────────────
    if (jobPrefix === "dcancel_") {
      if (job.status === "queued") {
        job.status = "cancelled";
        saveDeployHistory();
        await updateJobCard(job);
        await answerCallback(query.id, "🚫 Деплой отменён");
        runNextJob(); // запустить следующий в очереди, если есть
      } else if (job.status === "running") {
        job.cancelling = true;
        job.status = "cancelled";
        job.endTime = Date.now();
        saveDeployHistory();
        await updateJobCard(job);
        currentChild?.kill("SIGTERM");
        await answerCallback(query.id, "⏹ Остановка запущена...");
      } else {
        await answerCallback(query.id, "ℹ️ Деплой уже завершён");
      }
      return;
    }

    await answerCallback(query.id);

    if (jobPrefix === "dlogs_") {
      // Последние 40 строк лога (ANSI очищен)
      const isRunning = currentJobId === jobId;
      const dlLogFile = job.contextConfig?.logFile || "deploy-prod.log";
      const raw = readLastLines(path.join(LOGS_DIR, dlLogFile), 40);
      const note = isRunning
        ? "🔄 <i>Выполняется — карточка обновляется каждые 4с</i>"
        : "📋 <i>Снимок логов</i>";
      const safe = truncateForTg(escapeHtml(stripAnsi(raw)));
      await tgRequest("editMessageText", {
        chat_id: job.chatId,
        message_id: job.msgId,
        text: `${buildJobHeader(job)}\n\n${note}\n\n<pre>${safe}</pre>`,
        parse_mode: "HTML",
        reply_markup: deployJobKeyboard(job),
      }).catch(() => {});

    } else if (jobPrefix === "derr_") {
      // Только строки с ошибками из лога деплоя + dm-error.log целиком
      const derrLogFile = job.contextConfig?.logFile || "deploy-prod.log";
      const deployRaw = readLastLines(path.join(LOGS_DIR, derrLogFile), 200);
      const errorLines = filterErrorLines(stripAnsi(deployRaw));
      const dmLog = stripAnsi(readLastLines(path.join(LOGS_DIR, "dm-error.log"), 10));
      const hasExtra = dmLog !== "(файл не найден)" && dmLog !== "(файл пуст)";
      const combined = errorLines + (hasExtra ? `\n\n— dm-error.log —\n${dmLog}` : "");
      const safe = truncateForTg(escapeHtml(combined));
      await tgRequest("editMessageText", {
        chat_id: job.chatId,
        message_id: job.msgId,
        text: `${buildJobHeader(job)}\n\n❌ <i>Строки с ошибками:</i>\n\n<pre>${safe}</pre>`,
        parse_mode: "HTML",
        reply_markup: deployJobKeyboard(job),
      }).catch(() => {});

    } else {
      // dredo_ — Передеплой: ставим тот же деплой в очередь (сохраняем noCache и контекст)
      await enqueueDeployFor(chatId, job.script, job.label, job.noCache, job.contextConfig);
    }
    return;
  }

  await answerCallback(query.id);

  // ── Возврат в главное меню ────────────────────────────────────────────────
  if (data === "back_to_main") {
    const config = getContextConfig(currentContext);
    await editMessage(chatId, msgId, `<b>Deploy Manager — nbp [${config.label}]</b>${lastSuccessText()}\n\nВыберите действие:`, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Переключение контекста (PROD / DEV) ────────────────────────────────
  if (data === "switch_context") {
    currentContext = currentContext === "prod" ? "dev" : "prod";
    saveContext();
    const config = getContextConfig(currentContext);
    const icon = currentContext === "prod" ? "🟢" : "🟡";
    await editMessage(chatId, msgId, `${icon} <b>Контекст: ${config.label}</b>\n\nВсе кнопки деплоя и рестарта теперь работают с <b>${config.label}</b>.\nВетка: <code>${config.branch}</code>`, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Переключение режима ───────────────────────────────────────────────────
  if (data === "toggle_mode") {
    deployMode = deployMode === "auto" ? "manual" : "auto";
    saveDeployMode();
    const msg = deployMode === "auto"
      ? "🤖 <b>Авто-деплой включён</b>\n\nПуш в main/develop → деплой запускается автоматически."
      : "✋ <b>Ручной режим включён</b>\n\nПуши не триггерят деплой. Нажмите 🚀 когда будете готовы.";
    await editMessage(chatId, msgId, msg, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Переключение кеша для автодеплоя ─────────────────────────────────────
  if (data === "toggle_nocache") {
    noCacheAuto = !noCacheAuto;
    saveNoCacheAuto();
    const msg = noCacheAuto
      ? "🔥 <b>Авто-деплой без кеша: ВКЛ</b>\n\nВсе автоматические деплои (по пушу) будут собираться с <code>--no-cache</code>.\nЭто медленнее, но гарантирует свежий код."
      : "📦 <b>Авто-деплой с кешем</b>\n\nАвтоматические деплои используют Docker-кеш (быстрее).\nЕсли изменения не появляются — включите «без кеша».";
    await editMessage(chatId, msgId, msg, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Деплои ───────────────────────────────────────────────────────────────
  if (["deploy", "deploy_web", "deploy_bot", "deploy_force", "deploy_web_force"].includes(data)) {
    const noCache = data.endsWith("_force");
    const config = getContextConfig(currentContext);
    const suffix = noCache ? " (--no-cache)" : "";
    const tag = `[${config.label}] `;
    if (data === "deploy" || data === "deploy_force") {
      await enqueueDeployFor(chatId, [DEPLOY_SCRIPT], `${tag}Полный деплой${suffix}`, noCache, config);
    } else if (data === "deploy_web" || data === "deploy_web_force") {
      await enqueueDeployFor(chatId, [DEPLOY_PARTIAL_SCRIPT, "web"], `${tag}Деплой web${suffix}`, noCache, config);
    } else {
      await enqueueDeployFor(chatId, [DEPLOY_PARTIAL_SCRIPT, "bot"], `${tag}Деплой bot${suffix}`, noCache, config);
    }
    return;
  }

  // ── Очередь деплоев ──────────────────────────────────────────────────────
  if (data === "deploy_queue") {
    const hasHistory = deployQueue.some((j) => j.status === "done" || j.status === "error" || j.status === "cancelled");
    const queueKeyboard = {
      inline_keyboard: [
        ...(hasHistory ? [[{ text: "🗑 Очистить историю", callback_data: "clear_queue", style: "danger" }]] : []),
        [{ text: "◀️ Назад", callback_data: "back_to_main" }],
      ],
    };
    await editMessage(chatId, msgId, buildQueueText(), { reply_markup: queueKeyboard });
    return;
  }

  if (data === "clear_queue") {
    // Удаляем завершённые/отменённые, активные (queued/running) оставляем
    const before = deployQueue.length;
    deployQueue.splice(0, deployQueue.length,
      ...deployQueue.filter((j) => j.status === "queued" || j.status === "running")
    );
    const removed = before - deployQueue.length;
    const hasHistory = deployQueue.some((j) => j.status === "done" || j.status === "error" || j.status === "cancelled");
    const queueKeyboard = {
      inline_keyboard: [
        ...(hasHistory ? [[{ text: "🗑 Очистить историю", callback_data: "clear_queue", style: "danger" }]] : []),
        [{ text: "◀️ Назад", callback_data: "back_to_main" }],
      ],
    };
    await editMessage(chatId, msgId,
      `${buildQueueText()}\n\n<i>🗑 Удалено из истории: ${removed}</i>`,
      { reply_markup: queueKeyboard }
    );
    return;
  }

  // ── Статус PM2 ────────────────────────────────────────────────────────────
  if (data === "status") {
    const statusText = await getPm2Status();
    await editMessage(chatId, msgId, statusText, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Логи деплоя ──────────────────────────────────────────────────────────
  if (data === "logs_deploy") {
    const config = getContextConfig(currentContext);
    const lines = stripAnsi(readLastLines(path.join(LOGS_DIR, config.logFile), 30));
    await editMessage(
      chatId, msgId,
      `📋 <b>Логи деплоя [${config.label}] (последние 30 строк)</b>\n\n<pre>${truncateForTg(escapeHtml(lines))}</pre>`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  // ── Логи ошибок ───────────────────────────────────────────────────────────
  if (data === "logs_errors") {
    const services = ["web", "bot", "worker"];
    let combined = "";
    for (const svc of services) {
      const lines = stripAnsi(readLastLines(path.join(LOGS_DIR, `${svc}-error.log`), 8));
      if (lines !== "(файл не найден)" && lines !== "(файл пуст)") {
        combined += `\n— ${svc} —\n${lines}\n`;
      }
    }
    await editMessage(
      chatId, msgId,
      `📋 <b>Логи ошибок</b>\n\n<pre>${truncateForTg(escapeHtml(combined || "(нет ошибок)"))}</pre>`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  // ── Стоп всех деплоев: запрос подтверждения ──────────────────────────────
  if (data === "stop_all_confirm") {
    const running = deployQueue.filter((j) => j.status === "running").length;
    const queued  = deployQueue.filter((j) => j.status === "queued").length;
    const parts = [];
    if (running) parts.push(`🔄 Текущий деплой: <b>будет убит</b>`);
    if (queued)  parts.push(`⏳ В очереди: <b>${queued} шт. — будут отменены</b>`);
    const info = parts.length ? `\n\n${parts.join("\n")}` : "\n\n(активных деплоев нет)";

    await editMessage(chatId, msgId,
      `🛑 <b>Остановить все деплои?</b>${info}`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Да, остановить", callback_data: "stop_all_deploys", style: "danger" },
            { text: "❌ Отмена",         callback_data: "back_to_main" },
          ]],
        },
      }
    );
    return;
  }

  // ── Стоп всех деплоев и очистка очереди ──────────────────────────────────
  if (data === "stop_all_deploys") {
    let stopped = 0;
    let cancelled = 0;

    // Отменяем все queued
    for (const job of deployQueue) {
      if (job.status === "queued") {
        job.status = "cancelled";
        updateJobCard(job).catch(() => {});
        cancelled++;
      }
    }

    // Убиваем текущий running
    if (currentJobId && currentChild) {
      const runningJob = getJob(currentJobId);
      if (runningJob) {
        runningJob.cancelling = true;
        runningJob.status = "cancelled";
        runningJob.endTime = Date.now();
        updateJobCard(runningJob).catch(() => {});
      }
      currentChild.kill("SIGTERM");
      stopped = 1;
    }

    const parts = [];
    if (stopped) parts.push(`⏹ Остановлен текущий деплой`);
    if (cancelled) parts.push(`🚫 Отменено из очереди: ${cancelled}`);
    const msg = parts.length
      ? `🛑 <b>Готово</b>\n\n${parts.join("\n")}\n\nМожно запускать деплой.`
      : "✅ Нет активных деплоев — очередь пуста.";

    await editMessage(chatId, msgId, msg, { reply_markup: mainKeyboard() });
    return;
  }

  // ── Перезагрузка этого бота (менеджера) ────────────────────────────────────
  if (data === "reload_manager") {
    await editMessage(chatId, msgId,
      `⏳ <b>Перезагрузка менеджера...</b>\n\n<i>Бот переподключится через несколько секунд.</i>`,
      { reply_markup: mainKeyboard() }
    );
    // Запускаем рестарт через 300мс — чтобы editMessage успел отправиться.
    // Используем restart вместо reload (fork-режим не поддерживает graceful reload)
    // и --force чтобы не получать "Reload already in progress".
    setTimeout(() => {
      exec(`pm2 restart ${DM_PROCESS_NAME} --update-env --no-color --force`, (e) => {
        if (e) log(`[WARN] Manager restart failed: ${e.message}`);
      });
    }, 300);
    return;
  }

  // ── Рестарт процесса ──────────────────────────────────────────────────────
  if (data.startsWith("restart_")) {
    const isAll = data === "restart_all";
    const config = getContextConfig(currentContext);
    const COMPOSE = `docker compose -f ${config.workDir}/${config.composeFile}`;

    let cmd, label;
    if (isAll) {
      const allSvcs = Object.values(config.services).join(" ");
      cmd = `${COMPOSE} restart ${allSvcs}`;
      label = `${allSvcs} [${config.label}]`;
    } else if (data.startsWith("restart_svc-")) {
      // Контекстно-зависимый рестарт: restart_svc-web → config.services.web
      const svcKey = data.replace("restart_svc-", "");
      const dockerSvc = config.services[svcKey];
      if (dockerSvc) {
        cmd = `${COMPOSE} restart ${dockerSvc}`;
        label = `${dockerSvc} [${config.label}]`;
      } else {
        cmd = `echo "Unknown service: ${svcKey}"`;
        label = svcKey;
      }
    } else {
      // Обратная совместимость: restart_nbp-webhook и другие PM2-процессы
      const rawTarget = data.replace("restart_", "");
      cmd = `pm2 restart ${rawTarget} --update-env --no-color`;
      label = rawTarget;
    }

    await editMessage(chatId, msgId, `⏳ Рестарт <b>${label}</b>...`, {
      reply_markup: mainKeyboard(),
    });

    const { ok, text } = await runCommand(cmd, 60000);
    await editMessage(
      chatId, msgId,
      ok
        ? `✅ <b>${label}</b> перезапущен`
        : `❌ Ошибка рестарта <b>${label}</b>\n<pre>${escapeHtml(text)}</pre>`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }
}

// ─── Обработка сообщений ──────────────────────────────────────────────────────
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";

  if (!isAdmin(msg.from?.id)) {
    await sendMessage(chatId, "⛔ Нет доступа");
    return;
  }

  if (text === "/start" || text === "/menu") {
    const config = getContextConfig(currentContext);
    const active = deployQueue.filter((j) => j.status === "queued" || j.status === "running");
    const queueInfo = active.length > 0
      ? `\n\n⏳ <i>В очереди/выполняется: ${active.length}</i>`
      : "";
    await sendMessage(
      chatId,
      `<b>Deploy Manager — nbp [${config.label}]</b>${lastSuccessText()}${queueInfo}\n\nВыберите действие на панели ниже.\n/help — список всех команд`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      `📖 <b>Руководство по боту деплоя</b>\n\n` +

      `<b>━━ РЕЖИМ ДЕПЛОЯ ━━</b>\n\n` +
      `🤖 <b>Авто-деплой ВКЛ</b>\n` +
      `Каждый пуш в ветку main автоматически запускает деплой. Нажмите кнопку — переключится в ручной.\n\n` +
      `✋ <b>Ручной режим ВКЛ</b>\n` +
      `Пуши в GitHub игнорируются. Деплой запускается только по вашей команде.\n\n` +

      `🔥 <b>Авто без кеша: ВКЛ / 📦 Авто с кешем</b>\n` +
      `Переключает, будут ли автоматические деплои (по пушу) собираться с <code>--no-cache</code>.\n` +
      `Включите если после пуша изменения не попадают в прод — Docker берёт старый код из кеша.\n\n` +

      `<b>━━ КНОПКИ ДЕПЛОЯ ━━</b>\n\n` +
      `🚀 <b>Полный деплой</b>\n` +
      `git pull + пересборка Docker-образов web, bot, worker + запуск.\n` +
      `Использует кеш — быстро (3–5 мин).\n\n` +
      `🚀 <b>Деплой web / Деплой bot</b>\n` +
      `То же самое, но только для одного сервиса. Если поменяли только фронтенд — деплойте только web.\n\n` +
      `🔥 <b>Без кеша: все / Без кеша: web</b>\n` +
      `Пересборка с нуля, без Docker-кеша. Используйте если после обычного деплоя <b>изменения не появились</b>. Дольше (+5–10 мин), но гарантированно применяет все изменения.\n\n` +
      `💡 <i>Что такое кеш: Docker запоминает шаги сборки. Обычно это ускоряет работу, но иногда он берёт старую версию кода из памяти вместо новой. Тогда жмите «Без кеша».</i>\n\n` +

      `<b>━━ РЕСТАРТ СЕРВИСОВ ━━</b>\n\n` +
      `🔄 <b>web / bot / worker</b>\n` +
      `Перезапускает Docker-контейнер без пересборки. Код не обновляется. Используйте если сервис завис.\n\n` +
      `🔄 <b>Рестарт всех</b>\n` +
      `Перезапускает web + bot + worker одновременно.\n\n` +

      `<b>━━ МОНИТОРИНГ ━━</b>\n\n` +
      `📊 <b>Статус PM2</b>\n` +
      `Показывает только 2 фоновых процесса на сервере:\n` +
      `• <code>${DM_PROCESS_NAME}</code> — этот бот\n` +
      `• <code>${PROJECT_NAME}-webhook</code> — слушает GitHub, ставит деплой в очередь при пуше\n` +
      `<i>Основные сервисы (web, bot, worker) — в Docker, их здесь нет.</i>\n\n` +
      `📋 <b>Очередь</b> — история и статус всех деплоев, можно отменить ожидающий.\n` +
      `📋 <b>Логи деплоя</b> — последние строки сборки. Смотрите сюда если деплой упал.\n` +
      `📋 <b>Логи ошибок</b> — ошибки из логов web, bot, worker.\n\n` +

      `<b>━━ КАРТОЧКА ДЕПЛОЯ ━━</b>\n\n` +
      `После запуска появляется карточка, которая обновляется каждые 4 сек.\n` +
      `📋 <b>Логи</b> — что происходит прямо сейчас\n` +
      `❌ <b>Ошибки</b> — только строки с ошибками (если упал)\n` +
      `🔄 <b>Передеплой</b> — запустить этот же деплой ещё раз\n\n` +

      `<b>━━ ТИПИЧНЫЕ СЦЕНАРИИ ━━</b>\n\n` +
      `Запушил → задеплоилось само → <i>авто-режим работает</i>\n` +
      `Нужно задеплоить вручную → 🚀 <b>Полный деплой</b>\n` +
      `Изменения не появились → 🔥 <b>Без кеша: все</b>\n` +
      `Сайт завис → 🔄 <b>web</b>\n` +
      `Не хочу авто-деплой → ✋ <b>Ручной режим</b>`,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (text === "/deploy") {
    await enqueueDeployFor(chatId, [DEPLOY_SCRIPT], `Полный деплой`);
    return;
  }

  if (text === "/mode") {
    deployMode = deployMode === "auto" ? "manual" : "auto";
    saveDeployMode();
    const modeMsg = deployMode === "auto"
      ? "🤖 <b>Авто-деплой включён</b>\n\nПуш в main → деплой запускается автоматически."
      : "✋ <b>Ручной режим включён</b>\n\nПуши не триггерят деплой. Нажмите 🚀 когда будете готовы.";
    await sendMessage(chatId, modeMsg, { reply_markup: mainKeyboard() });
    return;
  }

  if (text === "/status") {
    const statusText = await getPm2Status();
    await sendMessage(chatId, statusText, { reply_markup: mainKeyboard() });
    return;
  }

  await sendMessage(chatId, "Выберите действие:", { reply_markup: mainKeyboard() });
}

// ─── Long polling ─────────────────────────────────────────────────────────────
async function poll() {
  try {
    const res = await tgRequest("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    }, 40000); // 40s HTTP timeout для long-polling (Telegram timeout=30s + запас)

    if (!res.ok || !Array.isArray(res.result)) {
      await new Promise((r) => setTimeout(r, 3000));
      return;
    }

    for (const update of res.result) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) await handleCallback(update.callback_query);
        else if (update.message) await handleMessage(update.message);
      } catch (err) {
        log(`[ERROR] Update handling: ${err.message}`);
      }
    }
  } catch (err) {
    log(`[ERROR] Polling: ${err.message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// ─── Опрос webhook-очереди ────────────────────────────────────────────────────
// Запускается каждые 5 секунд — забирает задания от nbp-webhook
// и выполняет их через обычную очередь (с карточкой и live-стримингом).
function startWebhookQueuePoller() {
  setInterval(async () => {
    if (currentJobId) return; // деплой уже идёт
    const webhook = getNextWebhook();
    if (!webhook) return;
    log(`[INFO] Webhook queue: picked up "${webhook.commitMsg}" by ${webhook.pusher} (branch: ${webhook.branch})`);
    const chatId = ADMIN_IDS[0];
    if (chatId) {
      // Маршрутизация по ветке: develop → dev, main → prod
      const ctx = webhook.branch === "develop" ? "dev" : "prod";
      const config = getContextConfig(ctx);
      const hashPart = webhook.commitHash ? ` · ${webhook.commitHash}` : "";
      const prPart = webhook.prNumber ? ` · PR #${webhook.prNumber}` : "";
      const suffix = noCacheAuto ? " (--no-cache)" : "";
      await enqueueDeployFor(
        chatId,
        [DEPLOY_SCRIPT],
        `🔔 [${config.label}] Webhook${hashPart}${prPart}: ${webhook.commitMsg}${suffix}`,
        noCacheAuto,
        config
      );
    }
  }, 5000);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
async function start() {
  log("[INFO] Deploy Manager Bot started");
  log(`[INFO] Admins: ${ADMIN_IDS.join(", ")}`);
  log(`[INFO] Project: ${PROJECT_DIR}`);
  loadDeployMode();
  loadNoCacheAuto();
  loadLastSuccess();
  loadContext();
  loadDeployHistory();
  log(`[INFO] Deploy mode: ${deployMode}, no-cache auto: ${noCacheAuto}, context: ${currentContext}`);
  log(`[INFO] Loaded ${deployQueue.length} jobs from history`);

  for (const id of ADMIN_IDS) {
    sendMessage(id, "🟢 <b>Система деплоя активна</b>\n\nГотова к работе. /start — открыть панель.").catch(() => {});
  }

  // Проверяем webhook queue при старте
  if (!currentJobId) {
    const webhook = getNextWebhook();
    if (webhook) {
      log(`[INFO] Found webhook in queue at startup: "${webhook.commitMsg}" (branch: ${webhook.branch})`);
      const chatId = ADMIN_IDS[0];
      if (chatId) {
        const startCtx = webhook.branch === "develop" ? "dev" : "prod";
        const startConfig = getContextConfig(startCtx);
        const hashPart = webhook.commitHash ? ` · ${webhook.commitHash}` : "";
        const startPrPart = webhook.prNumber ? ` · PR #${webhook.prNumber}` : "";
        const suffix = noCacheAuto ? " (--no-cache)" : "";
        await enqueueDeployFor(
          chatId,
          [DEPLOY_SCRIPT],
          `🔔 [${startConfig.label}] Webhook${hashPart}${startPrPart}: ${webhook.commitMsg}${suffix}`,
          noCacheAuto,
          startConfig
        );
      }
    }
  }

  // Запускаем периодический опрос webhook-очереди
  startWebhookQueuePoller();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await poll();
  }
}

start();

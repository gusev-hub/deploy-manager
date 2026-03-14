#!/usr/bin/env bash
# =============================================================================
# deploy.sh — автодеплой Nano Banana Pro на Beget VPS
#
# Архитектура:
#   web, bot, worker — Docker контейнеры (docker compose build + up)
#   nbp-dm, nbp-webhook — PM2 процессы на хосте
#
# Переменные окружения:
#   PROJECT_DIR              — корень проекта
#   GIT_BRANCH               — ветка (по умолчанию: main)
#   PROJECT_NAME             — имя в уведомлениях (по умолчанию: nbp)
#   BOT_DEPLOY_MANAGER_TOKEN — токен Telegram-бота
#   ADMIN_TG_IDS             — список ID через запятую
#   TELEGRAM_CHAT_ID         — конкретный chat_id (перекрывает ADMIN_TG_IDS)
#   DEPLOY_SOURCE            — если "bot", TG-уведомления пропускаются
# =============================================================================
set -euo pipefail

# ─── Конфигурация ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
WORK_DIR="${WORK_DIR:-${PROJECT_DIR}}"
GIT_BRANCH="${GIT_BRANCH:-main}"
PROJECT_NAME="${PROJECT_NAME:-nbp}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
DEPLOY_SERVICES="${DEPLOY_SERVICES:-web bot worker}"
STACK_NAME="${STACK_NAME:-prod}"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/deploy-${STACK_NAME}.log"

BOT_TOKEN="${BOT_DEPLOY_MANAGER_TOKEN:-}"

if [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
  CHAT_ID="${TELEGRAM_CHAT_ID}"
else
  CHAT_ID="$(echo "${ADMIN_TG_IDS:-}" | cut -d',' -f1 | tr -d ' ')"
fi

# ─── Логирование ──────────────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"
exec >> "$LOG_FILE" 2>&1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Диагностика окружения ────────────────────────────────────────────────────
log "START: user=$(id -un 2>/dev/null) home=${HOME:-?}"
log "PATH: ${PATH:-?}"
log "CMDS: git=$(command -v git 2>/dev/null || echo MISSING) docker=$(command -v docker 2>/dev/null || echo MISSING)"

# Проверяем доступ к Docker daemon — самая частая причина падения из PM2
if ! docker info > /dev/null 2>&1; then
  log "ERROR: docker daemon недоступен для пользователя $(id -un)"
  log "HINT: sudo usermod -aG docker $(id -un) && pm2 restart all"
  exit 1
fi
log "DOCKER: daemon OK ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"

# ─── Номер деплоя ─────────────────────────────────────────────────────────────
COUNTER_FILE="${LOG_DIR}/deploy-counter.txt"
DEPLOY_NUM=$(( $(cat "${COUNTER_FILE}" 2>/dev/null || echo "0") + 1 ))
echo "$DEPLOY_NUM" > "${COUNTER_FILE}"

# ─── Telegram-уведомления ─────────────────────────────────────────────────────
_tg_json_text() {
  python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "${1}" 2>/dev/null \
    || echo "\"${1//\"/\\\"}\""
}

tg_send_capture() {
  local text="$1" reply_to="${2:-}"
  [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" ]] && echo "" && return 0
  local json_text payload response
  json_text="$(_tg_json_text "${text}")"
  payload="{\"chat_id\":\"${CHAT_ID}\",\"text\":${json_text},\"parse_mode\":\"HTML\"}"
  [[ -n "$reply_to" ]] && \
    payload="{\"chat_id\":\"${CHAT_ID}\",\"text\":${json_text},\"parse_mode\":\"HTML\",\"reply_to_message_id\":${reply_to}}"
  response="$(curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" -d "$payload" --max-time 10 2>/dev/null || echo "")"
  python3 -c "
import json,sys
try: print(json.load(sys.stdin).get('result',{}).get('message_id',''))
except: print('')
" <<< "$response" 2>/dev/null || echo ""
}

tg_send() { tg_send_capture "$@" > /dev/null; }

tg_edit_message() {
  local msg_id="$1" text="$2"
  [[ -z "$BOT_TOKEN" || -z "$CHAT_ID" || -z "$msg_id" ]] && return 0
  local json_text
  json_text="$(_tg_json_text "${text}")"
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/editMessageText" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\":\"${CHAT_ID}\",\"message_id\":${msg_id},\"text\":${json_text},\"parse_mode\":\"HTML\"}" \
    --max-time 10 > /dev/null 2>&1 || true
}

# Если деплой запущен из бота — он сам уведомляет, пропускаем TG-отправку
if [[ "${DEPLOY_SOURCE:-}" == "bot" ]]; then
  tg_send()         { :; }
  tg_send_capture() { echo ""; }
  tg_edit_message() { :; }
fi

# ─── Форматирование длительности ──────────────────────────────────────────────
format_elapsed() {
  local secs=$1
  if [[ $secs -lt 60 ]]; then echo "${secs}с"; else echo "$((secs / 60))м $((secs % 60))с"; fi
}

# ─── Прогресс-сообщение ───────────────────────────────────────────────────────
STEP_GIT="⏳ git pull"
STEP_BUILD="⏳ docker build"
STEP_UP="⏳ docker up"
MSG_HEADER=""
MSG_META=""
START_MSG_ID=""
T_STEP_START=0

update_progress_msg() {
  [[ -z "${START_MSG_ID}" ]] && return 0
  tg_edit_message "${START_MSG_ID}" "${MSG_HEADER}
${MSG_META}

${STEP_GIT}
${STEP_BUILD}
${STEP_UP}"
}

# ─── Обработка ошибок ─────────────────────────────────────────────────────────
STEPS_DONE=""
CURRENT_STEP=""
START_TIME=$(date +%s)
COMMIT_BEFORE="unknown"
COMMIT_AFTER=""

on_exit() {
  local exit_code=$?
  local elapsed
  elapsed=$(format_elapsed $(( $(date +%s) - START_TIME )))

  if [[ $exit_code -ne 0 ]]; then
    local step_e=""
    [[ "${T_STEP_START}" -gt 0 ]] && step_e=" — $(format_elapsed $(( $(date +%s) - T_STEP_START )))"
    case "$CURRENT_STEP" in
      "git pull")      STEP_GIT="❌ git pull${step_e}" ;;
      "docker build")  STEP_BUILD="❌ docker build${step_e}" ;;
      "docker up")     STEP_UP="❌ docker up${step_e}" ;;
    esac

    MSG_HEADER="❌ <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} упал</b> — ${elapsed}"
    MSG_META="📌 <code>${COMMIT_BEFORE}</code>"
    [[ -n "${COMMIT_AFTER}" ]] && MSG_META="📌 <code>${COMMIT_BEFORE}</code> → <code>${COMMIT_AFTER}</code>"
    update_progress_msg

    local last_log
    last_log="$(tail -n 15 "${LOG_FILE}" 2>/dev/null \
      | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g' \
      | head -c 1500)"

    local steps_info=""
    [[ -n "$STEPS_DONE" ]] && steps_info="
<b>Выполнено:</b> ${STEPS_DONE}"

    local commit_info="${COMMIT_BEFORE}"
    [[ -n "${COMMIT_AFTER}" && "${COMMIT_AFTER}" != "${COMMIT_BEFORE}" ]] && \
      commit_info="${COMMIT_BEFORE} → ${COMMIT_AFTER}"

    tg_send "❌ <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} упал</b>
⏱ Длительность: <b>${elapsed}</b>
📌 Коммит: <code>${commit_info}</code>
Шаг: <code>${CURRENT_STEP}</code>${steps_info}
<b>Лог:</b>
<pre>${last_log}</pre>" "${START_MSG_ID}"

    log "=== ДЕПЛОЙ ЗАВЕРШИЛСЯ С ОШИБКОЙ (код: ${exit_code}) ==="
  fi
}
trap on_exit EXIT

# ─── Старт ────────────────────────────────────────────────────────────────────
cd "$WORK_DIR"
log "==================================================================="
log "=== ДЕПЛОЙ #${DEPLOY_NUM} НАЧАТ ==="

COMMIT_BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

MSG_HEADER="🚀 <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} начат</b>"
MSG_META="Ветка: <code>${GIT_BRANCH}</code> · <code>${COMMIT_BEFORE}</code>"

START_MSG_ID="$(tg_send_capture "${MSG_HEADER}
${MSG_META}
Время: $(date '+%d.%m.%Y %H:%M:%S')")"

MSG_HEADER="🔄 <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} · в процессе</b>"
update_progress_msg

# ─── 1. Git pull ──────────────────────────────────────────────────────────────
CURRENT_STEP="git pull"
STEP_GIT="🔄 git pull..."
T_STEP_START=$(date +%s)
update_progress_msg

log ">>> git fetch --all --prune && git reset --hard origin/${GIT_BRANCH}"
git fetch --all --prune
git reset --hard "origin/${GIT_BRANCH}"

COMMIT_AFTER="$(git rev-parse --short HEAD)"
COMMIT_MSG="$(git log -1 --pretty=format:"%s" | head -c 200)"
COMMITS_PULLED="$(git log --oneline "${COMMIT_BEFORE}..${COMMIT_AFTER}" 2>/dev/null | wc -l | tr -d ' ')"
log "Коммит: ${COMMIT_AFTER} — ${COMMIT_MSG} (+${COMMITS_PULLED})"

STEP_GIT="✅ git pull (+${COMMITS_PULLED}) — $(format_elapsed $(( $(date +%s) - T_STEP_START )))"
MSG_META="<code>${COMMIT_BEFORE}</code> → <code>${COMMIT_AFTER}</code> (+${COMMITS_PULLED})"
STEPS_DONE="✅ git pull (+${COMMITS_PULLED} коммитов)"
update_progress_msg

# ─── 2. Docker build ──────────────────────────────────────────────────────────
CURRENT_STEP="docker build"
STEP_BUILD="🔄 docker build${NO_CACHE:+ (--no-cache)}..."
T_STEP_START=$(date +%s)
update_progress_msg

BUILD_FLAGS=""
[[ "${NO_CACHE:-}" == "1" ]] && BUILD_FLAGS="--no-cache"
export GIT_COMMIT
GIT_COMMIT="$(git rev-parse --short HEAD)"
log ">>> docker compose -f ${COMPOSE_FILE} build ${BUILD_FLAGS} ${DEPLOY_SERVICES}"
docker compose -f "${COMPOSE_FILE}" build ${BUILD_FLAGS} ${DEPLOY_SERVICES}

STEP_BUILD="✅ docker build — $(format_elapsed $(( $(date +%s) - T_STEP_START )))"
STEPS_DONE="${STEPS_DONE}, ✅ docker build"
update_progress_msg

# ─── 3. Docker up ─────────────────────────────────────────────────────────────
CURRENT_STEP="docker up"
STEP_UP="🔄 docker up..."
T_STEP_START=$(date +%s)
update_progress_msg

UP_FLAGS=""
[[ "${NO_CACHE:-}" == "1" ]] && UP_FLAGS="--force-recreate"
log ">>> docker compose -f ${COMPOSE_FILE} up -d ${UP_FLAGS} ${DEPLOY_SERVICES}"
docker compose -f "${COMPOSE_FILE}" up -d ${UP_FLAGS} ${DEPLOY_SERVICES}

STEP_UP="✅ docker up — $(format_elapsed $(( $(date +%s) - T_STEP_START )))"
STEPS_DONE="${STEPS_DONE}, ✅ docker up"
update_progress_msg

# ─── Успех ────────────────────────────────────────────────────────────────────
COMMIT_MSG_SAFE="$(echo "${COMMIT_MSG}" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
ELAPSED=$(format_elapsed $(( $(date +%s) - START_TIME )))

log "=== ДЕПЛОЙ #${DEPLOY_NUM} ЗАВЕРШЁН УСПЕШНО за ${ELAPSED} ==="

MSG_HEADER="✅ <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} завершён</b> — ${ELAPSED}"
MSG_META="📝 <code>${COMMIT_AFTER}</code> — ${COMMIT_MSG_SAFE}"
update_progress_msg

tg_send "✅ <b>[${PROJECT_NAME}] Деплой #${DEPLOY_NUM} завершён</b>
⏱ Длительность: <b>${ELAPSED}</b>
🌿 Ветка: <code>${GIT_BRANCH}</code>
📝 Коммит: <code>${COMMIT_AFTER}</code> — ${COMMIT_MSG_SAFE}

<b>Шаги:</b>
${STEPS_DONE}" "${START_MSG_ID}"

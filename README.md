# Deploy Manager Bot

Telegram-бот для автоматического деплоя Docker-проектов через GitHub webhook с live-стримингом логов.

## Возможности

- **Автодеплой**: push в GitHub → webhook → деплой → уведомление в Telegram
- **Live-стриминг**: карточка деплоя обновляется каждые 4 секунды с логами
- **Очередь**: несколько пушей подряд — деплои выполняются по очереди
- **Multi-environment**: поддержка PROD/DEV с переключением контекста
- **Кнопки управления**: деплой, рестарт сервисов, логи, ошибки, передеплой
- **Режимы**: авто-деплой / ручной (пуши игнорируются)
- **No-cache**: пересборка без Docker-кеша одной кнопкой
- **PR в уведомлениях**: номер PR парсится из commit message
- **Персистентность**: история деплоев сохраняется между рестартами

## Архитектура

```
GitHub push → Webhook Server (PM2, :3010)
                    ↓
            Проверка подписи HMAC-SHA256
                    ↓
            Очередь (webhook-queue.json)
                    ↓
            Deploy Manager Bot (PM2)
                    ↓
            deploy.sh (git pull + docker compose build + up)
                    ↓
            Live-карточка в Telegram с логами
```

## Быстрый старт

### 1. Скопировать файлы в проект

```bash
# Клонировать
git clone https://github.com/gusev-hub/deploy-manager.git

# Скопировать в свой проект
cp -r deploy-manager/scripts/ /opt/my-project/scripts/
cp deploy-manager/ecosystem.config.js /opt/my-project/
cp deploy-manager/.env.deploy.example /opt/my-project/
```

Или добавить как git submodule:
```bash
cd /opt/my-project
git submodule add https://github.com/gusev-hub/deploy-manager.git deploy-manager
```

### 2. Создать Telegram-бота

1. Открыть [@BotFather](https://t.me/BotFather) в Telegram
2. `/newbot` → задать имя (например `MyApp Deploy`)
3. Скопировать токен

### 3. Настроить переменные

```bash
cp .env.deploy.example .env.deploy
nano .env.deploy
```

Обязательные переменные:

```env
DEPLOY_SECRET=random_secret_for_github_webhook
PROJECT_DIR=/opt/my-project
PROJECT_NAME=myapp
BOT_DEPLOY_MANAGER_TOKEN=123456:ABC-DEF...
ADMIN_TG_IDS=your_telegram_id
```

### 4. Настроить GitHub webhook

GitHub → Settings → Webhooks → Add webhook:
- **Payload URL**: `https://yourdomain.com/deploy-hook`
- **Content type**: `application/json`
- **Secret**: значение `DEPLOY_SECRET` из `.env.deploy`
- **Events**: Just the push event

### 5. Настроить reverse proxy

Добавить в Caddyfile (или nginx):
```
yourdomain.com {
    handle /deploy-hook* {
        reverse_proxy host.docker.internal:3010
    }
    handle {
        reverse_proxy web:3000
    }
}
```

### 6. Запустить PM2

```bash
cd /opt/my-project
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup  # автозапуск при перезагрузке сервера
```

### 7. Проверить

Отправь `/start` боту в Telegram — должна появиться панель управления.

## Конфигурация

### Переменные окружения (.env.deploy)

| Переменная | Обязательна | Описание |
|------------|:-----------:|----------|
| `DEPLOY_SECRET` | да | Секрет GitHub webhook (HMAC-SHA256) |
| `PROJECT_DIR` | да | Абсолютный путь к проекту на сервере |
| `PROJECT_NAME` | да | Имя проекта (для PM2, уведомлений) |
| `BOT_DEPLOY_MANAGER_TOKEN` | да | Токен Telegram-бота |
| `ADMIN_TG_IDS` | да | Telegram ID администраторов (через запятую) |
| `WEBHOOK_PORT` | нет | Порт webhook-сервера (по умолчанию: 3010) |
| `GIT_BRANCHES` | нет | Ветки для деплоя (по умолчанию: main) |
| `DEV_WORK_DIR` | нет | Путь к dev-worktree для multi-env |

### Deploy-скрипты (переменные окружения)

Передаются ботом при запуске `deploy.sh`:

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `COMPOSE_FILE` | `docker-compose.yml` | Docker Compose файл |
| `WORK_DIR` | `$PROJECT_DIR` | Рабочая директория (git + docker) |
| `DEPLOY_SERVICES` | `web bot worker` | Сервисы для деплоя (через пробел) |
| `STACK_NAME` | `prod` | Имя стека (для раздельных логов) |
| `GIT_BRANCH` | `main` | Ветка для `git reset --hard` |
| `NO_CACHE` | — | Если `1` — сборка без Docker-кеша |

## Multi-environment (PROD + DEV)

Deploy Manager поддерживает две среды на одном сервере.

### Настройка

1. **Git worktree** для dev-ветки:
```bash
cd /opt/my-project
git worktree add /opt/my-project-dev develop
```

2. **`.env.deploy`** — добавить ветку:
```env
GIT_BRANCHES=main,develop
```

3. **Docker Compose** — создать `docker-compose.dev.yml` для dev-стека

4. **Caddy** — добавить dev-домен:
```
dev.yourdomain.com {
    handle { reverse_proxy dev-web:3000 }
}
```

### Как работает

- Push в `main` → автодеплой PROD
- Push в `develop` → автодеплой DEV
- UI бота: кнопка переключения контекста 🟢 PROD / 🟡 DEV
- Все кнопки (деплой, рестарт, логи) работают с выбранным контекстом
- Цветовая дифференциация: PROD = зелёные кнопки (success), DEV = синие (primary)

## Структура файлов

```
scripts/
├── tg-bot.js              # Deploy Manager Bot (Telegram long polling)
├── deploy.sh              # Полный деплой (git pull + docker build + up)
├── deploy-partial.sh      # Деплой одного сервиса
└── webhook/
    └── index.js           # GitHub webhook сервер (HTTP)
ecosystem.config.js        # PM2 конфигурация (2 процесса)
.env.deploy.example        # Шаблон переменных
```

## Кастомизация

### Свои сервисы

В `deploy-partial.sh` задать доступные target'ы:
```bash
case "$TARGET" in
  web) LABEL="Web" ;;
  bot) LABEL="Bot" ;;
  api) LABEL="API" ;;   # добавить свой
  *)
    log "Неизвестный target: ${TARGET}"
    exit 1
    ;;
esac
```

### Свои кнопки рестарта

В `tg-bot.js` → `mainKeyboard()` — изменить кнопки рестарта сервисов.

### Интеграция с другими системами

Webhook-сервер принимает стандартный GitHub Push webhook. Для GitLab/Bitbucket нужно адаптировать парсинг payload в `webhook/index.js`.

## Требования

- Node.js 20+
- PM2 (`npm install -g pm2`)
- Docker + Docker Compose
- Reverse proxy (Caddy / nginx) для проксирования webhook'ов

## Лицензия

MIT

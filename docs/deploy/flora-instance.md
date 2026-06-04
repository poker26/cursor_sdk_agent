# Изолированный инстанс «flora» (тест MCP historical-recipes)

Отдельный процесс того же кода с урезанным `.env`. Изоляция достигается тем, что
на этом сервере **нет кредов рабочих MCP / Supabase / Telegram** — агент к ним
не может подключиться в принципе.

## Что отключено и почему
- **Рабочие MCP** (Atlassian, GitLab, Minio, Exchange, Notion) — их URL/ключи не заданы → `buildMcpServersConfiguration()` их не добавляет.
- **Brain-память** (Supabase, Qdrant) — `SUPABASE_URL`/`QDRANT_URL` не заданы → выключены.
- **Telegram + мониторинг Jira** — `TELEGRAM_*` не заданы → `isMonitoringEnabled()` = false.
- **VPN-индикатор** — `UI_SHOW_VPN_INDICATOR=false` (скрыт в UI, опрос не запускается).
- **Прикрепление файлов** — `UI_ALLOW_ATTACHMENTS=false` (кнопка и поле скрыты).
- **Авторизация** — `CHAT_BASIC_*` не заданы.
- **Рабочий промпт** — заменён flora-бутстрапом и нейтральным голосовым стилем.

## Что осталось
- MCP **historical-recipes** (единственный).
- **Голос**: вход голосом → краткий ответ; вход текстом → полный ответ.
- Своя **чистая** `memory.md` в отдельном `AGENT_CWD`.

## Шаги развёртывания (выполняет пользователь на сервере)

1. Клонировать репозиторий и собрать:
   - `git clone <repo> /root/cursor_sdk_agent_flora`
   - `cd /root/cursor_sdk_agent_flora`
   - `npm install`
   - `npm run build`
2. Создать изолированный рабочий каталог: `mkdir -p /root/flora-agent-workspace`
3. Скопировать `.env.flora.example` → `.env`, заполнить `CURSOR_API_KEY`, `YANDEX_*`.
4. Запустить отдельным процессом PM2 (имя не должно совпадать с рабочим):
   - `pm2 start dist/index.js --name cursor-sdk-flora --update-env`
   - `pm2 save`
5. Nginx для нового домена (HTTP → reverse proxy на `PORT`, затем certbot):

```nginx
server {
    server_name <flora-домен>;

    location / {
        proxy_pass http://127.0.0.1:3850;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE: не буферизовать, длинные таймауты для voice/turn
        proxy_buffering off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

   - Проверить: `nginx -t`, затем перезагрузить nginx.
   - Выпустить сертификат: `certbot --nginx -d <flora-домен>`.

## Проверка
- Открыть домен → в UI нет VPN-индикатора и кнопки 📎.
- В логах PM2: `MCP at startup: historical-recipes` (и только он).
- Спросить: «Найди рецепт борща в historical-recipes».

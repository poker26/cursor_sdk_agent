# Фаза 6: планшет HarmonyOS / Android как голосовой клиент

Статус: **backend + APK-клиент в репозитории** (`android-voice-client/`).

Цель: обойти лимит ~4,5 с навыка Алисы — планшет говорит **напрямую** с gateway `cursor_sdk_agent`, без [dialogs.yandex.ru](https://dialogs.yandex.ru).

## Платформа

| ОС | Сборка | Установка |
|----|--------|-----------|
| HarmonyOS 2/3/4 | Android Studio, модуль `android-voice-client/` | APK вручную (USB / «Файлы») |
| HarmonyOS NEXT | Не в scope | Нужен контейнер APK или HAP (DevEco) |

**Wake-фраза:** своя (по умолчанию «эй агент»), не «привет, Алиса».

## API gateway

### `POST /api/voice/turn`

Синхронный полный ход: STT (опционально) → агент → JSON.

**Тело (JSON):**

```json
{
  "message": "текст команды",
  "audioBase64": "…",
  "mimeType": "audio/ogg",
  "sessionId": "uuid",
  "workspaceId": "default",
  "responseMode": "voice"
}
```

Достаточно `message` **или** `audioBase64` (тогда STT на сервере).

**Ответ 200:**

```json
{
  "ok": true,
  "sessionId": "…",
  "workspaceId": "…",
  "userText": "…",
  "assistantText": "…",
  "durationMs": 12340,
  "status": "completed",
  "runId": "…"
}
```

**429:** занят session/workspace — озвучить «подождите».

Также: `POST /api/voice/synthesize`, `GET /api/voice/status`.

Basic auth: те же `CHAT_BASIC_USER` / `CHAT_BASIC_PASSWORD`, что веб-чат.

## nginx на VDS

В [`deploy/nginx-cursor.begemot26.ru.conf.example`](../../deploy/nginx-cursor.begemot26.ru.conf.example) уже задано:

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

Проверьте на проде, что для location gateway не стоит меньший таймаут. Для `voice/turn` достаточно 120–300 с, но 3600 с безопаснее.

## Сборка APK (Android Studio)

1. Open → `android-voice-client/`
2. **Vosk-модель:** скачайте [vosk-model-small-ru-0.22](https://alphacephei.com/vosk/models) (~45 MB), распакуйте в `app/src/main/assets/model-small-ru/` (папка с `am/`, `conf/`, `graph/` внутри).
3. Build → Build APK(s).
4. Установите на планшет HarmonyOS 2–4.

## Настройки на планшете (Huawei / HarmonyOS)

1. **Установка APK:** разрешить неизвестные источники для «Файлы».
2. В приложении: URL gateway (`https://cursor.begemot26.ru`), логин/пароль basic auth, workspace, wake-фраза.
3. **Батарея:** Настройки → Приложения → Cursor Voice → Запуск → вручную; Управление батареей → **Не оптимизировать**.
4. **Автозапуск** — включить для приложения.
5. Планшет на зарядке 24/7 — рекомендуемый режим.

## Поток

1. Foreground service слушает wake-фразу (Vosk) или кнопка «Слушать».
2. Запись команды → `POST /api/voice/turn` (аудио base64 или текст).
3. Локально «Думаю…» пока ждёт (до 180 с HTTP).
4. `POST /api/voice/synthesize` → воспроизведение ответа.

### Режим диалога (фон)

После первой wake-фразы и ответа агента приложение **остаётся в диалоге**: можно говорить следующую команду **без** повторного «эй агент». Запись заканчивается по паузе (~1,4 с тишины).

Если **60 секунд** нет речи — снова режим ожидания wake-фразы.

## Деплой backend

```bash
cd ~/cursor_sdk_agent
git pull
npm run build
pm2 restart cursor-sdk-agent
```

## Проверка без планшета

```bash
curl -s -u USER:PASS -H "Content-Type: application/json" \
  -d '{"message":"какое сегодня число","responseMode":"voice"}' \
  https://cursor.begemot26.ru/api/voice/turn
```

Ожидается JSON с `assistantText` и `durationMs`.

## Ограничения

- Wake word не идеален — есть кнопка «Слушать».
- VPN на планшете для MCP не нужен (MCP на VDS).
- Секреты Cursor/Yandex только в `.env` на сервере, не в APK.

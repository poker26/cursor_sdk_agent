# Cursor Voice Client (HarmonyOS / Android)

Голосовой клиент для `cursor_sdk_agent`: wake-фраза, запись команды, `POST /api/voice/turn`, озвучка ответа.

## Требования

- Android Studio (Ladybug или новее)
- Планшет **HarmonyOS 2–4** (или Android 8+) с установкой APK
- Gateway с включённым голосом (`YANDEX_API_KEY`, `YANDEX_FOLDER_ID`)

## Vosk-модель (для wake word)

1. Скачайте [vosk-model-small-ru-0.22](https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip)
2. Распакуйте содержимое в:

```
app/src/main/assets/model-small-ru/
  am/
  conf/
  graph/
  ...
```

Без модели работает **кнопка «Слушать»**; фоновый wake word не запустится.

## Сборка

1. File → Open → `android-voice-client/`
2. Build → Build APK(s)
3. Установите `app-debug.apk` на планшет

## Настройки приложения

- URL gateway (например `https://cursor.begemot26.ru`)
- Basic auth (если задан на сервере)
- `workspaceId`
- Wake-фраза (по умолчанию «эй агент»)

## Huawei / HarmonyOS

- Батарея → не оптимизировать
- Автозапуск → включить
- Держать планшет на зарядке для фонового режима

Подробнее: [docs/plans/phase6-android-voice-tablet.md](../docs/plans/phase6-android-voice-tablet.md)

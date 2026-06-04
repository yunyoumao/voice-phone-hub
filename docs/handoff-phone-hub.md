# Phone Hub Handoff

## Current Runtime

- Service directory: `~/phone-hub`
- HTTP port: `8787`
- Main process: `node server.js`, started by `./run.sh`
- Agent command: `./agent-codex.js`
- Voice default location: set via `VOICE_DEFAULT_LOCATION` (empty by default; user configures their own)
- Service log: `data/server.log`
- Run log: `data/run.log`
- Watchdog log: `data/watchdog.log`

## Commands

```sh
cd ~/phone-hub
./run.sh status
./run.sh restart
./run.sh cleanup-agents
./watchdog.sh status
./watchdog.sh restart
```

`run.sh start|restart` requests `termux-wake-lock` when that command is available. It also clears stale `agent-codex`, `voice-agent`, and `phone-hub-codex-*` child processes before and after stopping the service.

`watchdog.sh` checks `http://127.0.0.1:8787/` every 60 seconds. HTTP `401` is healthy because the web UI requires auth. Any timeout, connection failure, or unexpected code restarts `phone-hub`.

## Bridge And Memory APIs

Both APIs reuse the voice token through `X-Voice-Token`.

### Bridge

`POST /api/bridge` appends one message to `data/bridge.jsonl`.

```json
{
  "from": "claude-pc",
  "to": "codex-phone",
  "text": "handoff text",
  "tags": ["handoff"]
}
```

Response:

```json
{ "ok": true, "id": 1, "ts": "2026-06-03T13:00:00.000Z" }
```

`GET /api/bridge?since=0&to=codex-phone&limit=100` returns messages addressed to that receiver plus broadcast messages.

### Memory Event

`POST /api/memory-event` appends one memory entry to `data/memory-events.jsonl`.

```json
{
  "source": "feishu",
  "type": "weather",
  "title": "今日天气",
  "text": "东京今天多云，气温 17 到 23 度。",
  "created_at": "2026-06-04T07:00:00+09:00",
  "meta": { "package": "com.ss.android.lark" }
}
```

Response:

```json
{ "ok": true, "id": 1 }
```

`GET /api/memory-event?since=0&type=meal&source=feishu&limit=50&q=咖喱` returns recent matching rows. `agent-codex.js` reads `memory-events.jsonl` for memory questions such as `我今天吃了什么`, `早上飞书推送了什么`, and `今天有什么更新`.

## Voice Agent Behavior

- Simple time/date queries are answered locally in `agent-codex.js` without a model call. The reply is TTS-friendly, for example `现在是晚上八点五十一分。`
- Weather queries are handled locally through Open-Meteo using the configured default location (`VOICE_DEFAULT_LOCATION`, empty unless set) when the user does not name a place. This includes follow-ups like `那明天呢` when recent context was about weather, avoiding Codex timeout on common weather requests.
- Alarm/timer requests return a structured top-level `action` with `reply`.
- Other requests go through Codex CLI with:
  - `--ignore-user-config`
  - `--ignore-rules`
  - `--sandbox read-only`
  - `--ask-for-approval never`
- Agent timeout defaults to `25s`; `server.js` agent timeout defaults to `60s`.
- Both `server.js` and `agent-codex.js` kill the whole child process group on timeout so stuck Codex/git descendants do not remain.

## Action Response Contract

`POST /api/voice-command` and `GET /api/voice-command/{task_id}` may return a top-level `action`.

Alarm example:

```json
{
  "status": "done",
  "reply": "好，已设明天早上七点整的起床。",
  "action": { "type": "set_alarm", "hour": 7, "minute": 0, "label": "起床" }
}
```

Timer example:

```json
{
  "status": "done",
  "reply": "好，已开始十分钟煮蛋。",
  "action": { "type": "set_timer", "seconds": 600, "label": "煮蛋" }
}
```

The Android app should execute `action` with native Android APIs and use `reply` for TTS. Phone Hub only parses and returns the intent; it does not call Android alarm APIs itself.

## Context Contract

The Android app can include short conversation memory in the POST body:

```json
{
  "text": "那明天呢",
  "context": [
    { "role": "user", "text": "今天天气" },
    { "role": "assistant", "text": "东京多云，气温约十九度。" }
  ]
}
```

Phone Hub keeps the last 6 valid context entries and passes them into Codex prompts. Local deterministic tools such as time, weather, alarm, and timer do not need model context.

## Processing Feedback Contract

`POST /api/voice-command` supports short acknowledgement waits through `ack_timeout_ms`.

Recommended Android behavior:

1. Start visible/haptic `处理中...` feedback immediately after sending the request.
2. Send `ack_timeout_ms` around `1500-3000` for voice UX.
3. If HTTP is `200`, speak `reply` immediately.
4. If HTTP is `202`, keep showing `处理中...` and poll `GET /api/voice-command/{task_id}` every `800-1200ms`.
5. If still running after `8-10s`, change copy to `还在处理，稍等一下`.
6. If the final reply is `处理超时，请稍后再试。`, stop the loading UI and allow a new wake phrase.

This is better than simply increasing the HTTP wait timeout because the user gets immediate feedback and the app can keep the assistant state clear.

## Conversation Mode

Continuous conversation is possible, but Android app state should own it:

- After a reply finishes speaking, keep a short follow-up window open, for example `4-6s`.
- During that window, accept follow-up speech without requiring the wake word again.
- Send recent context with the request when useful, for example the previous user text and assistant reply.
- Filter assistant acknowledgement phrases such as `在的`, `我在`, `好的` so they are not sent back to `phone-hub` as user questions.
- Exit conversation mode after timeout, explicit cancel words, or a destructive action that needs confirmation.

For low latency, route normal chat/follow-up through GLM `glm-4.5-flash` with thinking disabled. Reserve Codex for complex execution, file/system work, or tasks that need stronger agent behavior.

## Known Android Split

Termux-side `termux-tts-speak` and `termux-battery-status` hung in `termux-api`, and `com.termux.api` was not visible in `pm list packages`. Do not rely on Termux:API for the assistant voice loop.

Android app side should own:

- Native `TextToSpeech`
- Wake word acknowledgement such as `在的`
- Second listening window after wake word
- Location cache and optional city/lat/lon fields sent to `phone-hub`
- Real-time model routing for GLM/local models

Termux `phone-hub` should own:

- Local LAN HTTP API
- Safe command queue
- Codex fallback for complex tasks
- Deterministic fast tools such as time/date and future weather API integration

## Suggested Computer-Side Next Steps

1. Continue in `voice-ime-android`, not `phone-hub`, for wake word and TTS.
2. Implement native Android `TextToSpeech` and log `init`, `speak`, `done`, and `error`.
3. Add a 3-8 second second-listen window after detecting `小助手`.
4. Include cached location in `/api/voice-command` payload when available.
5. Route normal chat to `glm-4.5-flash` with thinking disabled for lower latency; reserve Codex for complex execution.
6. Implement processing UI using `ack_timeout_ms` + task polling instead of waiting silently for a long HTTP response.
7. Implement conversation mode as app state: reply spoken -> follow-up listening window -> include short context -> timeout exit.

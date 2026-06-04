# Voice Command Contract

手机中枢提供语音指令入口，供安卓语音输入法在检测到唤醒词后提交指令。

## 鉴权

复用 `/api/voice-log` 的 token。

```text
Header: X-Voice-Token: <token>
```

token 文件：

```text
~/phone-hub/.voice-token
```

## 提交指令

```text
POST /api/voice-command
Content-Type: application/json
X-Voice-Token: <token>
```

请求体：

```json
{
  "text": "查一下今天东京天气",
  "request_id": "optional-idempotency-key",
  "source": "voice-ime",
  "allow_destructive": false,
  "ack_timeout_ms": 8000,
  "callback_url": ""
}
```

字段：

- `text`：必填，已经去掉唤醒词后的指令文本。
- `request_id`：可选，60 秒窗口内幂等去重。
- `source`：可选，来源标记。
- `allow_destructive`：可选，默认 `false`。为 `false` 时删除、发送、付款、转账、清空、卸载等不可逆操作会被拒绝或要求确认。
- `ack_timeout_ms`：可选，默认 `8000`，最大 `30000`。服务会等待任务完成；超时仍未完成则返回 `202 running`。
- `callback_url`：可选，任务完成后尝试 POST 结果，失败不影响轮询。

快速完成：

```json
{
  "ok": true,
  "task_id": "uuid",
  "status": "done",
  "reply": "执行结果",
  "error": "",
  "actions": []
}
```

仍在运行：

```json
{
  "ok": true,
  "task_id": "uuid",
  "status": "running",
  "reply": "",
  "error": "",
  "actions": []
}
```

失败：

```json
{
  "ok": false,
  "task_id": "uuid",
  "status": "error",
  "reply": "",
  "error": "错误信息",
  "actions": []
}
```

## 查询任务

```text
GET /api/voice-command/{task_id}
X-Voice-Token: <token>
```

返回同提交接口。

## 执行模型

- 任务串行排队执行。
- `request_id` 60 秒内幂等，不重复执行。
- 默认内置安全处理器不会执行真实系统命令，只接收任务并拒绝明显高风险指令。
- 如需接入真正 agent，设置环境变量：

```sh
VOICE_AGENT_CMD=/path/to/agent \
VOICE_AGENT_ARGS='["--some-arg"]' \
VOICE_AGENT_TIMEOUT_MS=60000 \
node server.js
```

中枢会把任务 JSON 写入 agent 子进程 stdin，并把 stdout 作为 `reply`。不要把 `VOICE_AGENT_CMD` 指向任意 shell 包装脚本，除非脚本内部已经做白名单和确认流程。

## 示例

```sh
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Voice-Token: 这里换成.voice-token里的值" \
  --data '{"text":"查一下今天东京天气","request_id":"demo-1","source":"voice-ime"}' \
  http://127.0.0.1:8787/api/voice-command
```

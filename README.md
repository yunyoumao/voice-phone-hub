# 手机中枢

这是这台手机上的本地网页应用入口。第一版只做只读状态查看，后续再逐步加入文件管理、Android 自动化、语音助手和远程入口。

## 环境准备

```sh
# 1. 安装 Node.js（Termux: pkg install nodejs；桌面: brew/apt install nodejs）
node -v

# 2. 复制配置模板（.env 含 key，不入库）
cp .env.example .env
# 在 .env 里填 ZHIPU_API_KEY（智谱 key，用于 GLM 快聊；留空则跳过 GLM、仅走本地工具/Codex）

# 3.（可选）安装 Codex CLI，作为复杂任务的 agent fallback；未装时本地工具与 GLM 仍可正常工作
```

## 启动

```sh
cd ~/phone-hub
node server.js
```

默认监听 `0.0.0.0:8787`。手机本机可以打开 `http://127.0.0.1:8787`，同一局域网电脑可以打开手机的局域网地址加端口。

查看手机的局域网地址（Termux 里 `ifconfig` 或 `ip addr`），形如：

```text
http://192.168.x.x:8787
```

登录账号默认是 `admin`。密码在：

```text
~/phone-hub/.hub-password
```

## 安全原则

- 默认只读，不做删除、移动、远程执行。
- 文件整理先生成预览和日志，再确认执行。
- 局域网访问先加登录保护，再考虑长期运行。
- 不安装来源不明的软件包。
- Android 能力依赖 Termux:API 应用和系统权限。

## 语音助手方向

优先做三层入口：

1. 网页按钮：最容易调试，先把命令理解、执行日志和确认流程跑通。
2. 通知栏快捷按钮/桌面快捷方式：适合常用命令，比如查天气、记录想法、发电脑命令。
3. 唤醒式助手：Android 对后台录音和唤醒限制很严，需要明确可用的输入来源后再做。

已有语音输入法如果能把识别结果输出到输入框、剪贴板、通知、文件或本地接口，就可以接入手机中枢。不能直接读取另一个应用持续录音的原始音频，也不应该绕过 Android 沙箱和权限模型。

### 语音日志同步

手机中枢已经提供语音日志接收接口：

```text
POST http://192.168.x.x:8787/api/voice-log
```

同步 token 在：

```text
~/phone-hub/.voice-token
```

纯文本推送示例：

```sh
curl -X POST \
  -H "X-Voice-Token: 这里换成.voice-token里的值" \
  --data "这是一条语音日志" \
  http://192.168.x.x:8787/api/voice-log
```

JSON 推送示例：

```sh
curl -X POST \
  -H "Content-Type: application/json" \
  -H "X-Voice-Token: 这里换成.voice-token里的值" \
  --data '{"source":"语音输入法","text":"这是一条语音日志"}' \
  http://192.168.x.x:8787/api/voice-log
```

日志保存在：

```text
~/phone-hub/data/voice-log.jsonl
```

## 电脑控制方向

默认只做局域网内控制，不暴露公网。推荐路径是电脑上运行一个受限代理，手机中枢通过局域网发命令；每类高风险动作都要白名单和日志。

## 语音指令

唤醒词检测由安卓语音输入法负责；手机中枢负责接收已经去掉唤醒词的指令。

接口：

```text
POST /api/voice-command
GET /api/voice-command/{task_id}
```

鉴权复用 `/api/voice-log` 的 `X-Voice-Token`。完整契约见：

```text
docs/voice-command-contract.md
```

当前实现包含串行队列、`request_id` 60 秒幂等、`ack_timeout_ms` 快速返回、轮询、可选 `callback_url` 和高风险指令拒绝。真正 agent 子进程通过 `VOICE_AGENT_CMD` 配置；未配置时使用内置安全处理器，只确认收到指令，不执行系统命令。

### 智谱 GLM 快速聊天

phone-hub 支持在 Codex fallback 前先走智谱 GLM 处理普通闲聊/轻问答，用于降低语音助手等待时间。工具类任务仍优先走本地规则或 Codex：

- 本地规则：灯、闹钟、计时、健康记录、飞书草稿等。
- 专用/复杂任务：天气、时间、系统/代码/文件/Git、部署调试等继续走原路径。
- GLM：只处理不需要执行动作的普通聊天。

配置文件不进 git：

```sh
cd ~/phone-hub
cp .env.example .env
```

然后在 `.env` 里填：

```text
ZHIPU_API_KEY=你的智谱key
VOICE_GLM_MODEL=glm-4.5-flash
```

重启服务：

```sh
./run.sh restart
```

没有 `ZHIPU_API_KEY` 或设置 `VOICE_GLM_ENABLED=0` 时，GLM 路由会自动跳过，继续走原来的 Codex agent。

## 许可

本项目以 [MIT 许可证](LICENSE) 开源 © 2026 LI PEIZE。

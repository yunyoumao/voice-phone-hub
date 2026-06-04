const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, ".env"));

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(ROOT, "public");
const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const AUTH_USER = process.env.HUB_USER || "admin";
const PASSWORD_FILE = path.join(ROOT, ".hub-password");
const DATA_DIR = path.join(ROOT, "data");
const VOICE_TOKEN_FILE = path.join(ROOT, ".voice-token");
const VOICE_LOG_FILE = path.join(DATA_DIR, "voice-log.jsonl");
const VOICE_COMMAND_LOG_FILE = path.join(DATA_DIR, "voice-command.jsonl");
const BRIDGE_FILE = path.join(DATA_DIR, "bridge.jsonl");
const MEMORY_EVENT_FILE = path.join(DATA_DIR, "memory-events.jsonl");
const VOICE_AGENT_CMD = process.env.VOICE_AGENT_CMD || "";
const VOICE_AGENT_ARGS = process.env.VOICE_AGENT_ARGS
  ? JSON.parse(process.env.VOICE_AGENT_ARGS)
  : [];
const VOICE_AGENT_TIMEOUT_MS = Number(process.env.VOICE_AGENT_TIMEOUT_MS || 60000);
const VOICE_HTTP_TOTAL_TIMEOUT_MS = Number(process.env.VOICE_HTTP_TOTAL_TIMEOUT_MS || 10000);
const VOICE_GLM_ENABLED = !/^(0|false|no)$/i.test(String(process.env.VOICE_GLM_ENABLED || "1"));
const VOICE_GLM_API_KEY = String(process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || "").trim();
const VOICE_GLM_MODEL = String(process.env.VOICE_GLM_MODEL || "glm-4.5-flash").trim();
const VOICE_GLM_BASE_URL = String(process.env.VOICE_GLM_BASE_URL || "https://open.bigmodel.cn/api/anthropic").trim();
const VOICE_GLM_TIMEOUT_MS = Number(process.env.VOICE_GLM_TIMEOUT_MS || 8000);
const VOICE_GLM_NATIVE_STREAM = /^(1|true|yes)$/i.test(String(process.env.VOICE_GLM_NATIVE_STREAM || "0"));
const VOICE_DEFAULT_LOCATION = process.env.VOICE_DEFAULT_LOCATION || "";
const DEFAULT_WEATHER = VOICE_DEFAULT_LOCATION
  ? {
      name: VOICE_DEFAULT_LOCATION,
      latitude: Number(process.env.VOICE_DEFAULT_LAT || 0),
      longitude: Number(process.env.VOICE_DEFAULT_LON || 0),
    }
  : null;
const REQUEST_DEDUPE_MS = 60000;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function ensurePassword() {
  if (process.env.HUB_PASSWORD) return process.env.HUB_PASSWORD;
  if (fs.existsSync(PASSWORD_FILE)) {
    return fs.readFileSync(PASSWORD_FILE, "utf8").trim();
  }
  const password = crypto.randomBytes(12).toString("base64url");
  fs.writeFileSync(PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  return password;
}

const AUTH_PASSWORD = ensurePassword();

function ensureToken(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8").trim();
  }
  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(filePath, `${token}\n`, { mode: 0o600 });
  return token;
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const VOICE_TOKEN = ensureToken(VOICE_TOKEN_FILE);

function run(command, args = [], timeout = 5000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: error ? error.message : "",
      });
    });
  });
}

function runWithInput(command, args, input, timeout = 60000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    function stopChildGroup() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 2000).unref();
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopChildGroup();
      resolve({ ok: false, stdout, stderr, error: "agent timeout" });
    }, timeout);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), error: code === 0 ? "" : `exit ${code}` });
    });
    child.stdin.end(input);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const splitAt = decoded.indexOf(":");
    if (splitAt === -1) return false;
    const user = decoded.slice(0, splitAt);
    const password = decoded.slice(splitAt + 1);
    return (
      timingSafeEqualString(user, AUTH_USER) &&
      timingSafeEqualString(password, AUTH_PASSWORD)
    );
  } catch {
    return false;
  }
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Phone Hub"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end("需要登录");
  return false;
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("请求内容太大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function isVoiceTokenAuthorized(req, url) {
  const token = req.headers["x-voice-token"] || url.searchParams.get("token") || "";
  return timingSafeEqualString(String(token), VOICE_TOKEN);
}

function parseVoicePayload(raw, req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    const data = JSON.parse(raw || "{}");
    return {
      text: String(data.text || data.content || "").trim(),
      source: String(data.source || "http-json").trim(),
      raw: data,
    };
  }

  return {
    text: String(raw || "").trim(),
    source: "http-text",
    raw: null,
  };
}

function appendVoiceLog(entry) {
  fs.appendFileSync(VOICE_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function appendVoiceCommandLog(entry) {
  fs.appendFileSync(VOICE_COMMAND_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function appendJsonLine(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readJsonLines(filePath, limit = 200) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function nextJsonLineId(filePath) {
  const rows = readJsonLines(filePath, 1);
  return rows.length && Number.isFinite(Number(rows[0].id)) ? Number(rows[0].id) + 1 : 1;
}

function recentVoiceLogs(limit = 50) {
  if (!fs.existsSync(VOICE_LOG_FILE)) return [];
  const lines = fs.readFileSync(VOICE_LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { time: "", source: "parse-error", text: line };
    }
  });
}

function parseTags(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20);
}

function createBridgeMessage(raw, req) {
  const data = JSON.parse(raw || "{}");
  const message = {
    id: nextJsonLineId(BRIDGE_FILE),
    ts: new Date().toISOString(),
    from: String(data.from || "").trim() || "unknown",
    to: data.to ? String(data.to).trim() : "",
    text: String(data.text || "").trim(),
    tags: parseTags(data.tags),
    remoteAddress: req.socket.remoteAddress,
  };
  if (!message.text) throw new Error("text 不能为空");
  appendJsonLine(BRIDGE_FILE, message);
  return message;
}

function bridgeMessages(url) {
  const since = Number(url.searchParams.get("since") || 0);
  const to = String(url.searchParams.get("to") || "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 100), 1), 500);
  const messages = readJsonLines(BRIDGE_FILE, 2000)
    .filter((message) => Number(message.id) > since)
    .filter((message) => !to || !message.to || message.to === to)
    .slice(-limit);
  return { messages };
}

function createMemoryEvent(raw, req) {
  const data = JSON.parse(raw || "{}");
  const event = {
    id: nextJsonLineId(MEMORY_EVENT_FILE),
    ts: new Date().toISOString(),
    source: String(data.source || "").trim() || "unknown",
    type: String(data.type || "").trim() || "note",
    title: String(data.title || "").trim(),
    text: String(data.text || "").trim(),
    created_at: data.created_at ? String(data.created_at).trim() : new Date().toISOString(),
    meta: data.meta && typeof data.meta === "object" && !Array.isArray(data.meta) ? data.meta : {},
    remoteAddress: req.socket.remoteAddress,
  };
  if (!event.text && !event.title) throw new Error("text 或 title 不能为空");
  appendJsonLine(MEMORY_EVENT_FILE, event);
  return event;
}

function memoryEvents(url) {
  const since = Number(url.searchParams.get("since") || 0);
  const type = String(url.searchParams.get("type") || "").trim();
  const source = String(url.searchParams.get("source") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 300);
  const rows = readJsonLines(MEMORY_EVENT_FILE, 2000)
    .filter((event) => Number(event.id) > since)
    .filter((event) => !type || event.type === type)
    .filter((event) => !source || event.source === source)
    .filter((event) => {
      if (!q) return true;
      return `${event.title || ""} ${event.text || ""} ${event.type || ""} ${event.source || ""}`.toLowerCase().includes(q);
    })
    .slice(-limit)
    .reverse();
  return { rows };
}

function sanitizeReply(reply, maxChars = 260) {
  let text = String(reply || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!text) return "";

  const paragraphs = text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const seenParagraphs = new Set();
  text = paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/[，。！？、,.!?;；:\s]/g, "");
    if (!key) return false;
    if (seenParagraphs.has(key)) return false;
    seenParagraphs.add(key);
    return true;
  }).slice(0, 3).join("\n");

  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  const seenSentences = new Set();
  text = sentences.filter((sentence) => {
    const normalized = sentence.trim().replace(/[，。！？、,.!?;；:\s]/g, "");
    if (!normalized) return false;
    if (seenSentences.has(normalized)) return false;
    seenSentences.add(normalized);
    return true;
  }).join("").trim();

  const voiceSentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  text = voiceSentences.slice(0, 3).join("").trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars).replace(/[，,、；;：:\s]+$/g, "")}。`;
  return text;
}

function isToolLikeVoiceCommand(text) {
  return /天气|气温|温度|下雨|降雨|带伞|几点|现在.*时间|当前.*时间|今天.*几号|日期|闹钟|叫我|提醒我|计时|倒计时|定时|分钟后|小时后|体重|腰围|体脂|血糖|尿酸|喝水|步数|运动|早餐|午饭|晚饭|心情|飞书|发送|发给|通知|同步|卧室灯|开灯|关灯|灯|删除|清空|付款|支付|转账|卸载|关机|重启|格式化/i.test(text);
}

function isComplexVoiceCommand(text) {
  return /代码|报错|日志|文件|目录|git|github|commit|push|pull|安装|配置|服务|进程|端口|数据库|接口|脚本|修改|实现|调试|部署|测试|运行|终端|命令|system|server|android|mac|windows|repo|仓库/i.test(text);
}

function shouldUseGlmChat(task) {
  if (task.skip_glm) return false;
  if (!VOICE_GLM_ENABLED || !VOICE_GLM_API_KEY) return false;
  const text = String(task.text || "").trim();
  if (!text || text.length > 180) return false;
  if (isToolLikeVoiceCommand(text) || isComplexVoiceCommand(text)) return false;
  return true;
}

function contextText(context) {
  if (!Array.isArray(context) || !context.length) return "";
  return context
    .slice(-6)
    .map((item) => {
      const role = item && item.role === "assistant" ? "助手" : "用户";
      const text = String(item && item.text || "").trim();
      return text ? `${role}：${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function requestGlm(body, timeoutMs = VOICE_GLM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${VOICE_GLM_BASE_URL.replace(/\/+$/g, "")}/v1/messages`);
    const req = https.request(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-api-key": VOICE_GLM_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GLM HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(responseBody));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("GLM timeout"));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function writeSse(res, event) {
  res.write(`data:${JSON.stringify(event)}\n\n`);
}

function parseAnthropicSseLine(line) {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function requestGlmStream(body, onDelta, timeoutMs = VOICE_GLM_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${VOICE_GLM_BASE_URL.replace(/\/+$/g, "")}/v1/messages`);
    const req = https.request(
      url,
      {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-api-key": VOICE_GLM_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      },
      (res) => {
        let buffer = "";
        let errorBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            errorBody += chunk;
            return;
          }
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const event = parseAnthropicSseLine(line.trim());
            if (!event) continue;
            const delta = event.delta && typeof event.delta.text === "string" ? event.delta.text : "";
            if (delta) onDelta(delta);
          }
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GLM HTTP ${res.statusCode}: ${errorBody.slice(0, 120)}`));
            return;
          }
          resolve();
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("GLM timeout"));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ ...body, stream: true }));
  });
}

function glmChatBody(task) {
  const ctx = contextText(task.context);
  const system = [
    "你是手机上的实时语音助手。",
    "只输出给用户听的简短中文回复，不要输出推理过程、日志、Markdown 或列表。",
    "不要声称已经执行发送、付款、删除、系统修改、设备控制等动作；遇到这类需求只说需要走专用确认流程。",
    "回答要自然，适合 TTS 朗读，通常一到三句话。",
  ].join("\n");
  const user = [
    ctx ? `最近对话：\n${ctx}` : "",
    `用户：${task.text}`,
  ].filter(Boolean).join("\n\n");
  return {
    model: VOICE_GLM_MODEL,
    max_tokens: 384,
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: user }],
  };
}

function replyChunks(reply) {
  const text = String(reply || "").trim();
  if (!text) return [];
  const chunks = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  return chunks.map((item) => item.trim()).filter(Boolean);
}

async function runGlmChat(task) {
  const data = await requestGlm(glmChatBody(task));
  const content = Array.isArray(data.content) ? data.content : [];
  const reply = sanitizeReply(content
    .filter((item) => item && item.type === "text")
    .map((item) => item.text || "")
    .join("")
  );
  if (!reply) throw new Error("GLM empty reply");
  return {
    reply,
    action: null,
    actions: [{ type: "glm_chat", model: VOICE_GLM_MODEL }],
  };
}

function requestJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

function isWeatherQuery(text, context = []) {
  if (/天气|气温|温度|下雨|降雨|带伞|冷不冷|热不热/.test(text)) return true;
  const recent = Array.isArray(context) ? context.map((item) => item.text || "").join(" ") : "";
  return /天气|气温|温度|下雨|降雨|带伞|冷不冷|热不热/.test(recent) && /那|明天|后天|今天|还会|怎么样|呢/.test(text);
}

function weatherLabel(code) {
  if (code === 0) return "晴";
  if ([1, 2].includes(code)) return "多云";
  if (code === 3) return "阴";
  if ([45, 48].includes(code)) return "有雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "小雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "有雨";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "有雪";
  if ([95, 96, 99].includes(code)) return "有雷雨";
  return "天气不明";
}

function extractWeatherPlace(text) {
  const cleaned = String(text || "")
    .replace(/[。！？?！]/g, "")
    .replace(/今天|明天|明日|后天|现在|目前|一下|怎么样|如何|是什么|那|呢|还会/g, "")
    .replace(/天气|气温|温度|下雨|降雨|带伞|冷不冷|热不热/g, "")
    .trim();
  if (!cleaned || /^在的/.test(cleaned)) return "";
  return cleaned.replace(/^在的\s*/, "").trim();
}

async function resolveWeatherLocation(text) {
  const place = extractWeatherPlace(text);
  if (!place) return DEFAULT_WEATHER;
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=${encodeURIComponent(place)}`;
  const data = await requestJson(url, 5000);
  const item = data && data.results && data.results[0];
  if (!item) return DEFAULT_WEATHER;
  return {
    name: item.name || place,
    latitude: item.latitude,
    longitude: item.longitude,
  };
}

function weatherDayOffset(text) {
  if (/后天/.test(text)) return 2;
  if (/明天|明日/.test(text)) return 1;
  return 0;
}

async function runWeatherQuery(task) {
  const loc = await resolveWeatherLocation(task.text);
  if (!loc) {
    return {
      reply: sanitizeReply("还没有设置默认城市，请在问天气时说出城市名，或在 .env 配置 VOICE_DEFAULT_LOCATION。"),
      action: null,
      actions: [{ type: "weather_query", provider: "none", location: "", day_offset: 0 }],
    };
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=3`;
  const data = await requestJson(url, 8000);
  const offset = weatherDayOffset(task.text);
  let reply = "";
  if (offset > 0 && data.daily && data.daily.time && data.daily.time[offset]) {
    const max = Math.round(Number(data.daily.temperature_2m_max[offset]));
    const min = Math.round(Number(data.daily.temperature_2m_min[offset]));
    const rainProb = Math.round(Number(data.daily.precipitation_probability_max[offset] || 0));
    const label = weatherLabel(Number(data.daily.weather_code[offset]));
    const dayName = offset === 1 ? "明天" : "后天";
    const umbrella = rainProb >= 40 || /雨/.test(label) ? "建议带伞。" : "一般不用带伞。";
    reply = `${loc.name}${dayName}${label}，气温约${min}到${max}度，降雨概率约${rainProb}%。${umbrella}`;
  } else {
    const current = data.current || {};
    const temp = Math.round(Number(current.temperature_2m));
    const feels = Math.round(Number(current.apparent_temperature));
    const rain = Number(current.precipitation || 0);
    const wind = Math.round(Number(current.wind_speed_10m || 0));
    const label = weatherLabel(Number(current.weather_code));
    const umbrella = rain > 0 || /雨/.test(label) ? "建议带伞。" : "一般不用带伞。";
    reply = `${loc.name}现在${label}，气温约${temp}度，体感${feels}度，风速约每小时${wind}公里。${umbrella}`;
  }
  return {
    reply: sanitizeReply(reply),
    action: null,
    actions: [{
      type: "weather_query",
      provider: "open-meteo",
      location: loc.name,
      day_offset: offset,
    }],
  };
}

function zhNumber(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const map = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
    二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25, 二十六: 26, 二十七: 27,
    二十八: 28, 二十九: 29, 三十: 30,
  };
  return Object.prototype.hasOwnProperty.call(map, text) ? map[text] : null;
}

function parseNumeric(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return zhNumber(text);
}

function todayLocalDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function metricText(metrics) {
  const parts = [];
  if (Number.isFinite(metrics.weight_kg)) parts.push(`体重${metrics.weight_kg}公斤`);
  if (Number.isFinite(metrics.waist_cm)) parts.push(`腰围${metrics.waist_cm}厘米`);
  if (Number.isFinite(metrics.body_fat)) parts.push(`体脂${metrics.body_fat}%`);
  if (Number.isFinite(metrics.glucose)) parts.push(`血糖${metrics.glucose}`);
  if (Number.isFinite(metrics.uric_acid)) parts.push(`尿酸${metrics.uric_acid}`);
  if (Number.isFinite(metrics.water_ml)) parts.push(`喝水${metrics.water_ml}毫升`);
  if (Number.isFinite(metrics.steps)) parts.push(`步数${metrics.steps}步`);
  if (Number.isFinite(metrics.exercise_minutes)) parts.push(`运动${metrics.exercise_minutes}分钟`);
  if (metrics.exercise) parts.push(`运动：${metrics.exercise}`);
  if (metrics.meal) parts.push(`${metrics.meal_type || "饮食"}：${metrics.meal}`);
  if (metrics.mood) parts.push(`心情：${metrics.mood}`);
  return parts.join("，");
}

function primaryHealthMetric(metrics, summary) {
  const note = summary || metricText(metrics);
  if (Number.isFinite(metrics.weight_kg)) return { metric: "weight", value: metrics.weight_kg, unit: "kg", note };
  if (Number.isFinite(metrics.waist_cm)) return { metric: "waist", value: metrics.waist_cm, unit: "cm", note };
  if (Number.isFinite(metrics.body_fat)) return { metric: "body_fat", value: metrics.body_fat, unit: "%", note };
  if (Number.isFinite(metrics.glucose)) return { metric: "glucose", value: metrics.glucose, unit: "mmol/L", note };
  if (Number.isFinite(metrics.uric_acid)) return { metric: "uric_acid", value: metrics.uric_acid, unit: "umol/L", note };
  if (Number.isFinite(metrics.water_ml)) return { metric: "water", value: metrics.water_ml, unit: "ml", note };
  if (Number.isFinite(metrics.steps)) return { metric: "steps", value: metrics.steps, unit: "steps", note };
  if (Number.isFinite(metrics.exercise_minutes)) return { metric: "exercise", value: "运动", unit: "", note };
  if (metrics.exercise) return { metric: "exercise", value: metrics.exercise, unit: "", note };
  if (metrics.meal) return { metric: "meal", value: metrics.meal, unit: "", note };
  if (metrics.mood) return { metric: "mood", value: metrics.mood, unit: "", note };
  return null;
}

function parseDirectHealthMetric(text) {
  if (!/记录|记一下|记下|体重|称了|称重|公斤|kg|千克|腰围|厘米|cm|体脂|血糖|尿酸|喝水|饮水|喝了|毫升|ml|升|杯|步数|走了|走路|步|早餐|早饭|午餐|午饭|晚餐|晚饭|心情|运动|跑步|散步|快走|游泳|骑车|力量训练|瑜伽/.test(text)) return null;
  const metrics = {};

  const weight = text.match(/体重\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(?:公斤|kg|千克)?/i);
  if (weight) metrics.weight_kg = parseNumeric(weight[1]);
  if (!Number.isFinite(metrics.weight_kg)) {
    const weightByUnit = text.match(/(?:^|[^\d])([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(?:公斤|kg|千克)/i);
    if (weightByUnit) metrics.weight_kg = parseNumeric(weightByUnit[1]);
  }
  if (!Number.isFinite(metrics.weight_kg) && /称了|称重/.test(text)) {
    const weighed = text.match(/(?:称了下|称了一下|称了|称重)\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})/);
    if (weighed) metrics.weight_kg = parseNumeric(weighed[1]);
  }

  const waist = text.match(/腰围\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(?:厘米|cm)?/i);
  if (waist) metrics.waist_cm = parseNumeric(waist[1]);

  const bodyFat = text.match(/体脂\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*%?/i);
  if (bodyFat) metrics.body_fat = parseNumeric(bodyFat[1]);

  const glucose = text.match(/血糖\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})/);
  if (glucose) metrics.glucose = parseNumeric(glucose[1]);

  const uricAcid = text.match(/尿酸\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})/);
  if (uricAcid) metrics.uric_acid = parseNumeric(uricAcid[1]);

  const water = text.match(/(?:喝水|饮水)\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(毫升|ml|升|l|杯)?/i);
  if (water) {
    let value = parseNumeric(water[1]);
    const unit = String(water[2] || "").toLowerCase();
    if (Number.isFinite(value)) {
      if (unit === "升" || unit === "l") value *= 1000;
      if (unit === "杯") value *= 250;
      metrics.water_ml = value;
    }
  }
  if (!Number.isFinite(metrics.water_ml)) {
    const waterAfterVerb = text.match(/喝了?\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(毫升|ml|升|l|杯)\s*水?/i);
    if (waterAfterVerb) {
      let value = parseNumeric(waterAfterVerb[1]);
      const unit = String(waterAfterVerb[2] || "").toLowerCase();
      if (Number.isFinite(value)) {
        if (unit === "升" || unit === "l") value *= 1000;
        if (unit === "杯") value *= 250;
        metrics.water_ml = value;
      }
    }
  }

  const steps = text.match(/(?:步数|走了|走路)\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,5})\s*步?/);
  if (steps) metrics.steps = parseNumeric(steps[1]);

  const exerciseType = text.match(/(跑步|散步|快走|游泳|骑车|力量训练|瑜伽)/);
  if (exerciseType && !/[0-9零一二两三四五六七八九十]/.test(text)) metrics.exercise = exerciseType[1];

  const exercise = text.match(/(?:运动|跑步|散步|快走|游泳|骑车|力量训练|瑜伽)\s*([0-9]+(?:\.[0-9]+)?|[零一二两三四五六七八九十]{1,3})\s*(分钟|小时)?/);
  if (exercise) {
    let value = parseNumeric(exercise[1]);
    if (Number.isFinite(value)) {
      if (exercise[2] === "小时") value *= 60;
      metrics.exercise_minutes = value;
    }
  }

  const mealTypeMatch = text.match(/(早餐|早饭|午餐|午饭|晚餐|晚饭|夜宵)/);
  if (mealTypeMatch) {
    const mealType = mealTypeMatch[1].replace("早饭", "早餐").replace("午饭", "午餐").replace("晚饭", "晚餐");
    const meal = text
      .replace(/^(帮我|给我|请)?\s*(记录|记一下|记下)?/, "")
      .replace(mealTypeMatch[1], "")
      .replace(/吃了?/, "")
      .trim();
    metrics.meal_type = mealType;
    if (meal && meal !== text) metrics.meal = meal;
  }

  const mood = text.match(/心情\s*(?:是|很|:|：)?\s*([^，。！？,.!?]+)/);
  if (mood) metrics.mood = mood[1].trim();

  for (const key of ["weight_kg", "waist_cm", "body_fat", "glucose", "uric_acid", "water_ml", "steps", "exercise_minutes"]) {
    if (!Number.isFinite(metrics[key])) delete metrics[key];
  }
  if (!Object.keys(metrics).length) return null;

  const date = todayLocalDate();
  const summary = metricText(metrics);
  const primary = primaryHealthMetric(metrics, summary);
  if (!primary) return null;
  const shouldNotifyFeishu = /飞书/.test(text) && /发|发送|通知|同步/.test(text);
  const action = {
    type: "record_health_metric",
    metric: primary.metric,
    value: primary.value,
    unit: primary.unit,
    note: primary.note,
    recorded_at: new Date().toISOString(),
    date,
    metrics,
    source: "voice-assistant",
    memory_event: {
      source: "voice-assistant",
      type: "health_metric",
      title: "健康记录",
      text: summary,
      created_at: new Date().toISOString(),
      meta: { date, ...metrics },
    },
  };
  if (shouldNotifyFeishu) {
    action.notify_feishu = true;
    action.feishu_message = {
      type: "send_feishu_message",
      target: "self",
      text: `今日${summary}`,
      confirm_required: false,
      source: "voice-assistant",
    };
  }

  return {
    reply: shouldNotifyFeishu
      ? `好，已整理好今天的健康记录，并准备同步到飞书：${summary}。`
      : `好，已整理好今天的健康记录：${summary}。`,
    action,
  };
}

function parseDirectFeishuMessage(text, allowDestructive) {
  if (!/飞书/.test(text) || !/发|发送|通知|同步/.test(text)) return null;
  const targetMatch = text.match(/(?:给|发给|同步到)\s*([^，。！？,.!?]+?)\s*(?:发|发送|通知|同步|说)/);
  const target = targetMatch ? targetMatch[1].replace(/飞书/g, "").trim() : "self";
  let message = text
    .replace(/^(帮我|请|给我)?\s*/, "")
    .replace(/(在)?飞书(上)?/, "")
    .replace(/发给|发送给|给/, "")
    .replace(/发一条|发消息|发送|通知|同步/, "")
    .trim();
  if (!message || message === text) message = text;
  return {
    reply: allowDestructive ? "好，我会让 App 调用飞书发送接口。" : "这属于发送消息。我已准备好飞书消息草稿，请你确认后再发送。",
    action: {
      type: "send_feishu_message",
      target: target || "self",
      text: message,
      confirm_required: !allowDestructive,
      source: "voice-assistant",
    },
  };
}

function parseDirectSwitchBot(text) {
  if (!/卧室灯|卧室的灯|房间灯|开灯|关灯|灯/.test(text)) return null;
  let command = "";
  if (/打开|开\s*(个|一下|一?下)?\s*(卧室灯|灯)|开灯|开一下|开\s*卧室灯|把.*灯.*开/.test(text)) command = "turn_on";
  if (/关闭|关掉|关\s*(个|一下|一?下)?\s*(卧室灯|灯)|关灯|关一下|关\s*卧室灯|把.*灯.*关/.test(text)) command = "turn_off";
  if (!command) {
    return {
      reply: "你想打开还是关闭卧室灯？",
      action: {
        type: "switchbot_control",
        provider: "switchbot",
        device: "bedroom_light",
        device_name: "卧室灯",
        command: "clarify",
        confirm_required: false,
        source: "voice-assistant",
      },
    };
  }
  const verb = command === "turn_on" ? "打开" : "关闭";
  return {
    reply: `好，准备${verb}卧室灯。`,
    action: {
      type: "switchbot_control",
      provider: "switchbot",
      device: "bedroom_light",
      device_name: "卧室灯",
      command,
      confirm_required: false,
      source: "voice-assistant",
    },
  };
}

function lastAssistantText(context) {
  if (!Array.isArray(context)) return "";
  for (let i = context.length - 1; i >= 0; i--) {
    if (context[i] && context[i].role === "assistant" && context[i].text) return context[i].text;
  }
  return "";
}

function lastUserText(context) {
  if (!Array.isArray(context)) return "";
  for (let i = context.length - 1; i >= 0; i--) {
    if (context[i] && context[i].role === "user" && context[i].text) return context[i].text;
  }
  return "";
}

function isAffirmative(text) {
  return /^(是|是的|对|对的|嗯|好|好的|可以|确认|没错|执行吧|就这样)$/.test(String(text || "").trim());
}

function latestHealthMetric(metricKey, label, unit = "") {
  const rows = readJsonLines(MEMORY_EVENT_FILE, 500)
    .filter((event) => event.type === "health_metric" && event.meta && Number.isFinite(Number(event.meta[metricKey])))
    .reverse();
  if (!rows.length) return `我还没有查到最近的${label}记录。`;
  const row = rows[0];
  return `最近记录的${label}是${row.meta[metricKey]}${unit}。`;
}

function parseFollowupVoiceCommand(task) {
  const text = task.text.trim();
  const lastAssistant = lastAssistantText(task.context);
  if (!lastAssistant) return null;

  if (/打开还是关闭卧室灯/.test(lastAssistant)) {
    if (/^(开|打开|开灯|打开灯)$/.test(text)) return parseDirectSwitchBot("开灯");
    if (/^(关|关闭|关灯|关闭灯|关掉)$/.test(text)) return parseDirectSwitchBot("关灯");
    if (isAffirmative(text)) {
      return {
        reply: "请直接说开灯还是关灯。",
        action: { type: "clarify", topic: "switchbot_control", expected: ["turn_on", "turn_off"] },
      };
    }
  }

  if (/记录体重|查询最近体重|体重多少/.test(lastAssistant)) {
    if (/查询|最近|看看|多少/.test(text)) return { reply: latestHealthMetric("weight_kg", "体重", "公斤") };
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return parseDirectHealthMetric(`体重${text}`);
    if (isAffirmative(text)) return { reply: "请说体重数字，比如体重八十。", action: { type: "clarify", topic: "record_health_metric", metric: "weight" } };
  }

  if (/记录腰围|查询最近腰围|腰围多少/.test(lastAssistant)) {
    if (/查询|最近|看看|多少/.test(text)) return { reply: latestHealthMetric("waist_cm", "腰围", "厘米") };
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return parseDirectHealthMetric(`腰围${text}`);
    if (isAffirmative(text)) return { reply: "请说腰围数字，比如腰围七十八。", action: { type: "clarify", topic: "record_health_metric", metric: "waist" } };
  }

  if (/飞书内容|发什么飞书/.test(lastAssistant)) {
    if (isAffirmative(text)) return { reply: "请直接说要发到飞书的内容。", action: { type: "clarify", topic: "send_feishu_message" } };
    return {
      reply: "这属于发送消息。我已准备好飞书消息草稿，请你确认后再发送。",
      action: {
        type: "send_feishu_message",
        target: "self",
        text,
        confirm_required: true,
        source: "voice-assistant",
      },
    };
  }

  if (/飞书消息草稿|确认后再发送/.test(lastAssistant) && isAffirmative(text)) {
    const previousText = lastUserText(task.context);
    if (!previousText) return { reply: "我找不到上一条飞书草稿内容，请重新说要发送的内容。", action: { type: "clarify", topic: "send_feishu_message" } };
    return {
      reply: "好，我会让 App 发送这条飞书消息。",
      action: {
        type: "send_feishu_message",
        target: "self",
        text: previousText,
        confirm_required: false,
        source: "voice-assistant",
      },
    };
  }

  return null;
}

function parseVagueVoiceCommand(text) {
  const normalized = String(text || "").trim();
  if (/^(体重|我的体重)$/.test(normalized)) {
    return {
      reply: "你要记录体重，还是查询最近体重？如果记录，请说体重多少。",
      action: { type: "clarify", topic: "record_health_metric", metric: "weight" },
    };
  }
  if (/^(腰围|我的腰围)$/.test(normalized)) {
    return {
      reply: "你要记录腰围，还是查询最近腰围？如果记录，请说腰围多少。",
      action: { type: "clarify", topic: "record_health_metric", metric: "waist" },
    };
  }
  if (/^(飞书|发飞书|飞书消息)$/.test(normalized)) {
    return {
      reply: "你想发什么飞书内容？",
      action: { type: "clarify", topic: "send_feishu_message" },
    };
  }
  if (/^(闹钟|提醒|提醒我)$/.test(normalized)) {
    return {
      reply: "你想几点提醒？比如明早七点叫我。",
      action: { type: "clarify", topic: "set_alarm" },
    };
  }
  if (/^(计时|倒计时)$/.test(normalized)) {
    return {
      reply: "你想计时多久？比如计时十分钟。",
      action: { type: "clarify", topic: "set_timer" },
    };
  }
  return null;
}

function spokenHourMinute(hour, minute, prefix = "") {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  function n(value) {
    if (value < 10) return digits[value];
    if (value === 10) return "十";
    if (value < 20) return `十${digits[value - 10]}`;
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${digits[tens]}十${ones ? digits[ones] : ""}`;
  }
  let hour12 = hour % 12;
  if (hour12 === 0) hour12 = 12;
  const minuteText = minute === 0 ? "整" : `${minute < 10 ? "零" : ""}${n(minute)}分`;
  return `${prefix}${n(hour12)}点${minuteText}`;
}

function parseDirectAlarm(text) {
  if (!/闹钟|叫我|提醒我/.test(text)) return null;
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上|明早|明天早上|明天上午|明晚|明天晚上)?\s*([0-9零一二两三四五六七八九十]{1,3})\s*[点:：]\s*([0-9零一二两三四五六七八九十]{1,3})?\s*分?/);
  if (!match) return null;
  let hour = zhNumber(match[2]);
  const minute = zhNumber(match[3] || "0");
  if (hour == null || minute == null || hour > 23 || minute > 59) return null;
  const period = match[1] || "";
  if (/下午|晚上|明晚|明天晚上/.test(period) && hour < 12) hour += 12;
  if (/凌晨/.test(period) && hour === 12) hour = 0;
  if (/中午/.test(period) && hour < 11) hour += 12;
  if (hour > 23) return null;
  const label = /起床/.test(text) ? "起床" : "闹钟";
  const spokenLabel = label === "起床" ? "起床闹钟" : "闹钟";
  const prefix = period.includes("明") ? "明天" : "";
  return {
    reply: `好，已设${spokenHourMinute(hour, minute, prefix)}的${spokenLabel}。`,
    action: { type: "set_alarm", hour, minute, label },
  };
}

function parseDirectTimer(text) {
  if (!/计时|倒计时|定时|分钟后|小时后/.test(text)) return null;
  let seconds = 0;
  const hourMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*个?\s*小时/);
  const minuteMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*分钟/);
  const secondMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*秒/);
  if (hourMatch) seconds += (zhNumber(hourMatch[1]) || 0) * 3600;
  if (minuteMatch) seconds += (zhNumber(minuteMatch[1]) || 0) * 60;
  if (secondMatch) seconds += zhNumber(secondMatch[1]) || 0;
  if (!seconds) return null;
  const label = /煮蛋/.test(text) ? "煮蛋" : "计时";
  const minutes = Math.round(seconds / 60);
  const spoken = seconds % 60 === 0 && minutes > 0 ? `${minutes}分钟` : `${seconds}秒`;
  return {
    reply: `好，已开始${spoken}${label}。`,
    action: { type: "set_timer", seconds, label },
  };
}

const voiceTasks = new Map();
const requestIds = new Map();
const voiceQueue = [];
let voiceQueueRunning = false;

function taskResponse(task) {
  const response = {
    ok: task.status !== "error",
    task_id: task.task_id,
    status: task.status,
    reply: task.reply || "",
    error: task.error || "",
    actions: task.actions || [],
  };
  if (task.action) response.action = task.action;
  return response;
}

function createUnqueuedVoiceTask(payload, req) {
  return {
    task_id: crypto.randomUUID(),
    request_id: payload.request_id,
    status: "running",
    text: payload.text,
    source: payload.source,
    allow_destructive: payload.allow_destructive,
    callback_url: payload.callback_url,
    context: payload.context,
    created_at: new Date().toISOString(),
    remoteAddress: req.socket.remoteAddress,
    reply: "",
    action: null,
    error: "",
    actions: [],
  };
}

function cleanupRequestIds() {
  const now = Date.now();
  for (const [requestId, item] of requestIds.entries()) {
    if (now - item.createdAt > REQUEST_DEDUPE_MS) {
      requestIds.delete(requestId);
    }
  }
}

function parseVoiceCommandPayload(raw) {
  const data = JSON.parse(raw || "{}");
  const textValue = String(data.text || "").trim();
  const context = Array.isArray(data.context)
    ? data.context
        .slice(-6)
        .map((item) => ({
          role: String(item && item.role || "").trim(),
          text: String(item && item.text || "").trim(),
        }))
        .filter((item) => /^(user|assistant)$/.test(item.role) && item.text)
    : [];
  return {
    text: textValue,
    request_id: data.request_id ? String(data.request_id).trim() : "",
    source: data.source ? String(data.source).trim() : "voice-ime",
    allow_destructive: Boolean(data.allow_destructive),
    ack_timeout_ms: Math.min(Math.max(Number(data.ack_timeout_ms || 8000), 0), 30000),
    callback_url: data.callback_url ? String(data.callback_url).trim() : "",
    context,
    raw: data,
  };
}

function mayBeDestructive(text) {
  return /删除|清空|发送|付款|支付|转账|卸载|关机|重启|格式化|rm\s+-|kill|reset|checkout|commit|push/i.test(text);
}

async function runVoiceCommand(task) {
  const immediate = runImmediateVoiceCommand(task);
  if (immediate) return immediate;

  if (!task.allow_destructive && mayBeDestructive(task.text)) {
    return {
      reply: "这条指令可能包含删除、发送、付款或系统修改等不可逆操作。当前 allow_destructive=false，我不会执行。请在确认流程里重新发起。",
      actions: [{ type: "refuse_destructive", text: task.text }],
    };
  }

  if (isWeatherQuery(task.text, task.context)) {
    try {
      return await runWeatherQuery(task);
    } catch (error) {
      return {
        reply: `${VOICE_DEFAULT_LOCATION}天气暂时查不到，请稍后再试。`,
        action: null,
        actions: [{ type: "weather_query_failed", provider: "open-meteo", error: error.message }],
      };
    }
  }

  if (shouldUseGlmChat(task)) {
    try {
      return await runGlmChat(task);
    } catch (error) {
      task.actions = [{ type: "glm_chat_failed", error: error.message }];
    }
  }

  if (VOICE_AGENT_CMD) {
    const input = JSON.stringify({
      task_id: task.task_id,
      text: task.text,
      context: task.context || [],
      source: task.source,
      allow_destructive: task.allow_destructive,
      created_at: task.created_at,
    });
    const result = await runWithInput(VOICE_AGENT_CMD, VOICE_AGENT_ARGS, input, VOICE_AGENT_TIMEOUT_MS);
    if (!result.ok) {
      throw new Error(result.stderr || result.error || "agent failed");
    }
    let reply = result.stdout || "执行完成";
    let action = null;
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed && typeof parsed === "object") {
        reply = String(parsed.reply || reply).trim() || "执行完成";
        action = parsed.action && typeof parsed.action === "object" ? parsed.action : null;
      }
    } catch {}
    reply = sanitizeReply(reply);
    return {
      reply,
      action,
      actions: [...(task.actions || []), { type: "agent_process", command: VOICE_AGENT_CMD }],
    };
  }

  return {
    reply: `我已收到指令：「${task.text}」。当前 phone-hub 语音命令队列已接通，但还没有配置真正的 agent 子进程。`,
    actions: [...(task.actions || []), { type: "queued_without_agent" }],
  };
}

function runImmediateVoiceCommand(task) {
  const followupAction = parseFollowupVoiceCommand(task);
  if (followupAction) {
    return {
      reply: followupAction.reply,
      action: followupAction.action || null,
      actions: [{ type: "local_action", action: followupAction.action ? followupAction.action.type : "followup_reply" }],
    };
  }

  const switchBotAction = parseDirectSwitchBot(task.text);
  if (switchBotAction) {
    return {
      reply: switchBotAction.reply,
      action: switchBotAction.action,
      actions: [{ type: "local_action", action: switchBotAction.action.type }],
    };
  }

  const healthAction = parseDirectHealthMetric(task.text);
  if (healthAction) {
    appendJsonLine(MEMORY_EVENT_FILE, {
      id: nextJsonLineId(MEMORY_EVENT_FILE),
      ts: new Date().toISOString(),
      remoteAddress: task.remoteAddress,
      ...healthAction.action.memory_event,
    });
    return {
      reply: healthAction.reply,
      action: healthAction.action,
      actions: [{ type: "local_action", action: healthAction.action.type }],
    };
  }

  const feishuAction = parseDirectFeishuMessage(task.text, task.allow_destructive);
  if (feishuAction) {
    return {
      reply: feishuAction.reply,
      action: feishuAction.action,
      actions: [{ type: "local_action", action: feishuAction.action.type }],
    };
  }

  const vagueAction = parseVagueVoiceCommand(task.text);
  if (vagueAction) {
    return {
      reply: vagueAction.reply,
      action: vagueAction.action,
      actions: [{ type: "local_action", action: "clarify" }],
    };
  }

  if (!task.allow_destructive && mayBeDestructive(task.text)) {
    return {
      reply: "这条指令可能包含删除、发送、付款或系统修改等不可逆操作。当前 allow_destructive=false，我不会执行。请在确认流程里重新发起。",
      actions: [{ type: "refuse_destructive", text: task.text }],
    };
  }
  const directAction = parseDirectAlarm(task.text) || parseDirectTimer(task.text);
  if (directAction) {
    return {
      reply: directAction.reply,
      action: directAction.action,
      actions: [{ type: "local_action", action: directAction.action.type }],
    };
  }
  return null;
}

async function maybeCallback(task) {
  if (!task.callback_url) return;
  try {
    const url = new URL(task.callback_url);
    const body = JSON.stringify(taskResponse(task));
    await new Promise((resolve) => {
      const req = http.request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        }
      );
      req.on("error", resolve);
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
      req.end(body);
    });
  } catch {
    // callback 是可选优化，失败不影响主任务结果。
  }
}

async function processVoiceQueue() {
  if (voiceQueueRunning) return;
  voiceQueueRunning = true;
  while (voiceQueue.length) {
    const task = voiceQueue.shift();
    if (!task || task.status !== "running") continue;
    try {
      const result = await runVoiceCommand(task);
      task.status = "done";
      task.reply = result.reply || "";
      task.action = result.action || null;
      task.actions = result.actions || [];
      task.finished_at = new Date().toISOString();
    } catch (error) {
      task.status = "error";
      task.error = error.message;
      task.finished_at = new Date().toISOString();
    }
    appendVoiceCommandLog(task);
    await maybeCallback(task);
  }
  voiceQueueRunning = false;
}

function startSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
}

function finishTask(task, result) {
  task.status = "done";
  task.reply = result.reply || "";
  task.action = result.action || null;
  task.actions = result.actions || [];
  task.finished_at = new Date().toISOString();
  appendVoiceCommandLog(task);
}

function failTask(task, error) {
  task.status = "error";
  task.error = error.message || String(error || "error");
  task.finished_at = new Date().toISOString();
  appendVoiceCommandLog(task);
}

async function handleVoiceCommandStream(req, res) {
  const payload = parseVoiceCommandPayload(await readBody(req));
  if (!payload.text) {
    json(res, 400, { error: "text 不能为空" });
    return;
  }
  const task = createUnqueuedVoiceTask(payload, req);
  startSse(res);
  writeSse(res, { event: "start", task_id: task.task_id, text: task.text });

  try {
    const immediate = runImmediateVoiceCommand(task);
    if (immediate) {
      finishTask(task, immediate);
      writeSse(res, { event: "done", done: true, ...taskResponse(task) });
      res.end();
      return;
    }

    if (!task.allow_destructive && mayBeDestructive(task.text)) {
      finishTask(task, {
        reply: "这条指令可能包含删除、发送、付款或系统修改等不可逆操作。当前 allow_destructive=false，我不会执行。请在确认流程里重新发起。",
        actions: [{ type: "refuse_destructive", text: task.text }],
      });
      writeSse(res, { event: "done", done: true, ...taskResponse(task) });
      res.end();
      return;
    }

    if (isWeatherQuery(task.text, task.context)) {
      const result = await runWeatherQuery(task).catch((error) => ({
        reply: `${VOICE_DEFAULT_LOCATION}天气暂时查不到，请稍后再试。`,
        action: null,
        actions: [{ type: "weather_query_failed", provider: "open-meteo", error: error.message }],
      }));
      finishTask(task, result);
      writeSse(res, { event: "done", done: true, ...taskResponse(task) });
      res.end();
      return;
    }

    if (shouldUseGlmChat(task)) {
      let reply = "";
      try {
        writeSse(res, { event: "stage", stage: "glm_chat", model: VOICE_GLM_MODEL });
        if (VOICE_GLM_NATIVE_STREAM) {
          await requestGlmStream(glmChatBody(task), (delta) => {
            reply += delta;
            writeSse(res, { event: "delta", delta, done: false });
          });
        } else {
          const data = await requestGlm(glmChatBody(task));
          const content = Array.isArray(data.content) ? data.content : [];
          reply = sanitizeReply(content
            .filter((item) => item && item.type === "text")
            .map((item) => item.text || "")
            .join("")
          );
          for (const delta of replyChunks(reply)) {
            writeSse(res, { event: "delta", delta, done: false });
          }
        }
        finishTask(task, {
          reply: sanitizeReply(reply),
          action: null,
          actions: [{ type: "glm_chat", model: VOICE_GLM_MODEL, stream: VOICE_GLM_NATIVE_STREAM ? "native" : "buffered_sse" }],
        });
        writeSse(res, { event: "done", done: true, ...taskResponse(task) });
        res.end();
        return;
      } catch (error) {
        task.skip_glm = true;
        task.actions = [{ type: "glm_chat_failed", error: error.message }];
        writeSse(res, { event: "stage", stage: "glm_chat_failed" });
      }
    }

    writeSse(res, { event: "stage", stage: "agent_process" });
    const result = await runVoiceCommand(task);
    finishTask(task, result);
    writeSse(res, { event: "done", done: true, ...taskResponse(task) });
    res.end();
  } catch (error) {
    failTask(task, error);
    writeSse(res, { event: "done", done: true, ...taskResponse(task) });
    res.end();
  }
}

function createVoiceTask(payload, req) {
  cleanupRequestIds();
  if (payload.request_id && requestIds.has(payload.request_id)) {
    return voiceTasks.get(requestIds.get(payload.request_id).taskId);
  }

  const task = {
    task_id: crypto.randomUUID(),
    request_id: payload.request_id,
    status: "running",
    text: payload.text,
    source: payload.source,
    allow_destructive: payload.allow_destructive,
    callback_url: payload.callback_url,
    context: payload.context,
    created_at: new Date().toISOString(),
    remoteAddress: req.socket.remoteAddress,
    reply: "",
    action: null,
    error: "",
    actions: [],
  };
  voiceTasks.set(task.task_id, task);
  if (payload.request_id) {
    requestIds.set(payload.request_id, { taskId: task.task_id, createdAt: Date.now() });
  }
  const immediate = runImmediateVoiceCommand(task);
  if (immediate) {
    task.status = "done";
    task.reply = immediate.reply || "";
    task.action = immediate.action || null;
    task.actions = immediate.actions || [];
    task.finished_at = new Date().toISOString();
    appendVoiceCommandLog(task);
    maybeCallback(task);
  } else {
    voiceQueue.push(task);
    processVoiceQueue();
  }
  return task;
}

function waitForTask(task, timeoutMs) {
  if (task.status !== "running" || timeoutMs <= 0) return Promise.resolve(task);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (task.status !== "running" || Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        resolve(task);
      }
    }, 50);
  });
}

function serveFile(res, requestPath) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC, safePath));
  if (!filePath.startsWith(PUBLIC)) {
    text(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, body) => {
    if (error) {
      text(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
    };
    text(res, 200, body, types[ext] || "application/octet-stream");
  });
}

async function status() {
  const [uname, model, android, abi, free, dataDf, sharedDf, network] = await Promise.all([
    run("uname", ["-a"]),
    run("getprop", ["ro.product.model"]),
    run("getprop", ["ro.build.version.release"]),
    run("getprop", ["ro.product.cpu.abi"]),
    run("free", ["-h"]),
    run("df", ["-h", HOME]),
    run("df", ["-h", path.join(HOME, "storage", "shared")]),
    run("ifconfig"),
  ]);

  return {
    time: new Date().toISOString(),
    device: {
      kernel: uname.stdout,
      model: model.stdout,
      android: android.stdout,
      abi: abi.stdout,
    },
    memory: free.stdout,
    storage: {
      termux: dataDf.stdout,
      shared: sharedDf.stdout,
    },
    network: network.stdout,
  };
}

async function storageSummary() {
  const entries = [
    ["共享根目录", "storage/shared"],
    ["下载", "storage/downloads"],
    ["相册 DCIM", "storage/dcim"],
    ["图片", "storage/pictures"],
    ["音乐", "storage/music"],
    ["视频", "storage/movies"],
  ];

  const rows = await Promise.all(
    entries.map(async ([name, rel]) => {
      const linkPath = path.join(HOME, rel);
      const full = fs.realpathSync(linkPath);
      const [du, count] = await Promise.all([
        run("du", ["-sh", full], 15000),
        run("find", [full, "-maxdepth", "1", "-mindepth", "1"], 15000),
      ]);
      return {
        name,
        path: full,
        size: du.ok ? du.stdout.split(/\s+/)[0] : "不可用",
        items: count.ok && count.stdout ? count.stdout.split("\n").length : 0,
      };
    })
  );

  return { rows };
}

async function androidApiCheck() {
  const commands = [
    "termux-battery-status",
    "termux-clipboard-get",
    "termux-notification",
    "termux-location",
    "termux-tts-speak",
  ];

  const checks = await Promise.all(
    commands.map(async (name) => {
      const result = await run("sh", ["-c", `command -v ${name}`]);
      return { name, available: result.ok && Boolean(result.stdout), path: result.stdout };
    })
  );

  return {
    note: "这些命令还需要手机安装 Termux:API 应用并授予对应权限。",
    checks,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/voice-log" && req.method === "POST") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      const payload = parseVoicePayload(await readBody(req), req);
      if (!payload.text) {
        json(res, 400, { error: "text 不能为空" });
        return;
      }
      const entry = {
        time: new Date().toISOString(),
        source: payload.source,
        text: payload.text,
        remoteAddress: req.socket.remoteAddress,
      };
      appendVoiceLog(entry);
      json(res, 200, { ok: true, entry });
      return;
    }

    if (url.pathname === "/api/voice-command/stream" && req.method === "POST") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      await handleVoiceCommandStream(req, res);
      return;
    }

    if (url.pathname === "/api/voice-command" && req.method === "POST") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      const payload = parseVoiceCommandPayload(await readBody(req));
      if (!payload.text) {
        json(res, 400, { error: "text 不能为空" });
        return;
      }
      const task = createVoiceTask(payload, req);
      const waitMs = Math.min(payload.ack_timeout_ms, VOICE_HTTP_TOTAL_TIMEOUT_MS);
      await waitForTask(task, waitMs);
      json(res, task.status === "running" ? 202 : 200, taskResponse(task));
      return;
    }

    if (url.pathname === "/api/bridge" && req.method === "POST") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      const message = createBridgeMessage(await readBody(req), req);
      json(res, 200, { ok: true, id: message.id, ts: message.ts });
      return;
    }

    if (url.pathname === "/api/bridge" && req.method === "GET") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      json(res, 200, bridgeMessages(url));
      return;
    }

    if (url.pathname === "/api/memory-event" && req.method === "POST") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      const event = createMemoryEvent(await readBody(req), req);
      json(res, 200, { ok: true, id: event.id });
      return;
    }

    if (url.pathname === "/api/memory-event" && req.method === "GET") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      json(res, 200, memoryEvents(url));
      return;
    }

    const voiceCommandMatch = url.pathname.match(/^\/api\/voice-command\/([^/]+)$/);
    if (voiceCommandMatch && req.method === "GET") {
      if (!isVoiceTokenAuthorized(req, url)) {
        json(res, 401, { error: "voice token 无效" });
        return;
      }
      const task = voiceTasks.get(decodeURIComponent(voiceCommandMatch[1]));
      if (!task) {
        json(res, 404, { error: "task 不存在" });
        return;
      }
      json(res, 200, taskResponse(task));
      return;
    }

    if (!requireAuth(req, res)) return;

    if (url.pathname === "/api/status") {
      json(res, 200, await status());
      return;
    }
    if (url.pathname === "/api/storage-summary") {
      json(res, 200, await storageSummary());
      return;
    }
    if (url.pathname === "/api/android-api") {
      json(res, 200, await androidApiCheck());
      return;
    }
    if (url.pathname === "/api/voice-log" && req.method === "GET") {
      json(res, 200, { rows: recentVoiceLogs(Number(url.searchParams.get("limit") || 30)) });
      return;
    }
    serveFile(res, url.pathname);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Phone Hub listening on http://${HOST}:${PORT}`);
  console.log(`Login user: ${AUTH_USER}`);
  console.log(`Password file: ${PASSWORD_FILE}`);
  console.log(`Voice token file: ${VOICE_TOKEN_FILE}`);
});

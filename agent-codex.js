#!/usr/bin/env node
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_LOCATION = process.env.VOICE_DEFAULT_LOCATION || "";
const MEMORY_EVENT_FILE = path.join(__dirname, "data", "memory-events.jsonl");
const CODEX_AGENT_MODEL = String(process.env.CODEX_AGENT_MODEL || "").trim();
const DEFAULT_WEATHER = DEFAULT_LOCATION
  ? {
      name: DEFAULT_LOCATION,
      latitude: Number(process.env.VOICE_DEFAULT_LAT || 0),
      longitude: Number(process.env.VOICE_DEFAULT_LON || 0),
    }
  : null;

function print(reply) {
  const output = typeof reply === "object" ? JSON.stringify(sanitizeOutput(reply)) : sanitizeReply(reply);
  process.stdout.write(`${output}\n`);
}

function sanitizeReply(reply, maxChars = 260) {
  let text = String(reply || "").replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!text) return "";
  const paragraphs = text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  const seenParagraphs = new Set();
  text = paragraphs.filter((paragraph) => {
    const key = paragraph.replace(/[，。！？、,.!?;；:\s]/g, "");
    if (!key || seenParagraphs.has(key)) return false;
    seenParagraphs.add(key);
    return true;
  }).slice(0, 3).join("\n");

  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  const seenSentences = new Set();
  text = sentences.filter((sentence) => {
    const key = sentence.trim().replace(/[，。！？、,.!?;；:\s]/g, "");
    if (!key || seenSentences.has(key)) return false;
    seenSentences.add(key);
    return true;
  }).join("").trim();

  const voiceSentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  text = voiceSentences.slice(0, 3).join("").trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars).replace(/[，,、；;：:\s]+$/g, "")}。`;
  return text;
}

function sanitizeOutput(value) {
  if (!value || typeof value !== "object") return value;
  return { ...value, reply: sanitizeReply(value.reply) };
}

function isDestructive(text) {
  return /删除|清空|发送|付款|支付|转账|卸载|关机|重启|格式化|覆盖|写入|修改|移动|复制|安装|提交|推送|rm\s+-|kill|reset|checkout|commit|push|chmod|chown|mv\s+|cp\s+|>|>>/i.test(text);
}

function chineseNumber(n) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n < 10) return digits[n];
  if (n === 10) return "十";
  if (n < 20) return `十${digits[n - 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}

function periodOfDay(hour) {
  if (hour < 5) return "凌晨";
  if (hour < 9) return "早上";
  if (hour < 11) return "上午";
  if (hour < 13) return "中午";
  if (hour < 18) return "下午";
  return "晚上";
}

function formatSpokenTime(date = new Date()) {
  const hour = date.getHours();
  const minute = date.getMinutes();
  let spokenHour = hour % 12;
  if (spokenHour === 0) spokenHour = 12;
  const minuteText = minute === 0 ? "整" : `${minute < 10 ? "零" : ""}${chineseNumber(minute)}分`;
  return `${periodOfDay(hour)}${chineseNumber(spokenHour)}点${minuteText}`;
}

function formatSpokenDate(date = new Date()) {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  return `${chineseNumber(date.getMonth() + 1)}月${chineseNumber(date.getDate())}日，${weekdays[date.getDay()]}`;
}

function formatNow(text) {
  try {
    const now = new Date();
    const asksDate = /今天.*几号|今天.*日期|日期/.test(text);
    const asksTime = /几点|现在.*时间|当前.*时间|现在.*几分/.test(text);
    if (asksDate && asksTime) return `今天是${formatSpokenDate(now)}，现在是${formatSpokenTime(now)}`;
    if (asksDate) return `今天是${formatSpokenDate(now)}`;
    return `现在是${formatSpokenTime(now)}`;
  } catch {
    return new Date().toString();
  }
}

function fastReply(text) {
  if (/几点|现在.*时间|当前.*时间|现在.*几分|今天.*几号|今天.*日期|日期/.test(text)) {
    return `${formatNow(text)}。`;
  }
  if (/你能做什么|你会做什么|有什么功能|你有什么用|能干什么/.test(text)) {
    const replies = [
      "我可以查天气和时间，设闹钟计时，也能记住飞书和健康记录。你直接说要做什么就行。",
      "现在我比较适合做几类事：查天气时间、设闹钟计时、记录体重腰围这类健康数据，复杂问题再交给 Codex。",
      "你可以让我记录健康数据、查今天或明天的天气、设置闹钟和计时；如果问题复杂，我会再慢一点认真处理。",
    ];
    return replies[Math.floor(Date.now() / 60000) % replies.length];
  }
  return "";
}

function readMemoryEvents(limit = 200) {
  if (!fs.existsSync(MEMORY_EVENT_FILE)) return [];
  return fs.readFileSync(MEMORY_EVENT_FILE, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function isMemoryQuery(text) {
  return /我今天|今天.*吃|吃了什么|吃过什么|飞书|推送|更新|日报|健康|体重|睡眠|运动|healthapp|记录|发生了什么|总结今天/.test(text);
}

function relevantMemory(text) {
  if (!isMemoryQuery(text)) return [];
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const keywords = [];
  if (/吃|饭|早餐|午餐|晚餐|饮食/.test(text)) keywords.push("meal", "food", "早餐", "午餐", "晚餐", "吃");
  if (/天气/.test(text)) keywords.push("weather", "天气");
  if (/更新|日报|总结/.test(text)) keywords.push("update", "daily_summary", "更新", "日报", "总结");
  if (/健康|体重|睡眠|运动|health/.test(text)) keywords.push("health", "sleep", "weight", "sport", "健康", "睡眠", "体重", "运动");
  if (/飞书|推送/.test(text)) keywords.push("feishu", "飞书", "推送");

  return readMemoryEvents(500)
    .filter((event) => {
      const created = String(event.created_at || event.ts || "");
      const haystack = `${event.source || ""} ${event.type || ""} ${event.title || ""} ${event.text || ""}`.toLowerCase();
      const isToday = !/今天/.test(text) || created.startsWith(today) || created.includes(today);
      const matchesKeyword = !keywords.length || keywords.some((kw) => haystack.includes(String(kw).toLowerCase()));
      return isToday && matchesKeyword;
    })
    .slice(-20);
}

function emitAction(reply, action) {
  print({ reply, action });
}

function normalizeNumber(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const map = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
    二十: 20, 两十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25, 二十六: 26,
    二十七: 27, 二十八: 28, 二十九: 29, 三十: 30,
  };
  return Object.prototype.hasOwnProperty.call(map, text) ? map[text] : null;
}

function parseAlarm(text) {
  if (!/闹钟|叫我|提醒我/.test(text)) return null;
  const match = text.match(/(凌晨|早上|上午|中午|下午|晚上|明早|明天早上|明天上午|明晚|明天晚上)?\s*([0-9零一二两三四五六七八九十]{1,3})\s*[点:：]\s*([0-9零一二两三四五六七八九十]{1,3})?\s*分?/);
  if (!match) return null;
  let hour = normalizeNumber(match[2]);
  const minute = normalizeNumber(match[3] || "0");
  if (hour == null || minute == null || minute > 59) return null;
  const period = match[1] || "";
  if (/下午|晚上|明晚|明天晚上/.test(period) && hour < 12) hour += 12;
  if (/凌晨/.test(period) && hour === 12) hour = 0;
  if (/中午/.test(period) && hour < 11) hour += 12;
  if (hour > 23) return null;
  const label = /起床/.test(text) ? "起床" : "闹钟";
  const spoken = `${period.includes("明") ? "明天" : ""}${periodOfDay(hour)}${chineseNumber(hour % 12 || 12)}点${minute === 0 ? "整" : `${minute < 10 ? "零" : ""}${chineseNumber(minute)}分`}`;
  return {
    reply: `好，已设${spoken}的${label}。`,
    action: { type: "set_alarm", hour, minute, label },
  };
}

function parseTimer(text) {
  if (!/计时|倒计时|定时|分钟后|小时后/.test(text)) return null;
  let seconds = 0;
  const hourMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*个?\s*小时/);
  const minuteMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*分钟/);
  const secondMatch = text.match(/([0-9零一二两三四五六七八九十]{1,3})\s*秒/);
  if (hourMatch) seconds += (normalizeNumber(hourMatch[1]) || 0) * 3600;
  if (minuteMatch) seconds += (normalizeNumber(minuteMatch[1]) || 0) * 60;
  if (secondMatch) seconds += normalizeNumber(secondMatch[1]) || 0;
  if (!seconds) return null;
  const label = /煮蛋/.test(text) ? "煮蛋" : "计时";
  const minutes = Math.round(seconds / 60);
  const spoken = seconds % 60 === 0 && minutes > 0 ? `${chineseNumber(minutes)}分钟` : `${seconds}秒`;
  return {
    reply: `好，已开始${spoken}${label}。`,
    action: { type: "set_timer", seconds, label },
  };
}

function isWeatherQuery(text, context = []) {
  if (/天气|气温|温度|下雨|降雨|带伞|冷不冷|热不热/.test(text)) return true;
  const recent = context.map((item) => item.text).join(" ");
  return /天气|气温|温度|下雨|降雨|带伞/.test(recent) && /那|明天|后天|今天|还会|怎么样/.test(text);
}

function requestJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
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
  const cleaned = text
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

async function weatherReply(text) {
  const loc = await resolveWeatherLocation(text);
  if (!loc) {
    return "还没有设置默认城市，请说出城市名，或在 .env 配置 VOICE_DEFAULT_LOCATION。";
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=3`;
  const data = await requestJson(url, 8000);
  const offset = weatherDayOffset(text);
  if (offset > 0 && data.daily && data.daily.time && data.daily.time[offset]) {
    const max = Math.round(Number(data.daily.temperature_2m_max[offset]));
    const min = Math.round(Number(data.daily.temperature_2m_min[offset]));
    const rainProb = Math.round(Number(data.daily.precipitation_probability_max[offset] || 0));
    const label = weatherLabel(Number(data.daily.weather_code[offset]));
    const dayName = offset === 1 ? "明天" : "后天";
    const umbrella = rainProb >= 40 || /雨/.test(label) ? "建议带伞。" : "一般不用带伞。";
    return `${loc.name}${dayName}${label}，气温约${min}到${max}度，降雨概率约${rainProb}%。${umbrella}`;
  }
  const current = data.current || {};
  const temp = Math.round(Number(current.temperature_2m));
  const feels = Math.round(Number(current.apparent_temperature));
  const rain = Number(current.precipitation || 0);
  const wind = Math.round(Number(current.wind_speed_10m || 0));
  const label = weatherLabel(Number(current.weather_code));
  const umbrella = rain > 0 || /雨/.test(label) ? "建议带伞。" : "一般不用带伞。";
  return `${loc.name}现在${label}，气温约${temp}度，体感${feels}度，风速约每小时${wind}公里。${umbrella}`;
}

const input = fs.readFileSync(0, "utf8").trim().split(/\r?\n/, 1)[0] || "{}";

let task;
try {
  task = JSON.parse(input);
} catch {
  print("收到的任务不是有效 JSON。");
  process.exit(0);
}

const text = String(task.text || "").trim();
const context = Array.isArray(task.context)
  ? task.context
      .slice(-6)
      .map((item) => ({
        role: String(item && item.role || "").trim(),
        text: String(item && item.text || "").trim(),
      }))
      .filter((item) => /^(user|assistant)$/.test(item.role) && item.text)
  : [];
const allowDestructive = Boolean(task.allow_destructive);

if (!text) {
  print("没有收到可执行的指令。");
  process.exit(0);
}

if (!allowDestructive && isDestructive(text)) {
  print("这条指令可能涉及不可逆操作，当前不执行。");
  process.exit(0);
}

const fast = fastReply(text);
if (fast) {
  print(fast);
  process.exit(0);
}

const alarm = parseAlarm(text);
if (alarm) {
  emitAction(alarm.reply, alarm.action);
  process.exit(0);
}

const timer = parseTimer(text);
if (timer) {
  emitAction(timer.reply, timer.action);
  process.exit(0);
}

if (isWeatherQuery(text, context)) {
  weatherReply(text)
    .then((reply) => {
      print(reply);
      process.exit(0);
    })
    .catch(() => {
      print(`${DEFAULT_LOCATION}天气暂时查不到，请稍后再试。`);
      process.exit(0);
    });
} else {

const tmpFile = path.join(
  os.tmpdir(),
  `phone-hub-codex-${process.pid}-${Date.now()}.txt`,
);

const memories = relevantMemory(text);

const prompt = [
  "你是这台手机上的 Codex 语音助手代理。",
  "只输出给用户看的简短中文结果，不要输出日志、Markdown 标题、工具过程或多余解释。",
  "可以为回答问题读取本机状态或运行只读命令；不要修改文件、发送消息、付款、安装软件、重启服务或执行不可逆操作。",
  `默认位置是${DEFAULT_LOCATION}；当用户询问天气、附近、路线或本地信息但没有说明地点时，按这个默认位置理解。用户明确说了地点时，以用户地点为准。`,
  `allow_destructive=${allowDestructive ? "true" : "false"}。即使为 true，也必须拒绝高风险或不可逆操作。`,
  context.length ? `最近对话上下文：${JSON.stringify(context)}` : "",
  memories.length ? `手机生活记忆检索结果：${JSON.stringify(memories)}` : "",
  "",
  `用户指令：${text}`,
].filter(Boolean).join("\n");

function runCodex() {
  return new Promise((resolve) => {
    const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--cd",
    process.env.HOME || "/data/data/com.termux/files/home",
    "-o",
    tmpFile,
    prompt,
    ];
    if (CODEX_AGENT_MODEL) args.splice(3, 0, "-m", CODEX_AGENT_MODEL);
    const child = spawn("codex", args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, Number(process.env.CODEX_AGENT_TIMEOUT_MS || 25000));

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
      resolve({ status: null, stdout, stderr: stderr || error.message, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

(async () => {
const result = await runCodex();

let reply = "";
try {
  if (fs.existsSync(tmpFile)) {
    reply = fs.readFileSync(tmpFile, "utf8").trim();
    fs.unlinkSync(tmpFile);
  }
} catch {
  // Keep stdout clean; fall through to the generic failure reply.
}

if (result.timedOut) {
  print("处理超时，请稍后再试。");
  process.exit(0);
}

if (result.status !== 0 && !reply) {
  print("Codex 代理执行失败，请检查本机 Codex 配置。");
  process.exit(0);
}

print(reply || "执行完成。");
})();
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}

function card(title, value) {
  return `<article class="card"><h3>${title}</h3><pre>${value || "无数据"}</pre></article>`;
}

function renderStatus(data) {
  document.querySelector("#updated").textContent = new Date().toLocaleString("zh-CN");
  document.querySelector("#status").innerHTML = [
    card("设备", `型号：${data.device.model}\nAndroid：${data.device.android}\n架构：${data.device.abi}`),
    card("内存", data.memory),
    card("存储", `${data.storage.termux}\n\n${data.storage.shared}`),
    card("网络", data.network),
  ].join("");
}

function renderStorage(data) {
  const rows = data.rows
    .map(
      (row) => `
        <div class="tr">
          <strong>${row.name}</strong>
          <span>${row.size}</span>
          <span>${row.items} 项</span>
          <code>${row.path}</code>
        </div>
      `
    )
    .join("");
  document.querySelector("#storage").innerHTML = rows;
}

function renderAndroidApi(data) {
  document.querySelector("#android-api").innerHTML = data.checks
    .map((item) => card(item.name, item.available ? "可用" : "等待 Android 应用/权限"))
    .join("");
}

function renderVoiceLog(data) {
  const target = document.querySelector("#voice-log");
  if (!data.rows.length) {
    target.innerHTML = `<p class="empty">还没有同步进来的语音文本</p>`;
    return;
  }

  target.innerHTML = data.rows
    .map(
      (row) => `
        <article class="voice-item">
          <div>
            <strong>${new Date(row.time).toLocaleString("zh-CN")}</strong>
            <span>${row.source || "unknown"}</span>
          </div>
          <p>${row.text}</p>
        </article>
      `
    )
    .join("");
}

async function refresh() {
  document.body.classList.add("loading");
  try {
    const [status, storage, androidApi, voiceLog] = await Promise.all([
      getJson("/api/status"),
      getJson("/api/storage-summary"),
      getJson("/api/android-api"),
      getJson("/api/voice-log"),
    ]);
    renderStatus(status);
    renderStorage(storage);
    renderAndroidApi(androidApi);
    renderVoiceLog(voiceLog);
  } finally {
    document.body.classList.remove("loading");
  }
}

document.querySelector("#refresh").addEventListener("click", refresh);
refresh().catch((error) => {
  document.querySelector("#status").innerHTML = card("加载失败", error.message);
});

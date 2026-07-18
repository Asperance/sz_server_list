const DATA_URL = "./data/servers.json";
const WHOIS_CACHE_KEY = "stalzone-pages-whois-v1";
const REGION_ORDER = ["EU", "NA", "SEA", "NEA", "RU"];

const $ = (id) => document.getElementById(id);

let database = null;
let whois = loadWhoisCache();
let visibleServers = [];

function toast(text) {
  const element = $("toast");
  element.textContent = text;
  element.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => element.classList.remove("show"), 1500);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  toast(message);
}

function loadWhoisCache() {
  try {
    return JSON.parse(localStorage.getItem(WHOIS_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveWhoisCache() {
  try {
    localStorage.setItem(WHOIS_CACHE_KEY, JSON.stringify(whois));
  } catch {
    // Local storage can be disabled. The current page still remains usable.
  }
}

async function loadDatabase({ notify = false } = {}) {
  $("refreshBtn").disabled = true;

  try {
    const response = await fetch(`${DATA_URL}?ts=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();

    if (!payload || !Array.isArray(payload.servers)) {
      throw new Error("Некорректный servers.json");
    }

    database = payload;
    rebuild();

    if (notify) {
      toast("Последний снимок загружен");
    }
  } catch (error) {
    $("regions").innerHTML = `
      <section class="panel empty">
        Не удалось загрузить data/servers.json: ${escapeHtml(error.message || error)}
      </section>
    `;
    if (notify) toast("Ошибка загрузки");
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function rebuild() {
  if (!database) return;

  renderStats();
  renderEndpoints();
  rebuildFilters();

  visibleServers = applyFilters(database.servers);
  renderRegions(visibleServers);
}

function renderStats() {
  const summary = database.summary || {};

  $("statEndpoints").textContent =
    `${summary.endpointOnline ?? 0}/${summary.endpointTotal ?? 0}`;
  $("statRegions").textContent = summary.regionCount ?? 0;
  $("statPools").textContent = summary.poolCount ?? 0;
  $("statTunnels").textContent = summary.tunnelCount ?? 0;
  $("statIps").textContent = summary.uniqueIpCount ?? 0;
  $("statUpdated").textContent = database.generatedAt
    ? new Date(database.generatedAt).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

function renderEndpoints() {
  $("endpointGrid").innerHTML = (database.endpoints || []).map((endpoint) => {
    const detail = endpoint.ok
      ? `${endpoint.poolCount} пулов · ${endpoint.tunnelCount} туннелей · ${endpoint.durationMs} мс`
      : endpoint.error || "Ошибка";

    return `
      <article class="endpoint">
        <div class="endpoint-top">
          <span class="endpoint-name">${escapeHtml(endpoint.label)}</span>
          <span class="status ${endpoint.ok ? "ok" : "error"}">
            ${endpoint.ok ? "online" : "ошибка"}
          </span>
        </div>
        <a
          class="endpoint-url"
          href="${escapeAttribute(endpoint.url)}"
          target="_blank"
          rel="noreferrer"
        >${escapeHtml(endpoint.url)}</a>
        <div class="endpoint-detail">${escapeHtml(detail)}</div>
      </article>
    `;
  }).join("");
}

function rebuildFilters() {
  const previous = {
    region: $("regionFilter").value,
    pool: $("poolFilter").value,
    endpoint: $("endpointFilter").value,
  };

  const servers = database.servers || [];
  const regions = [...new Set(servers.map((server) => server.region))].sort();
  const pools = [...new Set(servers.map((server) => server.pool))].sort();
  const endpoints = [...new Set(servers.map((server) => server.endpointId))].sort();

  $("regionFilter").innerHTML =
    `<option value="">Все регионы</option>` +
    regions.map((region) =>
      `<option value="${escapeAttribute(region)}">${escapeHtml(region)}</option>`
    ).join("");

  $("poolFilter").innerHTML =
    `<option value="">Все пулы</option>` +
    pools.map((pool) =>
      `<option value="${escapeAttribute(pool)}">${escapeHtml(pool)}</option>`
    ).join("");

  $("endpointFilter").innerHTML =
    `<option value="">Все endpoint’ы</option>` +
    endpoints.map((endpoint) =>
      `<option value="${escapeAttribute(endpoint)}">${escapeHtml(endpoint)}</option>`
    ).join("");

  $("regionFilter").value = previous.region;
  $("poolFilter").value = previous.pool;
  $("endpointFilter").value = previous.endpoint;
}

function applyFilters(servers) {
  const query = $("search").value.trim().toLowerCase();
  const region = $("regionFilter").value;
  const pool = $("poolFilter").value;
  const endpoint = $("endpointFilter").value;

  return servers.filter((server) => {
    if (region && server.region !== region) return false;
    if (pool && server.pool !== pool) return false;
    if (endpoint && server.endpointId !== endpoint) return false;
    if (!query) return true;

    const info = whois[server.ip] || {};

    return [
      server.region,
      server.regionLabel,
      server.endpointId,
      server.endpoint,
      server.pool,
      server.name,
      server.address,
      server.ip,
      server.port,
      info.asn,
      info.org,
      info.city,
      info.country,
    ].join(" ").toLowerCase().includes(query);
  });
}

function renderRegions(servers) {
  const grouped = {};

  for (const server of servers) {
    grouped[server.region] ??= {};
    grouped[server.region][server.pool] ??= [];
    grouped[server.region][server.pool].push(server);
  }

  const additionalRegions = Object.keys(grouped)
    .filter((region) => !REGION_ORDER.includes(region))
    .sort();
  const order = [...REGION_ORDER, ...additionalRegions];

  $("regionNav").innerHTML = order
    .filter((region) => grouped[region])
    .map((region) => {
      const count = Object.values(grouped[region]).flat().length;
      return `<a href="#region-${escapeAttribute(region)}">${escapeHtml(region)} · ${count}</a>`;
    })
    .join("");

  $("regions").innerHTML = order
    .filter((region) => grouped[region])
    .map((region) => {
      const pools = grouped[region];
      const regionServers = Object.values(pools).flat();
      const endpoint = database.endpoints.find(
        (item) => item.region === region,
      );
      const regionData = database.regions?.[region];

      return `
        <section class="panel region-card open" id="region-${escapeAttribute(region)}">
          <div class="region-head">
            <div class="region-code">${escapeHtml(region)}</div>
            <div>
              <h2>${escapeHtml(endpoint?.label || region)}</h2>
              <div class="region-meta">
                ${regionServers.length} туннелей ·
                ${new Set(regionServers.map((server) => server.ip)).size} IP ·
                ${Object.keys(pools).length} пулов
              </div>
            </div>
            <span class="chevron">⌄</span>
          </div>

          <div class="region-body">
            <div class="source-line">
              <span class="source-pill">${escapeHtml(endpoint?.url || regionData?.endpoint || "")}</span>
              ${regionData?.mode ? `<span class="source-pill">mode: ${escapeHtml(regionData.mode)}</span>` : ""}
            </div>

            ${Object.entries(pools).map(([pool, poolServers]) => `
              <section class="pool">
                <div class="pool-head">
                  <span class="pool-name">${escapeHtml(pool)}</span>
                  <span class="pool-count">${poolServers.length} серверов</span>
                </div>

                <div class="table-wrap">
                  <table>
                    <colgroup><col><col><col><col><col><col><col></colgroup>
                    <thead>
                      <tr>
                        <th>Сервер</th>
                        <th>Адрес</th>
                        <th>Пул</th>
                        <th>Порт</th>
                        <th>ASN / оператор</th>
                        <th>Город / страна</th>
                        <th>Endpoint</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${poolServers.map(serverRow).join("")}
                    </tbody>
                  </table>
                </div>
              </section>
            `).join("")}
          </div>
        </section>
      `;
    })
    .join("") || `<section class="panel empty">По заданным фильтрам ничего не найдено.</section>`;

  document.querySelectorAll(".region-head").forEach((header) => {
    header.addEventListener("click", () => {
      header.closest(".region-card").classList.toggle("open");
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      copyText(button.dataset.copy, "Адрес скопирован");
    });
  });
}

function serverRow(server) {
  const info = whois[server.ip] || {};

  const networkCell = info.asn || info.org
    ? `<strong>${escapeHtml(info.asn || "—")}</strong>
       <div class="muted">${escapeHtml(info.org || "—")}</div>`
    : `<span class="muted">—</span>`;

  const locationCell = info.city || info.country
    ? `<strong>${escapeHtml(info.city || "—")}</strong>
       <div class="muted">${escapeHtml(info.country || "—")}</div>`
    : `<span class="muted">—</span>`;

  return `
    <tr>
      <td data-label="Сервер">
        <strong>${escapeHtml(server.name)}</strong>
        <div class="muted">${escapeHtml(server.endpointId)}</div>
      </td>
      <td data-label="Адрес">
        <code>${escapeHtml(server.address)}</code>
        <button class="copy" data-copy="${escapeAttribute(server.address)}" type="button">⧉</button>
      </td>
      <td data-label="Пул">${escapeHtml(server.pool)}</td>
      <td data-label="Порт">${server.port ?? "—"}</td>
      <td data-label="ASN / оператор">${networkCell}</td>
      <td data-label="Город / страна">${locationCell}</td>
      <td data-label="Endpoint"><span class="muted">${escapeHtml(server.endpoint)}</span></td>
    </tr>
  `;
}

async function loadWhois() {
  if (!database) return;

  const ips = [...new Set(database.servers.map((server) => server.ip).filter(Boolean))];
  const missing = ips.filter((ip) => !whois[ip]);

  if (!missing.length) {
    toast("IP-данные уже загружены");
    return;
  }

  $("whoisBtn").disabled = true;
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < missing.length) {
      const ip = missing[cursor++];

      try {
        const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
          cache: "force-cache",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        const data = await response.json();

        if (data.success !== false) {
          whois[ip] = {
            asn: data.connection?.asn ? `AS${data.connection.asn}` : "",
            org: data.connection?.org || data.connection?.isp || "",
            city: data.city || "",
            country: data.country || "",
          };
        }
      } catch {
        // Ошибка одного IP не прерывает остальные запросы.
      }

      completed += 1;
      $("whoisBtn").textContent = `${completed}/${missing.length}`;
    }
  }

  await Promise.all([worker(), worker(), worker(), worker()]);
  $("whoisBtn").disabled = false;
  $("whoisBtn").textContent = "Загрузить IP-данные";

  saveWhoisCache();
  rebuild();
  toast(`IP-данные: ${Object.keys(whois).length}/${ips.length}`);
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = name;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  if (!database) return;

  download(
    "stalzone_servers.json",
    JSON.stringify({ ...database, whois }, null, 2),
    "application/json",
  );
}

function csvEscape(value) {
  const string = String(value ?? "");
  return /[",\n]/.test(string)
    ? `"${string.replaceAll('"', '""')}"`
    : string;
}

function exportCsv() {
  if (!database) return;

  const lines = [[
    "region",
    "endpoint",
    "pool",
    "server",
    "ip",
    "port",
    "address",
    "asn",
    "operator",
    "city",
    "country",
  ].join(",")];

  for (const server of database.servers) {
    const info = whois[server.ip] || {};
    lines.push([
      server.region,
      server.endpoint,
      server.pool,
      server.name,
      server.ip,
      server.port,
      server.address,
      info.asn,
      info.org,
      info.city,
      info.country,
    ].map(csvEscape).join(","));
  }

  download(
    "stalzone_servers.csv",
    `\ufeff${lines.join("\n")}`,
    "text/csv;charset=utf-8",
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

$("refreshBtn").addEventListener("click", () => loadDatabase({ notify: true }));
$("whoisBtn").addEventListener("click", loadWhois);
$("exportJsonBtn").addEventListener("click", exportJson);
$("exportCsvBtn").addEventListener("click", exportCsv);

$("copyVisibleBtn").addEventListener("click", () => {
  const ips = [...new Set(visibleServers.map((server) => server.ip).filter(Boolean))];

  if (!ips.length) {
    toast("Нет IP");
    return;
  }

  copyText(ips.join("\n"), `Скопировано IP: ${ips.length}`);
});

["search", "regionFilter", "poolFilter", "endpointFilter"].forEach((id) => {
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    if (!database) return;
    visibleServers = applyFilters(database.servers);
    renderRegions(visibleServers);
  });
});

loadDatabase();

const DATA_URL = "./data/servers.json";
const DEFAULT_REGION_ORDER = ["RU", "EU", "NA", "SEA", "NEA"];

const $ = (id) => document.getElementById(id);

let database = null;
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
      throw new Error("Некорректный файл данных");
    }

    database = payload;
    rebuild();

    if (notify) {
      toast("Последний снимок загружен");
    }
  } catch (error) {
    $("regions").innerHTML = `
      <section class="panel empty">
        Не удалось загрузить список: ${escapeHtml(error.message || error)}
      </section>
    `;

    if (notify) {
      toast("Ошибка загрузки");
    }
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function getRegionOrder() {
  const configured = Array.isArray(database?.regionOrder)
    ? database.regionOrder
    : [];

  const additional = Object.keys(database?.regions || {})
    .filter((region) => !configured.includes(region))
    .sort();

  return [
    ...configured,
    ...DEFAULT_REGION_ORDER.filter((region) => !configured.includes(region)),
    ...additional,
  ].filter((region, index, values) => values.indexOf(region) === index);
}

function rebuild() {
  if (!database) return;

  renderStats();
  rebuildFilters();

  visibleServers = applyFilters(database.servers);
  renderRegions(visibleServers);
  renderLegacyServers(database.oldServers || []);
}

function renderStats() {
  const summary = database.summary || {};

  $("statAvailable").textContent = summary.regionAvailable ?? 0;
  $("statRegions").textContent = summary.regionTotal ?? 0;
  $("statPools").textContent = summary.poolCount ?? 0;
  $("statTunnels").textContent = summary.tunnelCount ?? 0;
  $("statNetwork").textContent =
    `${summary.networkInfoCount ?? 0}/${summary.uniqueIpCount ?? 0}`;

  $("statUpdated").textContent = database.generatedAt
    ? new Date(database.generatedAt).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

function rebuildFilters() {
  const previous = {
    region: $("regionFilter").value,
    pool: $("poolFilter").value,
  };

  const servers = database.servers || [];
  const presentRegions = new Set(servers.map((server) => server.region));
  const regions = getRegionOrder().filter(
    (region) => presentRegions.has(region) || database.regions?.[region],
  );
  const pools = [...new Set(servers.map((server) => server.pool))].sort(
    (left, right) => left.localeCompare(right, "ru", { numeric: true }),
  );

  $("regionFilter").innerHTML =
    `<option value="">Все регионы</option>` +
    regions.map((region) => {
      const label = database.regions?.[region]?.label || region;
      return `<option value="${escapeAttribute(region)}">${escapeHtml(label)}</option>`;
    }).join("");

  $("poolFilter").innerHTML =
    `<option value="">Все пулы</option>` +
    pools.map((pool) =>
      `<option value="${escapeAttribute(pool)}">${escapeHtml(pool)}</option>`
    ).join("");

  $("regionFilter").value = previous.region;
  $("poolFilter").value = previous.pool;
}

function applyFilters(servers) {
  const query = $("search").value.trim().toLowerCase();
  const region = $("regionFilter").value;
  const pool = $("poolFilter").value;

  return servers.filter((server) => {
    if (region && server.region !== region) return false;
    if (pool && server.pool !== pool) return false;
    if (!query) return true;

    return [
      server.region,
      server.regionLabel,
      server.pool,
      server.name,
      server.address,
      server.ip,
      server.port,
      server.asn,
      server.operator,
      server.city,
      server.administrativeRegion,
      server.country,
      server.countryCode,
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

  const hasActiveFilters =
    Boolean($("search").value.trim())
    || Boolean($("regionFilter").value)
    || Boolean($("poolFilter").value);

  const order = getRegionOrder();

  $("regionNav").innerHTML = order.map((region) => {
    const regionInfo = database.regions?.[region];
    const count = Object.values(grouped[region] || {}).flat().length;

    if (!regionInfo && !count) return "";

    return `
      <a href="#region-${escapeAttribute(region)}">
        ${escapeHtml(regionInfo?.label || region)} · ${count}
      </a>
    `;
  }).join("");

  const cards = [];

  for (const region of order) {
    const regionInfo = database.regions?.[region];
    const pools = grouped[region] || {};
    const regionServers = Object.values(pools).flat();

    if (!regionInfo && !regionServers.length) continue;

    if (hasActiveFilters && !regionServers.length) continue;

    const availability = regionInfo?.available !== false;
    const regionStatus = availability
      ? regionServers.length
        ? `${regionServers.length} серверов`
        : "Серверы не указаны"
      : "Данные временно недоступны";

    const body = availability && regionServers.length
      ? Object.entries(pools).map(([pool, poolServers]) => `
          <section class="pool">
            <div class="pool-head">
              <span class="pool-name">${escapeHtml(pool)}</span>
              <span class="pool-count">${poolServers.length} серверов</span>
            </div>

            <div class="table-wrap">
              <table>
                <colgroup><col><col><col><col><col><col></colgroup>
                <thead>
                  <tr>
                    <th>Сервер</th>
                    <th>Адрес</th>
                    <th>Пул</th>
                    <th>Порт</th>
                    <th>ASN / оператор</th>
                    <th>Город / страна</th>
                  </tr>
                </thead>
                <tbody>
                  ${poolServers.map(serverRow).join("")}
                </tbody>
              </table>
            </div>
          </section>
        `).join("")
      : `
          <div class="region-message">
            ${escapeHtml(
              availability
                ? "В текущем снимке адресов для этого региона нет."
                : "Последнее обновление не смогло получить данные этого региона.",
            )}
          </div>
        `;

    cards.push(`
      <section
        class="panel region-card ${availability ? "" : "unavailable"}"
        id="region-${escapeAttribute(region)}"
      >
        <div class="region-head">
          <div class="region-code">${escapeHtml(region)}</div>
          <div>
            <h2>${escapeHtml(regionInfo?.label || region)}</h2>
            <div class="region-meta">
              ${escapeHtml(regionStatus)}
              ${regionServers.length
                ? ` · ${new Set(regionServers.map((server) => server.ip)).size} IP · ${Object.keys(pools).length} пулов`
                : ""}
            </div>
          </div>
          <span class="chevron">⌄</span>
        </div>

        <div class="region-body">${body}</div>
      </section>
    `);
  }

  $("regions").innerHTML = cards.join("")
    || `<section class="panel empty">По заданным фильтрам ничего не найдено.</section>`;

  document.querySelectorAll(".region-head").forEach((header) => {
    header.addEventListener("click", () => {
      header.closest(".region-card").classList.toggle("open");
    });
  });

  bindCopyButtons($("regions"));
}

function serverRow(server) {
  const networkCell = server.asn || server.operator
    ? `
        <strong>${escapeHtml(server.asn || "—")}</strong>
        <div class="muted">${escapeHtml(server.operator || "—")}</div>
      `
    : `<span class="muted">—</span>`;

  const locationParts = [
    server.city,
    server.administrativeRegion && server.administrativeRegion !== server.city
      ? server.administrativeRegion
      : "",
  ].filter(Boolean);

  const locationCell = locationParts.length || server.country
    ? `
        <strong>${escapeHtml(locationParts.join(", ") || "—")}</strong>
        <div class="muted">${escapeHtml(server.country || "—")}</div>
      `
    : `<span class="muted">—</span>`;

  return `
    <tr>
      <td data-label="Сервер">
        <strong>${escapeHtml(server.name)}</strong>
        <div class="muted">${escapeHtml(server.region)}</div>
      </td>
      <td data-label="Адрес">
        <code>${escapeHtml(server.address)}</code>
        <button
          class="copy"
          data-copy="${escapeAttribute(server.address)}"
          type="button"
          aria-label="Копировать адрес"
        >⧉</button>
      </td>
      <td data-label="Пул">${escapeHtml(server.pool)}</td>
      <td data-label="Порт">${server.port ?? "—"}</td>
      <td data-label="ASN / оператор">${networkCell}</td>
      <td data-label="Город / страна">${locationCell}</td>
    </tr>
  `;
}


function renderLegacyServers(oldServers) {
  const container = $("legacyServers");
  if (!container) return;

  const servers = Array.isArray(oldServers) ? oldServers : [];
  const countLabel = `${servers.length} ${pluralizeServers(servers.length)}`;

  const rows = servers.length
    ? servers.map(legacyServerRow).join("")
    : `
        <tr>
          <td colspan="5" class="legacy-empty">
            Все известные исторические адреса сейчас присутствуют в актуальном списке.
          </td>
        </tr>
      `;

  container.innerHTML = `
    <details class="panel legacy-panel">
      <summary class="legacy-summary">
        <span class="legacy-title">Старые серверы</span>
        <span class="legacy-count">${escapeHtml(countLabel)}</span>
        <span class="legacy-chevron" aria-hidden="true">⌄</span>
      </summary>

      <div class="legacy-content">
        <p class="legacy-note">
          Исторические адреса, которых нет в последнем актуальном списке. Если сервер снова появляется, он автоматически удаляется из этого раздела.
        </p>

        <div class="table-wrap">
          <table class="legacy-table">
            <colgroup><col><col><col><col><col></colgroup>
            <thead>
              <tr>
                <th>Сервер</th>
                <th>Адрес</th>
                <th>Регион / пул</th>
                <th>ASN / оператор</th>
                <th>Город / страна</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;

  bindCopyButtons(container);
}

function legacyServerRow(server) {
  const networkCell = server.asn || server.operator
    ? `
        <strong>${escapeHtml(server.asn || "—")}</strong>
        <div class="muted">${escapeHtml(server.operator || "—")}</div>
      `
    : `<span class="muted">—</span>`;

  const locationParts = [
    server.city,
    server.administrativeRegion && server.administrativeRegion !== server.city
      ? server.administrativeRegion
      : "",
  ].filter(Boolean);

  const locationCell = locationParts.length || server.country
    ? `
        <strong>${escapeHtml(locationParts.join(", ") || "—")}</strong>
        <div class="muted">${escapeHtml(server.country || "—")}</div>
      `
    : `<span class="muted">—</span>`;

  return `
    <tr>
      <td data-label="Сервер"><strong>${escapeHtml(server.name)}</strong></td>
      <td data-label="Адрес">
        <code>${escapeHtml(server.address)}</code>
        <button
          class="copy"
          data-copy="${escapeAttribute(server.address)}"
          type="button"
          aria-label="Копировать адрес"
        >⧉</button>
      </td>
      <td data-label="Регион / пул">
        <strong>${escapeHtml(server.region || "—")}</strong>
        <div class="muted">${escapeHtml(server.pool || "—")}</div>
      </td>
      <td data-label="ASN / оператор">${networkCell}</td>
      <td data-label="Город / страна">${locationCell}</td>
    </tr>
  `;
}

function pluralizeServers(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) return "сервер";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "сервера";
  }
  return "серверов";
}

function bindCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((button) => {
    if (button.dataset.copyBound === "true") return;
    button.dataset.copyBound = "true";

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      copyText(button.dataset.copy, "Адрес скопирован");
    });
  });
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
    "server_directory.json",
    JSON.stringify(database, null, 2),
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
    "pool",
    "server",
    "ip",
    "port",
    "address",
    "asn",
    "operator",
    "city",
    "administrative_region",
    "country",
  ].join(",")];

  for (const server of database.servers) {
    lines.push([
      server.region,
      server.pool,
      server.name,
      server.ip,
      server.port,
      server.address,
      server.asn,
      server.operator,
      server.city,
      server.administrativeRegion,
      server.country,
    ].map(csvEscape).join(","));
  }

  download(
    "server_directory.csv",
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
$("exportJsonBtn").addEventListener("click", exportJson);
$("exportCsvBtn").addEventListener("click", exportCsv);

$("copyVisibleBtn").addEventListener("click", () => {
  const ips = [
    ...new Set(visibleServers.map((server) => server.ip).filter(Boolean)),
  ];

  if (!ips.length) {
    toast("Нет IP");
    return;
  }

  copyText(ips.join("\n"), `Скопировано IP: ${ips.length}`);
});

["search", "regionFilter", "poolFilter"].forEach((id) => {
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    if (!database) return;

    visibleServers = applyFilters(database.servers);
    renderRegions(visibleServers);
  });
});

loadDatabase();

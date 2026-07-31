import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const execFileAsync = promisify(execFile);

const REGION_ORDER = ["RU", "EU", "NA", "SEA", "NEA"];

const SOURCES = [
  {
    region: "RU",
    label: "Россия",
    urls: [
      "https://backend.stalcraftx.ru/address_list?login=Hi",
      "http://backend.stalcraftx.ru/address_list?login=Hi",
    ],
    allowInsecureTls: true,
  },
  {
    region: "EU",
    label: "Европа",
    url: "https://backend-eu.stalzone.com/address_list?login=Hi",
    allowInsecureTls: true,
  },
  {
    region: "NA",
    label: "Америка",
    url: "https://backend-na.stalzone.com/address_list?login=Hi",
    allowInsecureTls: true,
  },
  {
    region: "SEA",
    label: "Юго-Восточная Азия",
    url: "https://backend-sea.stalzone.com/address_list?login=Hi",
    allowInsecureTls: true,
  },
  {
    region: "NEA",
    label: "Северо-Восточная Азия",
    url: "https://backend-nea.stalzone.com/address_list?login=Hi",
    allowInsecureTls: true,
  },
];

const OUTPUT_FILE = resolve("public/data/servers.json");
const IP_CACHE_FILE = resolve("public/data/ip-cache.json");
const LEGACY_FILE = resolve("scripts/legacy-servers.json");
const REGION_FALLBACK_FILE = resolve("scripts/region-fallbacks.json");

const SOURCE_TIMEOUT_MS = 20_000;
const SOURCE_CURL_MAX_TIME_SECONDS = 25;
const SOURCE_CURL_RETRY_MAX_TIME_SECONDS = 55;
const SOURCE_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/126.0 Safari/537.36 StalzoneServerlist/6.6";
const MAX_SOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 6_000;
const IP_LOOKUP_BUDGET_MS = 60_000;
const IP_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const IP_LOOKUP_CONCURRENCY = 8;

function splitAddress(address) {
  const value = String(address ?? "").trim();

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 0) {
      const ip = value.slice(1, end);
      const port = Number(value.slice(end + 2));
      return { ip, port: Number.isFinite(port) ? port : null };
    }
  }

  const separator = value.lastIndexOf(":");
  if (separator < 0) {
    return { ip: value, port: null };
  }

  const ip = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));

  return {
    ip,
    port: Number.isFinite(port) ? port : null,
  };
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseRegionPayload(source, text) {
  if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_RESPONSE_BYTES) {
    throw new Error(
      `Ответ превышает допустимый размер `
        + `${MAX_SOURCE_RESPONSE_BYTES} байт`,
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Получен ответ не в формате JSON; первые символы: `
        + `${String(text).slice(0, 100).replace(/\s+/g, " ")}`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Корневое значение ответа должно быть объектом");
  }

  if (data.mode !== "roxy") {
    throw new Error(`Неожиданное значение mode: ${String(data.mode)}`);
  }

  if (!Array.isArray(data.pools) || data.pools.length === 0) {
    throw new Error("Ответ не содержит непустой pools[]");
  }

  let tunnelCount = 0;

  const pools = data.pools.map((pool, poolIndex) => {
    const poolName = String(pool?.name ?? "").trim();

    if (!poolName) {
      throw new Error(`У пула #${poolIndex + 1} отсутствует name`);
    }

    if (!Array.isArray(pool?.tunnels)) {
      throw new Error(`Пул ${poolName} не содержит tunnels[]`);
    }

    const tunnels = pool.tunnels.map((tunnel, tunnelIndex) => {
      const name = String(tunnel?.name ?? "").trim();
      const address = String(tunnel?.address ?? "").trim();
      const { ip, port } = splitAddress(address);

      if (!name) {
        throw new Error(
          `У туннеля #${tunnelIndex + 1} в пуле ${poolName} `
            + `отсутствует name`,
        );
      }

      if (!isIP(ip)) {
        throw new Error(
          `Некорректный IP у ${name}: ${address || "(пусто)"}`,
        );
      }

      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`Некорректный порт у ${name}: ${address}`);
      }

      tunnelCount += 1;

      return {
        name,
        address,
        ip,
        port,
      };
    });

    return {
      name: poolName,
      tunnels,
    };
  });

  if (tunnelCount === 0) {
    throw new Error("Ответ не содержит ни одного туннеля");
  }

  if (
    data.clientToTunnelRttWeight !== undefined
    && !Number.isFinite(Number(data.clientToTunnelRttWeight))
  ) {
    throw new Error("Некорректное значение clientToTunnelRttWeight");
  }

  return {
    region: source.region,
    label: source.label,
    available: true,
    fresh: true,
    error: null,
    fallbackSource: null,
    dataGeneratedAt: new Date().toISOString(),
    pools,
  };
}

function formatSourceError(error) {
  const code = error?.cause?.code || error?.code;
  const stderr = String(error?.stderr ?? "").trim();
  const message = String(error?.message ?? error).trim();

  return [message, code ? `code=${code}` : "", stderr]
    .filter(Boolean)
    .join("; ")
    .slice(0, 600);
}

async function logDnsDiagnostics(source) {
  const primaryUrl = source.urls?.[0] ?? source.url;
  const hostname = new URL(primaryUrl).hostname;

  try {
    const records = await lookup(hostname, {
      all: true,
      order: "ipv4first",
    });
    console.log(
      `[DNS] ${source.region} ${hostname}: `
        + records.map((record) => `${record.address}/IPv${record.family}`).join(", "),
    );
  } catch (error) {
    console.warn(
      `[DNS ERROR] ${source.region} ${hostname}: ${formatSourceError(error)}`,
    );
  }
}

async function fetchSourceWithCurl(source, url, options = {}) {
  const protocol = new URL(url).protocol;
  const allowedProtocol = protocol === "https:" ? "=https" : "=http";

  const args = [
    "--ipv4",
    ...(options.insecureTls ? ["--insecure"] : []),
    "--silent",
    "--show-error",
    "--fail-with-body",
    "--proto",
    allowedProtocol,
    "--connect-timeout",
    "10",
    "--max-time",
    String(SOURCE_CURL_MAX_TIME_SECONDS),
    "--retry",
    "3",
    "--retry-delay",
    "2",
    "--retry-all-errors",
    "--retry-max-time",
    String(SOURCE_CURL_RETRY_MAX_TIME_SECONDS),
    "--header",
    "Accept: application/json",
    "--header",
    "Cache-Control: no-cache",
    "--header",
    "Connection: close",
    "--header",
    `User-Agent: ${SOURCE_USER_AGENT}`,
    url,
  ];

  const { stdout } = await execFileAsync("curl", args, {
    encoding: "utf8",
    maxBuffer: MAX_SOURCE_RESPONSE_BYTES,
  });

  return stdout;
}

async function fetchSourceWithNode(source, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
        "Connection": "close",
        "User-Agent": SOURCE_USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new Error(
        `HTTP redirect ${response.status} `
          + `to ${response.headers.get("location") || "(unknown)"}`,
      );
    }

    const text = await response.text();

    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_RESPONSE_BYTES) {
      throw new Error("Ответ превышает допустимый размер");
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText || ""}`.trim(),
      );
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function previousRegionPools(previousPayload, regionCode) {
  const grouped = new Map();

  for (const server of previousPayload?.servers || []) {
    if (server.region !== regionCode) continue;

    if (!grouped.has(server.pool)) {
      grouped.set(server.pool, []);
    }

    grouped.get(server.pool).push({
      name: server.name,
      address: server.address,
      ip: server.ip,
      port: server.port,
    });
  }

  return [...grouped.entries()].map(([name, tunnels]) => ({
    name,
    tunnels,
  }));
}

async function fetchRegion(source, previousPayload, bundledFallbacks) {
  await logDnsDiagnostics(source);

  const errors = [];

  const candidateUrls = source.urls ?? [source.url];
  const attempts = [];

  for (const url of candidateUrls) {
    const protocol = new URL(url).protocol;
    const transportName = protocol === "https:" ? "HTTPS" : "HTTP";

    attempts.push({
      name: `${transportName} curl/IPv4`,
      url,
      method: fetchSourceWithCurl,
      options: {},
    });

    attempts.push({
      name: `${transportName} Node fetch`,
      url,
      method: fetchSourceWithNode,
      options: {},
    });

    if (
      protocol === "https:"
      && source.allowInsecureTls === true
    ) {
      attempts.push({
        name: "HTTPS curl/IPv4 without certificate verification",
        url,
        method: fetchSourceWithCurl,
        options: { insecureTls: true },
      });
    }
  }

  for (const attempt of attempts) {
    try {
      console.log(`[SOURCE] ${source.region}: trying ${attempt.name}.`);
      const text = await attempt.method(
        source,
        attempt.url,
        attempt.options,
      );
      const result = parseRegionPayload(source, text);
      const tunnelCount = result.pools.reduce(
        (sum, pool) => sum + pool.tunnels.length,
        0,
      );

      const protocol = new URL(attempt.url).protocol;

      if (attempt.options.insecureTls) {
        console.warn(
          `[SOURCE WARNING] ${source.region}: accepted HTTPS data `
            + `without validating the server certificate for the configured `
            + `server-list backend. The JSON structure and every IP/port `
            + `were validated.`,
        );
      } else if (protocol === "http:") {
        console.warn(
          `[SOURCE WARNING] ${source.region}: HTTPS failed; `
            + `accepted a strictly validated HTTP response.`,
        );
      }

      console.log(
        `[SOURCE OK] ${source.region} via ${attempt.name}: `
          + `${result.pools.length} pools, ${tunnelCount} tunnels.`,
      );
      return result;
    } catch (error) {
      const detail = formatSourceError(error);
      errors.push(`${attempt.name}: ${detail}`);
      console.error(
        `[SOURCE ERROR] ${source.region} ${attempt.name}: ${detail}`,
      );
    }
  }

  const previousPools = previousRegionPools(previousPayload, source.region);
  const bundledRegion = bundledFallbacks?.regions?.[source.region];
  const bundledPools = Array.isArray(bundledRegion?.pools)
    ? bundledRegion.pools.map((pool) => ({
        name: String(pool?.name ?? ""),
        tunnels: Array.isArray(pool?.tunnels)
          ? pool.tunnels.map((tunnel) => {
              const address = String(tunnel?.address ?? "");
              const { ip, port } = splitAddress(address);
              return {
                name: String(tunnel?.name ?? ""),
                address,
                ip,
                port,
              };
            })
          : [],
      }))
    : [];

  const pools = previousPools.length ? previousPools : bundledPools;
  const fallbackSource = previousPools.length
    ? "previous_snapshot"
    : bundledPools.length
      ? "bundled_snapshot"
      : null;
  const dataGeneratedAt = previousPools.length
    ? previousPayload?.generatedAt || null
    : bundledPools.length
      ? bundledFallbacks?.generatedAt || null
      : null;

  if (pools.length) {
    console.warn(
      `[SOURCE FALLBACK] ${source.region}: using ${fallbackSource}; `
        + `${pools.reduce((sum, pool) => sum + pool.tunnels.length, 0)} tunnels.`,
    );

    return {
      region: source.region,
      label: source.label,
      available: true,
      fresh: false,
      error: errors.join(" | "),
      fallbackSource,
      dataGeneratedAt,
      pools,
    };
  }

  return {
    region: source.region,
    label: source.label,
    available: false,
    fresh: false,
    error: errors.join(" | "),
    fallbackSource: null,
    dataGeneratedAt: null,
    pools: [],
  };
}

function flattenServers(regionResults) {
  const servers = [];

  for (const region of regionResults) {
    for (const pool of region.pools) {
      for (const tunnel of pool.tunnels) {
        servers.push({
          region: region.region,
          regionLabel: region.label,
          pool: pool.name,
          name: tunnel.name,
          address: tunnel.address,
          ip: tunnel.ip,
          port: tunnel.port,
        });
      }
    }
  }

  return servers;
}

function isFreshCacheEntry(entry) {
  if (!entry?.updatedAt) return false;

  const timestamp = Date.parse(entry.updatedAt);
  return Number.isFinite(timestamp)
    && Date.now() - timestamp < IP_CACHE_MAX_AGE_MS;
}

function normalizeNetworkData(data) {
  const asnNumber = data?.connection?.asn;
  const asn = asnNumber
    ? String(asnNumber).toUpperCase().startsWith("AS")
      ? String(asnNumber).toUpperCase()
      : `AS${asnNumber}`
    : "";

  return {
    asn,
    operator:
      String(data?.connection?.org ?? "").trim()
      || String(data?.connection?.isp ?? "").trim(),
    city: String(data?.city ?? "").trim(),
    region: String(data?.region ?? "").trim(),
    country: String(data?.country ?? "").trim(),
    countryCode: String(data?.country_code ?? "").trim(),
    updatedAt: new Date().toISOString(),
  };
}

async function lookupIp(ip) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://ipwho.is/${encodeURIComponent(ip)}?lang=ru`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Stalzone-Serverlist-GitHub-Pages/3.0",
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data?.success === false) {
      throw new Error(data?.message || "IP lookup failed");
    }

    return normalizeNetworkData(data);
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichIpCache(ips, oldCache) {
  const cache = { ...oldCache };
  const missingOrStale = ips.filter((ip) => !isFreshCacheEntry(cache[ip]));

  if (!missingOrStale.length) {
    console.log(`IP metadata: all ${ips.length} addresses loaded from cache.`);
    return {
      cache,
      requested: 0,
      succeeded: 0,
      deferred: 0,
      deadlineReached: false,
    };
  }

  console.log(
    `IP metadata: ${missingOrStale.length} new or stale addresses, `
      + `${ips.length - missingOrStale.length} cached.`,
  );
  console.log(
    `IP metadata budget: ${IP_LOOKUP_BUDGET_MS / 1000}s, `
      + `${IP_LOOKUP_CONCURRENCY} parallel workers, `
      + `${LOOKUP_TIMEOUT_MS / 1000}s per request.`,
  );

  const startedAt = Date.now();
  let cursor = 0;
  let requested = 0;
  let succeeded = 0;
  let deadlineReached = false;

  async function worker() {
    while (cursor < missingOrStale.length) {
      if (Date.now() - startedAt >= IP_LOOKUP_BUDGET_MS) {
        deadlineReached = true;
        return;
      }

      const ip = missingOrStale[cursor++];
      requested += 1;

      try {
        cache[ip] = await lookupIp(ip);
        succeeded += 1;

        if (
          succeeded <= 5
          || succeeded % 10 === 0
          || cursor >= missingOrStale.length
        ) {
          console.log(
            `[IP progress] ${cursor}/${missingOrStale.length}; `
              + `${succeeded} successful.`,
          );
        }
      } catch (error) {
        console.error(`[IP ERROR] ${ip}: ${error?.message ?? error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(IP_LOOKUP_CONCURRENCY, missingOrStale.length) },
      () => worker(),
    ),
  );

  const deferred = Math.max(0, missingOrStale.length - requested);

  if (deadlineReached || deferred > 0) {
    console.warn(
      `IP metadata time budget reached. Deferred ${deferred} addresses `
        + `until the next scheduled run.`,
    );
  }

  return {
    cache,
    requested,
    succeeded,
    deferred,
    deadlineReached,
  };
}

function attachNetworkData(servers, cache) {
  return servers.map((server) => {
    const network = cache[server.ip] || {};

    return {
      ...server,
      asn: network.asn || "",
      operator: network.operator || "",
      city: network.city || "",
      administrativeRegion: network.region || "",
      country: network.country || "",
      countryCode: network.countryCode || "",
    };
  });
}

function normalizeText(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeAddress(value) {
  return String(value ?? "").trim().toLowerCase();
}

function legacyIdentity(server) {
  return `${normalizeText(server.region)}|${normalizeText(server.name)}|${normalizeAddress(server.address)}`;
}

function buildOldServers({ archive, servers, regionResults, previousOldServers }) {
  const availableRegions = new Set(
    regionResults
      .filter((region) => region.fresh)
      .map((region) => region.region),
  );

  const liveAddresses = new Set(
    servers.map((server) => normalizeAddress(server.address)).filter(Boolean),
  );
  const liveNames = new Set(
    servers.map(
      (server) => `${normalizeText(server.region)}|${normalizeText(server.name)}`,
    ),
  );
  const previousOldKeys = new Set(
    (previousOldServers || []).map(legacyIdentity),
  );

  const oldServers = [];
  let matchedLiveCount = 0;
  let deferredCount = 0;

  for (const archived of archive) {
    const region = normalizeText(archived.region);
    const addressMatch = liveAddresses.has(normalizeAddress(archived.address));
    const nameMatch = liveNames.has(
      `${region}|${normalizeText(archived.name)}`,
    );

    if (availableRegions.has(region)) {
      if (addressMatch || nameMatch) {
        matchedLiveCount += 1;
        continue;
      }

      oldServers.push({ ...archived });
      continue;
    }

    // При недоступном регионе сохраняем результат прошлого успешного сравнения.
    if (previousOldKeys.has(legacyIdentity(archived))) {
      oldServers.push({ ...archived });
    } else {
      deferredCount += 1;
    }
  }

  oldServers.sort((left, right) => {
    const regionDifference =
      REGION_ORDER.indexOf(left.region) - REGION_ORDER.indexOf(right.region);

    if (regionDifference !== 0) return regionDifference;

    return (
      left.pool.localeCompare(right.pool, "ru")
      || left.name.localeCompare(right.name, "ru", { numeric: true })
      || left.address.localeCompare(right.address, "ru", { numeric: true })
    );
  });

  return {
    oldServers,
    matchedLiveCount,
    deferredCount,
  };
}

function mergeOldServerNetworkData(oldServers, cache) {
  return oldServers.map((server) => {
    const network = cache[server.ip] || {};

    return {
      ...server,
      asn: server.asn || network.asn || "",
      operator: server.operator || network.operator || "",
      city: server.city || network.city || "",
      administrativeRegion: network.region || "",
      country: server.country || network.country || "",
      countryCode: network.countryCode || "",
    };
  });
}

function buildRegions(regionResults, servers) {
  const regions = {};

  for (const regionCode of REGION_ORDER) {
    const source = regionResults.find((item) => item.region === regionCode);
    const regionServers = servers.filter(
      (server) => server.region === regionCode,
    );

    regions[regionCode] = {
      code: regionCode,
      label: source?.label || regionCode,
      available: source?.available ?? false,
      fresh: source?.fresh ?? false,
      stale: Boolean(source?.available && !source?.fresh),
      error: source?.error || null,
      fallbackSource: source?.fallbackSource || null,
      dataGeneratedAt: source?.dataGeneratedAt || null,
      poolCount: source?.pools?.length || 0,
      tunnelCount: regionServers.length,
      uniqueIpCount: new Set(
        regionServers.map((server) => server.ip).filter(Boolean),
      ).size,
    };
  }

  return regions;
}

async function main() {
  const generatedAt = new Date().toISOString();

  console.log("Starting server snapshot build...");
  console.log("Phase 1/4: fetching current regional server lists.");

  const [legacyData, previousPayload, bundledFallbacks] = await Promise.all([
    readJsonFile(LEGACY_FILE, { servers: [] }),
    readJsonFile(OUTPUT_FILE, { servers: [], oldServers: [] }),
    readJsonFile(REGION_FALLBACK_FILE, { regions: {} }),
  ]);

  const regionResults = await Promise.all(
    SOURCES.map((source) =>
      fetchRegion(source, previousPayload, bundledFallbacks)
    ),
  );
  const availableRegions = regionResults.filter((region) => region.available);
  const freshRegions = regionResults.filter((region) => region.fresh);
  const staleRegions = regionResults.filter(
    (region) => region.available && !region.fresh,
  );

  for (const region of regionResults) {
    if (region.available) {
      const tunnelCount = region.pools.reduce(
        (sum, pool) => sum + pool.tunnels.length,
        0,
      );
      const state = region.fresh ? "fresh" : `fallback:${region.fallbackSource}`;
      console.log(
        `[OK] ${region.region}: ${region.pools.length} pools, `
          + `${tunnelCount} tunnels, ${state}`,
      );
    } else {
      console.error(`[ERROR] ${region.region}: ${region.error}`);
    }
  }

  if (!availableRegions.length) {
    throw new Error(
      "Все региональные источники недоступны; публикация отменена.",
    );
  }

  console.log("Phase 2/4: preparing current server list.");

  const rawServers = flattenServers(regionResults);
  const uniqueIps = [
    ...new Set(rawServers.map((server) => server.ip).filter(Boolean)),
  ];

  console.log("Phase 3/4: updating ASN and IP location cache.");
  const previousCache = await readJsonFile(IP_CACHE_FILE, {});
  const enrichment = await enrichIpCache(uniqueIps, previousCache);

  await mkdir(dirname(IP_CACHE_FILE), { recursive: true });
  await writeFile(
    IP_CACHE_FILE,
    `${JSON.stringify(enrichment.cache, null, 2)}\n`,
    "utf8",
  );

  const servers = attachNetworkData(rawServers, enrichment.cache).sort(
    (left, right) => {
      const regionDifference =
        REGION_ORDER.indexOf(left.region) - REGION_ORDER.indexOf(right.region);

      if (regionDifference !== 0) return regionDifference;

      return (
        left.pool.localeCompare(right.pool, "ru")
        || left.name.localeCompare(right.name, "ru", { numeric: true })
        || left.address.localeCompare(right.address, "ru", { numeric: true })
      );
    },
  );

  console.log("Phase 4/4: comparing the historical archive.");

  const legacyComparison = buildOldServers({
    archive: Array.isArray(legacyData.servers) ? legacyData.servers : [],
    servers,
    regionResults,
    previousOldServers: previousPayload.oldServers,
  });
  const oldServers = mergeOldServerNetworkData(
    legacyComparison.oldServers,
    enrichment.cache,
  );

  const payload = {
    schemaVersion: 3,
    generatedAt,
    complete: freshRegions.length === SOURCES.length,
    regionOrder: REGION_ORDER,
    summary: {
      regionTotal: SOURCES.length,
      regionAvailable: availableRegions.length,
      regionFresh: freshRegions.length,
      regionStale: staleRegions.length,
      regionUnavailable: SOURCES.length - availableRegions.length,
      poolCount: regionResults.reduce(
        (sum, region) => sum + region.pools.length,
        0,
      ),
      tunnelCount: servers.length,
      uniqueIpCount: new Set(
        servers.map((server) => server.ip).filter(Boolean),
      ).size,
      networkInfoCount: new Set(
        servers
          .filter(
            (server) =>
              server.asn
              || server.operator
              || server.city
              || server.country,
          )
          .map((server) => server.ip),
      ).size,
      historicalArchiveCount: Array.isArray(legacyData.servers)
        ? legacyData.servers.length
        : 0,
      oldServerCount: oldServers.length,
      historicalServersLiveNow: legacyComparison.matchedLiveCount,
      historicalComparisonDeferred: legacyComparison.deferredCount,
    },
    regions: buildRegions(regionResults, servers),
    servers,
    oldServers,
    legacyComparisonPending: false,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${OUTPUT_FILE}: ${servers.length} live tunnels, `
      + `${oldServers.length} old servers, `
      + `${legacyComparison.matchedLiveCount} historical entries live now.`,
  );
  console.log(
    `IP API calls: ${enrichment.requested}; succeeded: ${enrichment.succeeded}; deferred: ${enrichment.deferred}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REGION_ORDER = ["RU", "EU", "NA", "SEA", "NEA"];

const SOURCES = [
  {
    region: "RU",
    label: "Россия",
    url: "https://backend.stalcraftx.ru/address_list?login=Hi",
  },
  {
    region: "EU",
    label: "Европа",
    url: "https://backend-eu.stalzone.com/address_list?login=Hi",
  },
  {
    region: "NA",
    label: "Америка",
    url: "https://backend-na.stalzone.com/address_list?login=Hi",
  },
  {
    region: "SEA",
    label: "Юго-Восточная Азия",
    url: "https://backend-sea.stalzone.com/address_list?login=Hi",
  },
  {
    region: "NEA",
    label: "Северо-Восточная Азия",
    url: "https://backend-nea.stalzone.com/address_list?login=Hi",
  },
];

const OUTPUT_FILE = resolve("public/data/servers.json");
const IP_CACHE_FILE = resolve("public/data/ip-cache.json");

const SOURCE_TIMEOUT_MS = 25_000;
const LOOKUP_TIMEOUT_MS = 15_000;
const IP_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const IP_LOOKUP_CONCURRENCY = 4;

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

async function fetchRegion(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);

  try {
    const separator = source.url.includes("?") ? "&" : "?";
    const response = await fetch(`${source.url}${separator}_ts=${Date.now()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Server-Directory-GitHub-Pages/2.0",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText || ""}`.trim(),
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("Получен ответ не в формате JSON");
    }

    if (!data || !Array.isArray(data.pools)) {
      throw new Error("Ответ не содержит pools[]");
    }

    const pools = data.pools.map((pool) => ({
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
    }));

    return {
      region: source.region,
      label: source.label,
      available: true,
      error: null,
      pools,
    };
  } catch (error) {
    return {
      region: source.region,
      label: source.label,
      available: false,
      error:
        error?.name === "AbortError"
          ? `Превышено время ожидания ${SOURCE_TIMEOUT_MS / 1000} сек.`
          : String(error?.message ?? error),
      pools: [],
    };
  } finally {
    clearTimeout(timeout);
  }
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
          "User-Agent": "Server-Directory-GitHub-Pages/2.0",
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
    return { cache, queried: 0, succeeded: 0 };
  }

  console.log(
    `IP metadata: ${missingOrStale.length} new or stale addresses, `
      + `${ips.length - missingOrStale.length} cached.`,
  );

  let cursor = 0;
  let succeeded = 0;

  async function worker() {
    while (cursor < missingOrStale.length) {
      const ip = missingOrStale[cursor++];

      try {
        cache[ip] = await lookupIp(ip);
        succeeded += 1;
        console.log(`[IP OK] ${ip}: ${cache[ip].asn} ${cache[ip].operator}`);
      } catch (error) {
        console.error(`[IP ERROR] ${ip}: ${error?.message ?? error}`);
        // Если старая запись существует, оставляем её в кэше.
      }

      // Небольшая пауза снижает пиковую нагрузку на бесплатный API.
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(IP_LOOKUP_CONCURRENCY, missingOrStale.length) },
      () => worker(),
    ),
  );

  return {
    cache,
    queried: missingOrStale.length,
    succeeded,
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
      error: source?.error || null,
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

  const regionResults = await Promise.all(SOURCES.map(fetchRegion));
  const availableRegions = regionResults.filter((region) => region.available);

  for (const region of regionResults) {
    if (region.available) {
      const tunnelCount = region.pools.reduce(
        (sum, pool) => sum + pool.tunnels.length,
        0,
      );
      console.log(
        `[OK] ${region.region}: ${region.pools.length} pools, `
          + `${tunnelCount} tunnels`,
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

  const rawServers = flattenServers(regionResults);
  const uniqueIps = [
    ...new Set(rawServers.map((server) => server.ip).filter(Boolean)),
  ];

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

  const payload = {
    schemaVersion: 2,
    generatedAt,
    complete: availableRegions.length === SOURCES.length,
    regionOrder: REGION_ORDER,
    summary: {
      regionTotal: SOURCES.length,
      regionAvailable: availableRegions.length,
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
    },
    regions: buildRegions(regionResults, servers),
    servers,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(
    OUTPUT_FILE,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );

  console.log(
    `Wrote ${OUTPUT_FILE}: ${servers.length} tunnels, `
      + `${payload.summary.uniqueIpCount} unique IPs, `
      + `${payload.summary.networkInfoCount} IPs with network metadata.`,
  );
  console.log(
    `IP API calls: ${enrichment.queried}; succeeded: ${enrichment.succeeded}.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

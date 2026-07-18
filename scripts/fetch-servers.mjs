import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ENDPOINTS = [
  {
    id: "EU",
    region: "EU",
    label: "Европа",
    url: "https://backend-eu.stalzone.com/address_list?login=Hi",
  },
  {
    id: "NA",
    region: "NA",
    label: "Северная Америка",
    url: "https://backend-na.stalzone.com/address_list?login=Hi",
  },
  {
    id: "SEA",
    region: "SEA",
    label: "Юго-Восточная Азия",
    url: "https://backend-sea.stalzone.com/address_list?login=Hi",
  },
  {
    id: "NEA",
    region: "NEA",
    label: "Северо-Восточная Азия",
    url: "https://backend-nea.stalzone.com/address_list?login=Hi",
  },
  {
    id: "RU",
    region: "RU",
    label: "Россия",
    url: "https://backend.stalcraftx.ru/address_list?login=Hi",
  },
];

const OUTPUT_FILE = resolve("public/data/servers.json");
const TIMEOUT_MS = 25_000;

function splitAddress(address) {
  const value = String(address ?? "").trim();

  // Формат endpoint сейчас IPv4:port. Поддерживаем также [IPv6]:port.
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
  return { ip, port: Number.isFinite(port) ? port : null };
}

async function fetchEndpoint(endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const separator = endpoint.url.includes("?") ? "&" : "?";
    const response = await fetch(`${endpoint.url}${separator}_ts=${Date.now()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "STALZONE-GitHub-Pages/1.0",
      },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") ?? "";
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
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 120);
      throw new Error(
        `Response is not JSON (${contentType || "content-type unavailable"})` +
          (preview ? `: ${preview}` : ""),
      );
    }

    if (!data || !Array.isArray(data.pools)) {
      throw new Error("JSON response does not contain pools[]");
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
      ...endpoint,
      ok: true,
      status: response.status,
      contentType,
      durationMs: Date.now() - startedAt,
      mode: data.mode ?? null,
      clientToTunnelRttWeight: data.clientToTunnelRttWeight ?? null,
      pools,
      error: null,
    };
  } catch (error) {
    const message =
      error?.name === "AbortError"
        ? `Timeout after ${TIMEOUT_MS / 1000}s`
        : String(error?.message ?? error);

    return {
      ...endpoint,
      ok: false,
      status: null,
      contentType: null,
      durationMs: Date.now() - startedAt,
      mode: null,
      clientToTunnelRttWeight: null,
      pools: [],
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function flattenServers(endpointResults) {
  const servers = [];

  for (const endpoint of endpointResults) {
    if (!endpoint.ok) continue;

    for (const pool of endpoint.pools) {
      for (const tunnel of pool.tunnels) {
        servers.push({
          region: endpoint.region,
          regionLabel: endpoint.label,
          endpointId: endpoint.id,
          endpoint: endpoint.url,
          mode: endpoint.mode,
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

function buildRegionSummary(endpointResults, servers) {
  const regions = {};

  for (const endpoint of endpointResults) {
    const regionServers = servers.filter(
      (server) => server.endpointId === endpoint.id,
    );

    regions[endpoint.region] = {
      code: endpoint.region,
      label: endpoint.label,
      endpointId: endpoint.id,
      endpoint: endpoint.url,
      ok: endpoint.ok,
      error: endpoint.error,
      mode: endpoint.mode,
      clientToTunnelRttWeight: endpoint.clientToTunnelRttWeight,
      poolCount: endpoint.pools.length,
      tunnelCount: regionServers.length,
      uniqueIpCount: new Set(regionServers.map((server) => server.ip)).size,
      pools: endpoint.pools,
    };
  }

  return regions;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const endpointResults = await Promise.all(ENDPOINTS.map(fetchEndpoint));
  const successfulEndpoints = endpointResults.filter((endpoint) => endpoint.ok);

  for (const endpoint of endpointResults) {
    if (endpoint.ok) {
      const tunnelCount = endpoint.pools.reduce(
        (total, pool) => total + pool.tunnels.length,
        0,
      );
      console.log(
        `[OK] ${endpoint.id}: ${endpoint.pools.length} pools, ` +
          `${tunnelCount} tunnels, ${endpoint.durationMs} ms`,
      );
    } else {
      console.error(`[ERROR] ${endpoint.id}: ${endpoint.error}`);
    }
  }

  // При полном сетевом сбое не публикуем пустой сайт поверх предыдущего деплоя.
  if (successfulEndpoints.length === 0) {
    throw new Error("All STALZONE endpoints failed; deployment cancelled.");
  }

  const servers = flattenServers(endpointResults);
  const uniqueIps = new Set(
    servers.map((server) => server.ip).filter(Boolean),
  );

  const payload = {
    schemaVersion: 1,
    generatedAt,
    loginParameter: "Hi",
    complete: successfulEndpoints.length === ENDPOINTS.length,
    summary: {
      endpointTotal: ENDPOINTS.length,
      endpointOnline: successfulEndpoints.length,
      endpointFailed: ENDPOINTS.length - successfulEndpoints.length,
      regionCount: new Set(servers.map((server) => server.region)).size,
      poolCount: endpointResults.reduce(
        (total, endpoint) => total + endpoint.pools.length,
        0,
      ),
      tunnelCount: servers.length,
      uniqueIpCount: uniqueIps.size,
    },
    endpoints: endpointResults.map((endpoint) => ({
      id: endpoint.id,
      region: endpoint.region,
      label: endpoint.label,
      url: endpoint.url,
      ok: endpoint.ok,
      status: endpoint.status,
      contentType: endpoint.contentType,
      durationMs: endpoint.durationMs,
      error: endpoint.error,
      mode: endpoint.mode,
      clientToTunnelRttWeight: endpoint.clientToTunnelRttWeight,
      poolCount: endpoint.pools.length,
      tunnelCount: endpoint.pools.reduce(
        (total, pool) => total + pool.tunnels.length,
        0,
      ),
    })),
    regions: buildRegionSummary(endpointResults, servers),
    servers,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(
    `Wrote ${OUTPUT_FILE}: ${servers.length} tunnels, ${uniqueIps.size} unique IPs.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

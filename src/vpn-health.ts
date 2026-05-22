export interface VpnHealthProbeResult {
  ok: boolean;
  reachable: boolean;
  checkedAt: string;
  healthUrl: string;
  httpStatus?: number;
  error?: string;
}

const DEFAULT_VPN_HEALTH_URL = "http://10.16.0.1:8002/health";
const DEFAULT_VPN_HEALTH_TIMEOUT_MS = 5000;

export function getVpnHealthUrl(): string {
  return process.env.VPN_HEALTH_URL?.trim() || DEFAULT_VPN_HEALTH_URL;
}

export function getVpnHealthPollIntervalMs(): number {
  const parsed = Number.parseInt(process.env.VPN_HEALTH_POLL_MS || "20000", 10);
  return Number.isFinite(parsed) && parsed >= 5000 ? parsed : 20000;
}

function isHealthResponseBodyOk(responseBodyText: string): boolean {
  const trimmedBody = responseBodyText.trim();
  if (
    trimmedBody.includes('"status":"ok"') ||
    trimmedBody.includes('"status": "ok"')
  ) {
    return true;
  }
  try {
    const parsedJson = JSON.parse(trimmedBody) as { status?: string };
    return parsedJson.status === "ok";
  } catch {
    return false;
  }
}

export async function probeVpnHealth(): Promise<VpnHealthProbeResult> {
  const healthUrl = getVpnHealthUrl();
  const timeoutMilliseconds = Number.parseInt(
    process.env.VPN_HEALTH_TIMEOUT_MS || String(DEFAULT_VPN_HEALTH_TIMEOUT_MS),
    10,
  );
  const checkedAt = new Date().toISOString();

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(
    () => abortController.abort(),
    Number.isFinite(timeoutMilliseconds) ? timeoutMilliseconds : DEFAULT_VPN_HEALTH_TIMEOUT_MS,
  );

  try {
    const httpResponse = await fetch(healthUrl, {
      signal: abortController.signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    const responseBodyText = await httpResponse.text();
    const bodyIndicatesOk = isHealthResponseBodyOk(responseBodyText);
    const isFullyOk = httpResponse.ok && bodyIndicatesOk;

    return {
      ok: isFullyOk,
      reachable: true,
      checkedAt,
      healthUrl,
      httpStatus: httpResponse.status,
      error: isFullyOk
        ? undefined
        : bodyIndicatesOk
          ? `HTTP ${httpResponse.status}`
          : `ответ без status ok (HTTP ${httpResponse.status})`,
    };
  } catch (probeError) {
    return {
      ok: false,
      reachable: false,
      checkedAt,
      healthUrl,
      error: probeError instanceof Error ? probeError.message : String(probeError),
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

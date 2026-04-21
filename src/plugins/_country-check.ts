import { createLogger } from "@/shared";

const _logger = createLogger("country-check");

/**
 * Endpoints that return the caller's country as a 2-letter ISO code. Tried
 * in order with a short timeout; the first successful response wins. All
 * three return plain text (or JSON we can regex), so no SDK dependency.
 *
 * Mirrors the zshrc preamble so agentara spawns fire under the same guard:
 * if the outbound proxy isn't landing somewhere expected, we bail loudly
 * before the agent starts billing tokens.
 */
const COUNTRY_PROBES = [
  { url: "https://ipapi.co/country/", kind: "text" as const },
  { url: "https://ifconfig.co/country-iso", kind: "text" as const },
  { url: "https://api.country.is/", kind: "country_is_json" as const },
];

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Probe several IP-geolocation endpoints and return the first ISO country
 * code they agree on shape-wise. Returns `null` when every probe fails
 * (network down, all providers rate-limited, etc.) — callers distinguish
 * that from a successful detection with `country !== "US"`.
 */
export async function detectCountry(options?: {
  /** Proxy URL (e.g. `http://127.0.0.1:7897`). Skipped when undefined. */
  proxy?: string;
  /** Per-request timeout. Defaults to 2s, matching the zshrc curl. */
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxy = options?.proxy;

  for (const probe of COUNTRY_PROBES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        // Bun's `fetch` accepts a `proxy` option natively — no undici
        // ProxyAgent setup needed. The signal handles the timeout.
        res = await fetch(probe.url, {
          signal: controller.signal,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun's proxy option isn't in lib.dom.fetch yet
          ...(proxy ? ({ proxy } as any) : {}),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) continue;
      const text = await res.text();
      const parsed = _parseCountry(text, probe.kind);
      if (parsed) {
        _logger.debug(
          { probe: probe.url, country: parsed },
          "country detected",
        );
        return parsed;
      }
    } catch (err) {
      _logger.debug({ err, probe: probe.url }, "country probe failed");
    }
  }
  return null;
}

function _parseCountry(
  body: string,
  kind: "text" | "country_is_json",
): string | null {
  if (kind === "country_is_json") {
    const match = body.match(/"country"\s*:\s*"([A-Z]{2})"/);
    return match ? match[1]! : null;
  }
  // Plain text: strip whitespace, take first 2 uppercase chars.
  const head = body.trim().slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(head) ? head : null;
}

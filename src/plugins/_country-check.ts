import { createLogger } from "@/shared";

const _logger = createLogger("country-check");

/**
 * Endpoints that return the caller's country as a 2-letter ISO code. Both
 * probes fire in parallel and the first successful answer wins — either
 * endpoint being slow or offline no longer stalls the gate.
 *
 * `ipapi.co` was dropped: it rate-limits aggressively from shared egress
 * IPs, which was the main source of the 2s timeout we'd then serialize on.
 *
 * Mirrors the zshrc preamble so agentara spawns fire under the same guard:
 * if the outbound proxy isn't landing somewhere expected, we bail loudly
 * before the agent starts billing tokens.
 */
const COUNTRY_PROBES = [
  { url: "https://ifconfig.co/country-iso", kind: "text" as const },
  { url: "https://api.country.is/", kind: "country_is_json" as const },
];

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Race every IP-geolocation probe in parallel and return the first ISO
 * country code that comes back. Resolves to `null` only when every probe
 * fails (network down, all providers rate-limited, etc.) — callers
 * distinguish that from a successful detection with `country !== "US"`.
 */
export async function detectCountry(options?: {
  /** Proxy URL (e.g. `http://127.0.0.1:7897`). Skipped when undefined. */
  proxy?: string;
  /** Per-request timeout. Defaults to 5s, matching the zshrc curl max-time. */
  timeoutMs?: number;
}): Promise<string | null> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxy = options?.proxy;

  const probes = COUNTRY_PROBES.map((probe) =>
    _runProbe(probe, { proxy, timeoutMs }),
  );
  return _firstNonNull(probes);
}

async function _runProbe(
  probe: (typeof COUNTRY_PROBES)[number],
  options: { proxy?: string; timeoutMs: number },
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    // Bun's `fetch` accepts a `proxy` option natively — no undici
    // ProxyAgent setup needed. The signal handles the timeout.
    const res = await fetch(probe.url, {
      signal: controller.signal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun's proxy option isn't in lib.dom.fetch yet
      ...(options.proxy ? ({ proxy: options.proxy } as any) : {}),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = _parseCountry(text, probe.kind);
    if (parsed) {
      _logger.debug({ probe: probe.url, country: parsed }, "country detected");
    }
    return parsed;
  } catch (err) {
    _logger.debug({ err, probe: probe.url }, "country probe failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve with the first non-null value produced by any of the input
 * promises. Resolves to `null` when every promise yields null/rejects —
 * rejections are treated as failed probes, not fatal errors.
 */
function _firstNonNull<T>(
  promises: Array<Promise<T | null>>,
): Promise<T | null> {
  return new Promise((resolve) => {
    if (promises.length === 0) {
      resolve(null);
      return;
    }
    let pending = promises.length;
    let settled = false;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const p of promises) {
      p.then(
        (v) => {
          if (v !== null) finish(v);
          else if (--pending === 0) finish(null);
        },
        () => {
          if (--pending === 0) finish(null);
        },
      );
    }
  });
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

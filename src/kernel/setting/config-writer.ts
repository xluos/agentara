import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { config, createLogger, reloadConfig } from "@/shared";

const _logger = createLogger("config-writer");

/**
 * Partial shape of the editable slice of `config.yaml`. Kept deliberately
 * narrow — only the fields exposed by the `/setting` panel land here. Fields
 * not present in the patch are left untouched on disk.
 */
export interface SettingConfigPatch {
  timezone?: string;
  agents?: {
    default?: {
      type?: string;
      /** Empty string clears the key so the runner uses its own default. */
      model?: string;
    };
    codex?: {
      isolate_host_env?: boolean;
    };
  };
  tasking?: {
    max_retries?: number;
  };
}

/**
 * Read `$AGENTARA_HOME/config.yaml`, deep-merge the patch, write it back,
 * then reload the in-memory `config` singleton. Throws on YAML/IO errors —
 * callers should surface the failure on the result card.
 */
export function writeConfigPatch(patch: SettingConfigPatch): void {
  const path = join(config.paths.home, "config.yaml");
  const raw = readFileSync(path, "utf-8");
  const parsed = (parseYaml(raw) as Record<string, unknown> | null) ?? {};
  const merged = _deepMerge(parsed, patch as Record<string, unknown>);
  _applyClears(merged);
  writeFileSync(path, stringifyYaml(merged));
  reloadConfig();
  _logger.info({ patch }, "config.yaml updated");
}

function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function _deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === undefined) continue;
    const baseVal = out[key];
    if (_isPlainObject(baseVal) && _isPlainObject(patchVal)) {
      out[key] = _deepMerge(baseVal, patchVal);
    } else {
      out[key] = patchVal;
    }
  }
  return out;
}

/**
 * Empty-string sentinel means "clear the field" — `agents.default.model` is
 * optional in the Zod schema, and forcing an empty string through would break
 * runners that treat "" as a real model id.
 */
function _applyClears(merged: Record<string, unknown>): void {
  const agents = merged.agents;
  if (_isPlainObject(agents)) {
    const def = agents.default;
    if (_isPlainObject(def) && def.model === "") {
      delete def.model;
    }
  }
}

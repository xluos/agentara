import { config } from "@/shared";

import { listRunnerTypes } from "./registry";

let runtimeDefaultAgentType: string | null = null;

export interface AgentRuntimeState {
  activeType: string;
  configuredDefaultType: string | null;
  hasRuntimeOverride: boolean;
  availableTypes: string[];
}

export interface SetRuntimeDefaultAgentResult {
  previousType: string;
  currentType: string;
  changed: boolean;
}

/**
 * Agent type used when creating a new session. Existing sessions keep the
 * agent_type stored in the DB so runner-specific resume state is not mixed.
 */
export function getRuntimeDefaultAgentType(): string {
  return runtimeDefaultAgentType ?? config.agents.default.type;
}

export function getAgentRuntimeState(): AgentRuntimeState {
  const configuredDefaultType = _readConfiguredDefaultAgentType();
  return {
    activeType:
      runtimeDefaultAgentType ??
      configuredDefaultType ??
      listRunnerTypes()[0] ??
      "<none>",
    configuredDefaultType,
    hasRuntimeOverride: runtimeDefaultAgentType !== null,
    availableTypes: listRunnerTypes(),
  };
}

export function setRuntimeDefaultAgentType(
  type: string,
): SetRuntimeDefaultAgentResult {
  const normalized = type.trim();
  const availableTypes = listRunnerTypes();
  const resolvedType = _resolveAvailableType(normalized, availableTypes);
  if (!resolvedType) {
    throw new UnknownAgentTypeError(normalized, availableTypes);
  }
  const previousType = getAgentRuntimeState().activeType;
  runtimeDefaultAgentType = resolvedType;
  return {
    previousType,
    currentType: resolvedType,
    changed: previousType !== resolvedType,
  };
}

export function resetRuntimeDefaultAgentType(): SetRuntimeDefaultAgentResult {
  const configuredDefaultType = _readConfiguredDefaultAgentType();
  if (!configuredDefaultType) {
    throw new Error("config.yaml has not been loaded yet.");
  }
  const previousType = getAgentRuntimeState().activeType;
  runtimeDefaultAgentType = null;
  return {
    previousType,
    currentType: configuredDefaultType,
    changed: previousType !== configuredDefaultType,
  };
}

export class UnknownAgentTypeError extends Error {
  constructor(
    readonly type: string,
    readonly availableTypes: string[],
  ) {
    super(
      `Unknown agent type: ${type}. Available types: ${
        availableTypes.join(", ") || "<none>"
      }.`,
    );
    this.name = "UnknownAgentTypeError";
  }
}

function _readConfiguredDefaultAgentType(): string | null {
  try {
    return config.agents.default.type;
  } catch {
    return null;
  }
}

function _resolveAvailableType(
  input: string,
  availableTypes: string[],
): string | null {
  if (availableTypes.includes(input)) return input;
  const lowered = input.toLowerCase();
  return availableTypes.find((type) => type.toLowerCase() === lowered) ?? null;
}

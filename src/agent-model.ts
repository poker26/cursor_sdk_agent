export interface AgentModelOption {
  id: string;
  label: string;
}

const DEFAULT_MODEL_ID = "composer-2";

const BUILTIN_MODEL_OPTIONS: AgentModelOption[] = [
  { id: "composer-2", label: "Composer 2" },
  { id: "composer-2-fast", label: "Composer 2 Fast" },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.5-medium", label: "GPT-5.5 Medium" },
  {
    id: "claude-4.6-sonnet-medium-thinking",
    label: "Claude 4.6 Sonnet (thinking)",
  },
  {
    id: "claude-opus-4-7-thinking-xhigh",
    label: "Claude Opus 4.7 (thinking)",
  },
];

function normalizeModelId(rawModelId: string): string {
  return rawModelId.trim();
}

function parseModelsJsonFromEnvironment(): AgentModelOption[] | null {
  const rawJson = process.env.CURSOR_MODELS_JSON?.trim();
  if (!rawJson) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("CURSOR_MODELS_JSON: невалидный JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("CURSOR_MODELS_JSON: ожидается массив объектов { id, label? }.");
  }
  const options: AgentModelOption[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.id === "string" ? normalizeModelId(record.id) : "";
    if (!id) {
      continue;
    }
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.trim()
        : id;
    options.push({ id, label });
  }
  if (options.length === 0) {
    throw new Error("CURSOR_MODELS_JSON: нет ни одной модели с полем id.");
  }
  return options;
}

function parseModelIdsListFromEnvironment(): AgentModelOption[] | null {
  const rawList = process.env.CURSOR_MODEL_IDS?.trim();
  if (!rawList) {
    return null;
  }
  const ids = rawList
    .split(",")
    .map((part) => normalizeModelId(part))
    .filter((part) => part.length > 0);
  if (ids.length === 0) {
    return null;
  }
  return ids.map((id) => ({ id, label: id }));
}

function ensureDefaultModelInList(
  options: AgentModelOption[],
  defaultModelId: string,
): AgentModelOption[] {
  if (options.some((option) => option.id === defaultModelId)) {
    return options;
  }
  return [{ id: defaultModelId, label: defaultModelId }, ...options];
}

let cachedModelOptions: AgentModelOption[] | undefined;

export function getDefaultAgentModelId(): string {
  const fromEnvironment = process.env.CURSOR_MODEL_ID?.trim();
  if (fromEnvironment) {
    return normalizeModelId(fromEnvironment);
  }
  return DEFAULT_MODEL_ID;
}

export function listAgentModelOptions(): AgentModelOption[] {
  if (cachedModelOptions) {
    return cachedModelOptions;
  }
  const defaultModelId = getDefaultAgentModelId();
  const fromJson = parseModelsJsonFromEnvironment();
  const fromList = fromJson ?? parseModelIdsListFromEnvironment();
  const baseOptions = fromList ?? BUILTIN_MODEL_OPTIONS;
  cachedModelOptions = ensureDefaultModelInList(baseOptions, defaultModelId);
  return cachedModelOptions;
}

export function isAllowedAgentModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return listAgentModelOptions().some((option) => option.id === normalized);
}

export class InvalidAgentModelIdError extends Error {
  readonly requestedModelId: string;

  constructor(requestedModelId: string) {
    const allowedIds = listAgentModelOptions()
      .map((option) => option.id)
      .join(", ");
    super(
      `Неизвестная модель «${requestedModelId}». Доступны: ${allowedIds}.`,
    );
    this.name = "InvalidAgentModelIdError";
    this.requestedModelId = requestedModelId;
  }
}

export function resolveRequestedAgentModelId(
  rawModelId: unknown,
): string {
  if (rawModelId === undefined || rawModelId === null || rawModelId === "") {
    return getDefaultAgentModelId();
  }
  if (typeof rawModelId !== "string") {
    throw new InvalidAgentModelIdError(String(rawModelId));
  }
  const normalized = normalizeModelId(rawModelId);
  if (!normalized) {
    return getDefaultAgentModelId();
  }
  if (!isAllowedAgentModelId(normalized)) {
    throw new InvalidAgentModelIdError(normalized);
  }
  return normalized;
}

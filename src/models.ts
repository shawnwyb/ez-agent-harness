export type ProviderId = "xai" | "anthropic";

export type ModelRef = {
  provider: ProviderId;
  id: string;
};

export type ResolveResult =
  | { kind: "ok"; model: ModelRef }
  | { kind: "many"; models: ModelRef[] }
  | { kind: "none" };

type Provider = {
  id: ProviderId;
  baseUrl: string;
  envKey: string;
  defaultModel: string;
  models: readonly string[];
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  xai: {
    id: "xai",
    baseUrl: "https://api.x.ai/v1",
    envKey: "XAI_API_KEY",
    defaultModel: "grok-4.6",
    models: ["grok-4.6", "grok-4.5", "grok-4-fast", "grok-3", "grok-3-mini"],
  },
  anthropic: {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    models: [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-fable-5",
      "claude-haiku-4-5",
    ],
  },
};

const PROVIDER_IDS: ProviderId[] = ["xai", "anthropic"];

export function formatModel(model: ModelRef): string {
  return `${model.provider}/${model.id}`;
}

export function isProviderId(value: string): value is ProviderId {
  return value === "xai" || value === "anthropic";
}

export function hasKey(provider: ProviderId): boolean {
  const value = process.env[PROVIDERS[provider].envKey];
  return typeof value === "string" && value.length > 0;
}

export function transportFor(model: ModelRef): {
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  const provider = PROVIDERS[model.provider];
  const apiKey = process.env[provider.envKey];
  if (!apiKey) {
    throw new Error(`Set ${provider.envKey} in .env`);
  }
  return { apiKey, baseUrl: provider.baseUrl, model: model.id };
}

function catalog(): ModelRef[] {
  const models: ModelRef[] = [];
  for (const id of PROVIDER_IDS) {
    for (const modelId of PROVIDERS[id].models) {
      models.push({ provider: id, id: modelId });
    }
  }
  return models;
}

function available(): ModelRef[] {
  return catalog().filter((model) => hasKey(model.provider));
}

export function initialModel(): ModelRef {
  const raw = process.env.MODEL?.trim();
  if (raw) {
    const resolved = resolveModel(raw);
    if (resolved.kind === "ok") return resolved.model;
    const slash = parseSlash(raw);
    if (slash) return slash;
  }
  if (hasKey("xai")) {
    return { provider: "xai", id: PROVIDERS.xai.defaultModel };
  }
  if (hasKey("anthropic")) {
    return { provider: "anthropic", id: PROVIDERS.anthropic.defaultModel };
  }
  return { provider: "xai", id: PROVIDERS.xai.defaultModel };
}

function parseSlash(query: string): ModelRef | null {
  const slash = query.indexOf("/");
  if (slash <= 0) return null;
  const providerRaw = query.slice(0, slash).toLowerCase();
  const provider = providerRaw === "claude" ? "anthropic" : providerRaw;
  const id = query.slice(slash + 1).trim();
  if (!isProviderId(provider) || id.length === 0) return null;
  return { provider, id };
}

export function resolveModel(query: string): ResolveResult {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "none" };

  const lower = trimmed.toLowerCase();
  if (isProviderId(lower) || lower === "claude") {
    const provider: ProviderId = lower === "claude" ? "anthropic" : lower;
    if (!hasKey(provider)) return { kind: "none" };
    return {
      kind: "ok",
      model: { provider, id: PROVIDERS[provider].defaultModel },
    };
  }

  const slash = parseSlash(trimmed);
  if (slash) {
    if (!hasKey(slash.provider)) return { kind: "none" };
    return { kind: "ok", model: slash };
  }

  const pool = available();
  const exact = pool.filter((model) => model.id.toLowerCase() === lower);
  if (exact.length === 1) return { kind: "ok", model: exact[0] };
  if (exact.length > 1) return { kind: "many", models: exact };

  const sub = pool.filter((model) => {
    const label = formatModel(model).toLowerCase();
    return label.includes(lower) || model.id.toLowerCase().includes(lower);
  });
  if (sub.length === 1) return { kind: "ok", model: sub[0] };
  if (sub.length > 1) return { kind: "many", models: sub };
  return { kind: "none" };
}

export function printModels(current: ModelRef): void {
  console.log(`current: ${formatModel(current)}\n`);
  for (const id of PROVIDER_IDS) {
    const provider = PROVIDERS[id];
    const keyed = hasKey(id);
    console.log(keyed ? id : `${id}  (no ${provider.envKey})`);
    for (const modelId of provider.models) {
      const mark =
        current.provider === id && current.id === modelId ? " (current)" : "";
      console.log(`  ${modelId}${mark}`);
    }
    console.log("");
  }
}

export function modelFromMeta(
  provider: string | undefined,
  model: string | undefined,
): ModelRef | null {
  if (!provider || !model || !isProviderId(provider) || model.length === 0) {
    return null;
  }
  return { provider, id: model };
}

/**
 * OpenAI-compatible model discovery helpers.
 *
 * This module intentionally has no Pi imports.  Keeping discovery and
 * normalization separate makes it possible to test against LiteLLM, Requesty,
 * and small self-hosted /v1/models implementations without starting Pi.
 */

export type OpenAICompatibleApi = "openai-completions" | "openai-responses";
export type ApiMode = OpenAICompatibleApi | "auto";
export type ModelInput = "text" | "image";

export const DEFAULT_REQUESTY_BASE_URL = "https://router.eu.requesty.ai/v1";
export const DEFAULT_API: ApiMode = "openai-completions";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

/** Environment variables checked in order for the provider API key. */
export const API_KEY_ENV_VARS = [
  "PI_CUSTOM_PROVIDER_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "REQUESTY_API_KEY",
  "CUSTOM_PROVIDER_API_KEY",
  "CUSTOM_OPENAI_API_KEY",
] as const;

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: ModelCostTier[];
}

/**
 * The subset of Pi's compatibility metadata that can be inferred from a
 * remote model record.  The extension casts this to pi-ai's API-specific
 * compatibility type at its boundary.
 */
export interface DiscoveredModelCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  supportsFinishReason?: boolean;
  supportsStrictMode?: boolean;
  supportsOpenAIGrammarTools?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";
  supportsLongCacheRetention?: boolean;
  sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter";
  sendSessionAffinityHeaders?: boolean;
}

/** A Pi model definition before the provider field is attached. */
export interface DiscoveredModel {
  id: string;
  name: string;
  api: OpenAICompatibleApi;
  baseUrl: string;
  reasoning: boolean;
  input: ModelInput[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  compat?: DiscoveredModelCompat;
}

export interface CatalogOptions {
  /** Root URL or an OpenAI-compatible base URL. `/v1` is added when absent. */
  baseUrl: string;
  /** API used when a model record does not explicitly identify one. */
  api: ApiMode;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  defaultReasoning?: boolean;
  defaultInput?: ModelInput[];
  /** Infer capabilities from supported_parameters when explicit flags are absent. */
  inferCapabilities?: boolean;
}

export interface FetchCatalogOptions extends CatalogOptions {
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type UnknownRecord = Record<string, unknown>;

const COMPAT_THINKING_FORMATS = new Set<NonNullable<DiscoveredModelCompat["thinkingFormat"]>>([
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "baseten",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
]);

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readPath(record: UnknownRecord, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split(".")) {
    const object = asRecord(current);
    if (!object || !(part in object)) return undefined;
    current = object[part];
  }
  return current;
}

function firstValue(record: UnknownRecord, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = readPath(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringValue(record: UnknownRecord, paths: readonly string[]): string | undefined {
  const value = firstValue(record, paths);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(record: UnknownRecord, paths: readonly string[]): number | undefined {
  const value = firstValue(record, paths);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanValue(record: UnknownRecord, paths: readonly string[]): boolean | undefined {
  const value = firstValue(record, paths);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    switch (value.trim().toLowerCase()) {
      case "true":
      case "yes":
      case "y":
      case "1":
        return true;
      case "false":
      case "no":
      case "n":
      case "0":
        return false;
    }
  }
  return undefined;
}

function stringsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function stringsValue(record: UnknownRecord, paths: readonly string[]): string[] {
  for (const path of paths) {
    const values = stringsFromValue(readPath(record, path));
    if (values.length > 0) return values;
  }
  return [];
}

function getConfiguredApi(value: unknown): ApiMode {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_API;
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case "auto":
    case "both":
    case "mixed":
      return "auto";
    case "openai-completions":
    case "chat-completions":
    case "completions":
    case "chat":
      return "openai-completions";
    case "openai-responses":
    case "responses":
    case "response":
      return "openai-responses";
    default:
      throw new Error(
        `Invalid OpenAI-compatible API ${JSON.stringify(value)}. Use openai-completions, openai-responses, or auto.`,
      );
  }
}

export function parseApiMode(value: unknown): ApiMode {
  return getConfiguredApi(value);
}

/**
 * Normalize a provider root or base URL to the URL expected by the OpenAI SDK.
 * Both `https://host` and `https://host/v1` therefore work, without ever
 * producing `.../v1/v1`.
 */
export function normalizeBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("OpenAI-compatible base URL must not be empty.");

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid OpenAI-compatible base URL: ${JSON.stringify(value)}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`OpenAI-compatible base URL must use http or https: ${JSON.stringify(value)}`);
  }
  if (!url.hostname) {
    throw new Error(`OpenAI-compatible base URL must include a hostname: ${JSON.stringify(value)}`);
  }
  if (url.username || url.password) {
    throw new Error("OpenAI-compatible base URL must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("OpenAI-compatible base URL must not contain a query string or fragment.");
  }

  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.toLowerCase().endsWith("/v1") ? path || "/v1" : `${path}/v1`;
  return url.toString().replace(/\/+$/u, "");
}

export function modelsEndpoint(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

function configuredBaseUrl(env: Record<string, string | undefined>): string {
  const value = [
    env.PI_CUSTOM_PROVIDER_BASE_URL,
    env.OPENAI_COMPATIBLE_BASE_URL,
    env.CUSTOM_PROVIDER_BASE_URL,
    env.CUSTOM_OPENAI_BASE_URL,
    env.REQUESTY_BASE_URL,
    env.OPENAI_BASE_URL,
  ].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return normalizeBaseUrl(value ?? DEFAULT_REQUESTY_BASE_URL);
}

export interface EnvironmentConfig {
  baseUrl: string;
  api: ApiMode;
  apiKey?: string;
  timeoutMs: number;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  defaultReasoning: boolean;
  defaultInput: ModelInput[];
  inferCapabilities: boolean;
}

function envNumber(env: Record<string, string | undefined>, names: readonly string[], fallback: number): number {
  for (const name of names) {
    const raw = env[name];
    if (!raw?.trim()) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

function envBoolean(env: Record<string, string | undefined>, names: readonly string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = booleanValue(env as UnknownRecord, [name]);
    if (value !== undefined) return value;
  }
  return fallback;
}

function envInput(env: Record<string, string | undefined>): ModelInput[] {
  const values = stringsFromValue(
    env.OPENAI_COMPATIBLE_DEFAULT_INPUT ?? env.CUSTOM_PROVIDER_DEFAULT_INPUT,
  ).map((value) => value.toLowerCase());
  const result: ModelInput[] = ["text"];
  if (values.includes("image") || values.includes("images") || values.includes("vision")) result.push("image");
  return result;
}

/** Read extension configuration without ever requiring a hard-coded secret. */
function runtimeEnvironment(): Record<string, string | undefined> {
  const processLike = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return processLike?.env ?? {};
}

export function readEnvironmentConfig(env: Record<string, string | undefined> = runtimeEnvironment()): EnvironmentConfig {
  const apiKey = API_KEY_ENV_VARS.map((name) => env[name]).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return {
    baseUrl: configuredBaseUrl(env),
    api: parseApiMode(
      env.PI_CUSTOM_PROVIDER_API ??
        env.OPENAI_COMPATIBLE_API ??
        env.CUSTOM_PROVIDER_API ??
        env.REQUESTY_API,
    ),
    apiKey,
    timeoutMs: envNumber(
      env,
      ["PI_CUSTOM_PROVIDER_MODEL_TIMEOUT_MS", "OPENAI_COMPATIBLE_MODEL_TIMEOUT_MS"],
      DEFAULT_DISCOVERY_TIMEOUT_MS,
    ),
    defaultContextWindow: Math.floor(
      envNumber(
        env,
        ["PI_CUSTOM_PROVIDER_CONTEXT_WINDOW", "OPENAI_COMPATIBLE_CONTEXT_WINDOW"],
        DEFAULT_CONTEXT_WINDOW,
      ),
    ),
    defaultMaxTokens: Math.floor(
      envNumber(
        env,
        ["PI_CUSTOM_PROVIDER_MAX_TOKENS", "OPENAI_COMPATIBLE_MAX_TOKENS"],
        DEFAULT_MAX_TOKENS,
      ),
    ),
    defaultReasoning: envBoolean(
      env,
      ["PI_CUSTOM_PROVIDER_DEFAULT_REASONING", "OPENAI_COMPATIBLE_DEFAULT_REASONING"],
      false,
    ),
    defaultInput: envInput(env),
    inferCapabilities: envBoolean(
      env,
      ["PI_CUSTOM_PROVIDER_INFER_CAPABILITIES", "OPENAI_COMPATIBLE_INFER_CAPABILITIES"],
      true,
    ),
  };
}

function fallbackApi(api: ApiMode): OpenAICompatibleApi {
  return api === "openai-responses" ? "openai-responses" : "openai-completions";
}

function remoteApi(value: unknown): OpenAICompatibleApi | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "openai-responses":
    case "responses":
    case "response":
      return "openai-responses";
    case "openai-completions":
    case "chat-completions":
    case "completions":
      return "openai-completions";
    // Requesty uses `api: "chat"` for its model catalogue.  It describes the
    // catalogue, not an instruction to override an explicitly configured API.
    case "chat":
      return undefined;
    default:
      return undefined;
  }
}

function modelApi(record: UnknownRecord, configured: ApiMode): OpenAICompatibleApi {
  return configured === "auto" ? remoteApi(record.api) ?? fallbackApi(configured) : fallbackApi(configured);
}

function modelId(record: UnknownRecord): string | undefined {
  return stringValue(record, ["id", "model", "model_id", "modelId", "name"]);
}

function modelName(record: UnknownRecord, id: string): string {
  return (
    stringValue(record, ["name", "display_name", "displayName", "model_canonical_name", "modelCanonicalName"]) ?? id
  );
}

function normalizeInput(record: UnknownRecord, defaults: ModelInput[]): ModelInput[] {
  const values = stringsValue(record, [
    "input_modalities",
    "inputModalities",
    "input",
    "modalities",
    "capabilities.input_modalities",
    "metadata.input_modalities",
    "model_info.input_modalities",
    "architecture.input_modalities",
  ]).map((value) => value.toLowerCase());
  const input: ModelInput[] = ["text"];
  const explicitVision = booleanValue(record, [
    "supports_vision",
    "supportsVision",
    "vision",
    "capabilities.vision",
    "metadata.supports_vision",
    "model_info.supports_vision",
  ]);
  if (
    values.some((value) => value === "image" || value === "images" || value === "vision" || value === "image_url") ||
    explicitVision === true
  ) {
    input.push("image");
  } else if (explicitVision === undefined && defaults.includes("image")) {
    input.push("image");
  }
  return input;
}

function supportedParameters(record: UnknownRecord): string[] {
  return stringsValue(record, [
    "supported_parameters",
    "supportedParameters",
    "capabilities.supported_parameters",
    "metadata.supported_parameters",
    "model_info.supported_parameters",
  ]).map((value) => value.toLowerCase());
}

function inferReasoning(record: UnknownRecord, options: CatalogOptions): boolean {
  const explicit = booleanValue(record, [
    "supports_reasoning",
    "supportsReasoning",
    "reasoning",
    "capabilities.reasoning",
    "metadata.supports_reasoning",
    "model_info.supports_reasoning",
  ]);
  if (explicit !== undefined) return explicit;
  if (options.inferCapabilities !== false) {
    const parameters = supportedParameters(record);
    if (parameters.some((value) => value.includes("reasoning") || value.includes("thinking"))) return true;
  }
  return options.defaultReasoning ?? false;
}

function parseRate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function ratePerMillion(record: UnknownRecord, perMillionPaths: readonly string[], perTokenPaths: readonly string[]): number | undefined {
  const perMillion = parseRate(firstValue(record, perMillionPaths));
  if (perMillion !== undefined) return perMillion;
  const perToken = parseRate(firstValue(record, perTokenPaths));
  return perToken === undefined ? undefined : perToken * 1_000_000;
}

function extractPricingRates(record: UnknownRecord, previous: ModelCost): ModelCost {
  const input =
    ratePerMillion(
      record,
      ["input_per_million", "input_price_per_million", "inputPricePerMillion", "prompt_per_million"],
      ["input_price", "prompt_price", "input_cost_per_token", "prompt_cost_per_token", "prompt"],
    ) ?? previous.input;
  const output =
    ratePerMillion(
      record,
      ["output_per_million", "output_price_per_million", "outputPricePerMillion", "completion_per_million"],
      ["output_price", "completion_price", "output_cost_per_token", "completion_cost_per_token", "completion"],
    ) ?? previous.output;
  const cacheRead =
    ratePerMillion(
      record,
      ["cache_read_per_million", "cached_per_million", "cacheReadPerMillion"],
      ["cached_price", "cache_read_price", "cache_read_cost_per_token"],
    ) ?? previous.cacheRead;
  const cacheWrite =
    ratePerMillion(
      record,
      ["cache_write_per_million", "caching_per_million", "cacheWritePerMillion"],
      ["caching_price", "caching_5m_price", "cache_write_price", "cache_write_cost_per_token"],
    ) ?? previous.cacheWrite;
  return { input, output, cacheRead, cacheWrite };
}

function parseCosts(record: UnknownRecord): ModelCost {
  const zero: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const pricing = firstValue(record, ["pricing", "prices"]);
  const entries = Array.isArray(pricing)
    ? pricing.map(asRecord).filter((entry): entry is UnknownRecord => entry !== undefined)
    : [];

  if (entries.length > 0) {
    const sorted = [...entries].sort(
      (left, right) =>
        (numberValue(left, ["prompt_tokens_threshold", "input_tokens_above", "inputTokensAbove", "threshold"]) ?? 0) -
        (numberValue(right, ["prompt_tokens_threshold", "input_tokens_above", "inputTokensAbove", "threshold"]) ?? 0),
    );
    let current = zero;
    const tiers: ModelCostTier[] = [];
    for (const entry of sorted) {
      current = extractPricingRates(entry, current);
      const threshold = Math.max(
        0,
        numberValue(entry, ["prompt_tokens_threshold", "input_tokens_above", "inputTokensAbove", "threshold"]) ?? 0,
      );
      if (threshold === 0) {
        // The first zero-threshold Requesty entry is the base price.
        continue;
      }
      tiers.push({ inputTokensAbove: threshold, ...current });
    }
    // If a provider omitted a zero-threshold entry, use the lowest tier as the
    // base and retain only the later tiers.
    const baseEntry = sorted.find(
      (entry) =>
        (numberValue(entry, ["prompt_tokens_threshold", "input_tokens_above", "inputTokensAbove", "threshold"]) ?? 0) === 0,
    );
    const base = baseEntry ? extractPricingRates(baseEntry, zero) : extractPricingRates(sorted[0]!, zero);
    return tiers.length > 0 ? { ...base, tiers } : base;
  }

  const direct = asRecord(firstValue(record, ["cost", "pricing"]));
  if (direct) {
    const input = parseRate(firstValue(direct, ["input", "prompt"])) ?? 0;
    const output = parseRate(firstValue(direct, ["output", "completion"])) ?? 0;
    const cacheRead = parseRate(firstValue(direct, ["cacheRead", "cache_read", "cached"])) ?? 0;
    const cacheWrite = parseRate(firstValue(direct, ["cacheWrite", "cache_write", "caching"])) ?? 0;
    return { input, output, cacheRead, cacheWrite };
  }

  return zero;
}

function parseCompat(record: UnknownRecord, reasoning: boolean): DiscoveredModelCompat {
  const developerRole = booleanValue(record, [
    "supports_role_developer",
    "supportsDeveloperRole",
    "supports_developer_role",
    "capabilities.supports_role_developer",
    "metadata.supports_role_developer",
    "model_info.supports_role_developer",
  ]);
  const reasoningEffort = booleanValue(record, [
    "supports_reasoning_effort",
    "supportsReasoningEffort",
    "capabilities.supports_reasoning_effort",
    "metadata.supports_reasoning_effort",
    "model_info.supports_reasoning_effort",
  ]);
  const compat: DiscoveredModelCompat = {
    // A generic compatible endpoint is less likely to understand Pi's optional
    // `store` field.  Requesty and LiteLLM both safely accept the remaining
    // standard OpenAI fields.
    supportsStore: false,
    supportsDeveloperRole: developerRole ?? false,
    supportsUsageInStreaming:
      booleanValue(record, ["supports_usage_in_streaming", "supportsUsageInStreaming"]) ?? true,
    supportsFinishReason: booleanValue(record, ["supports_finish_reason", "supportsFinishReason"]) ?? true,
    supportsStrictMode: booleanValue(record, ["supports_strict_mode", "supportsStrictMode"]) ?? false,
    supportsOpenAIGrammarTools: false,
    supportsLongCacheRetention: false,
  };

  if (reasoningEffort !== undefined) {
    compat.supportsReasoningEffort = reasoningEffort;
  } else if (reasoning) {
    compat.supportsReasoningEffort = true;
  }

  const maxTokensField = stringValue(record, ["max_tokens_field", "maxTokensField"]);
  if (maxTokensField === "max_tokens" || maxTokensField === "max_completion_tokens") {
    compat.maxTokensField = maxTokensField;
  }

  const strict = booleanValue(record, ["supports_strict_tools", "supportsStrictTools"]);
  if (strict !== undefined) compat.supportsStrictMode = strict;

  const thinkingFormat = stringValue(record, ["thinking_format", "thinkingFormat"]);
  if (thinkingFormat && COMPAT_THINKING_FORMATS.has(thinkingFormat as NonNullable<DiscoveredModelCompat["thinkingFormat"]>)) {
    compat.thinkingFormat = thinkingFormat as DiscoveredModelCompat["thinkingFormat"];
  }

  return compat;
}

function payloadModels(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const object = asRecord(payload);
  if (!object) throw new Error("The /v1/models response must be a JSON object or array.");
  const data = object.data ?? object.models;
  if (!Array.isArray(data)) {
    throw new Error('The /v1/models response does not contain a "data" array.');
  }
  return data;
}

/** Convert an OpenAI-compatible model-list response to Pi model definitions. */
export function parseModelCatalog(payload: unknown, options: CatalogOptions): DiscoveredModel[] {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fallbackContextWindow = positiveNumber(options.defaultContextWindow, DEFAULT_CONTEXT_WINDOW);
  const fallbackMaxTokens = positiveNumber(options.defaultMaxTokens, DEFAULT_MAX_TOKENS);
  const defaults: ModelInput[] = options.defaultInput?.includes("image") ? ["text", "image"] : ["text"];
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const item of payloadModels(payload)) {
    const record = asRecord(item);
    if (!record) continue;
    const id = modelId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const reasoning = inferReasoning(record, options);
    const contextWindow = positiveNumber(
      numberValue(record, [
        "context_window",
        "contextWindow",
        "max_context_length",
        "maxContextLength",
        "max_model_len",
        "maxModelLen",
        "max_input_tokens",
        "metadata.context_window",
        "model_info.context_window",
        "model_info.max_context_length",
        "model_info.max_model_len",
        "model_info.max_input_tokens",
      ]),
      fallbackContextWindow,
    );
    const maxTokens = positiveNumber(
      numberValue(record, [
        "max_output_tokens",
        "maxOutputTokens",
        "max_tokens",
        "maxTokens",
        "max_completion_tokens",
        "maxCompletionTokens",
        "metadata.max_output_tokens",
        "model_info.max_output_tokens",
        "model_info.max_tokens",
        "model_info.max_model_len",
      ]),
      fallbackMaxTokens,
    );

    models.push({
      id,
      name: modelName(record, id),
      api: modelApi(record, options.api),
      baseUrl,
      reasoning,
      input: normalizeInput(record, defaults),
      cost: parseCosts(record),
      contextWindow,
      maxTokens,
      compat: parseCompat(record, reasoning),
    });
  }

  return models;
}

function errorBody(body: string, apiKey: string | undefined): string {
  let safe = body.trim();
  if (apiKey && apiKey.length > 0) safe = safe.replaceAll(apiKey, "[redacted]");
  if (safe.length > 800) safe = `${safe.slice(0, 800)}…`;
  return safe;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Model discovery timed out")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return {
    signal: combined,
    dispose: () => clearTimeout(timeout),
  };
}

/** Fetch and parse `GET <baseUrl>/models` (normally `/v1/models`). */
export async function fetchOpenAICompatibleCatalog(options: FetchCatalogOptions): Promise<DiscoveredModel[]> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("This runtime does not provide fetch().");

  const request = requestSignal(options.signal, timeoutMs);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = options.apiKey?.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetchImpl(modelsEndpoint(baseUrl), {
      method: "GET",
      headers,
      signal: request.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const suffix = errorBody(body, apiKey);
      throw new Error(
        `Model discovery failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${suffix ? `: ${suffix}` : "."}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Model discovery returned invalid JSON.");
    }
    options.signal?.throwIfAborted();
    return parseModelCatalog(payload, { ...options, baseUrl });
  } finally {
    request.dispose();
  }
}

export function isOffline(env: Record<string, string | undefined> = runtimeEnvironment()): boolean {
  const value = env.PI_OFFLINE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function isDebugEnabled(env: Record<string, string | undefined> = runtimeEnvironment()): boolean {
  const value = env.PI_CUSTOM_PROVIDER_DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

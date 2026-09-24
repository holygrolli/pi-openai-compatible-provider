/**
 * Dynamic OpenAI-compatible provider for Pi.
 *
 * The provider delegates generation to pi-ai's standard OpenAI Chat
 * Completions and Responses implementations.  Its model catalogue comes from
 * GET <baseUrl>/models (normally /v1/models), so it works with Requesty,
 * LiteLLM, vLLM, LM Studio, and other compatible servers.
 *
 * The extension factory is asynchronous on purpose: Pi waits for the first
 * catalogue request before startup completes, which makes discovered models
 * available to --list-models as well as the interactive model picker.
 */

import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import {
  envApiKeyAuth,
  type Api,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type ProviderStreams,
  type RefreshModelsContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  type CatalogOptions,
  type DiscoveredModel,
  type ProviderEnvironmentConfig,
  fetchOpenAICompatibleCatalog,
  isOffline,
  modelsEndpoint,
  readEnvironmentConfigs,
} from "./model-catalog.ts";

export type {
  ApiMode,
  CatalogOptions,
  DiscoveredModel,
  ProviderEnvironmentConfig,
  ProviderIdentity,
} from "./model-catalog.ts";
export {
  DEFAULT_API,
  fetchOpenAICompatibleCatalog,
  modelsEndpoint,
  parseApiMode,
  providerIdForInstance,
  readEnvironmentConfigs,
} from "./model-catalog.ts";

const API_IMPLEMENTATIONS: Record<
  "openai-completions" | "openai-responses",
  ProviderStreams
> = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
};

function isSupportedApi(value: unknown): value is "openai-completions" | "openai-responses" {
  return value === "openai-completions" || value === "openai-responses";
}

export function toPiModel(
  discovered: DiscoveredModel,
  providerId: string,
): Model<"openai-completions" | "openai-responses"> {
  return {
    id: discovered.id,
    name: discovered.name,
    api: discovered.api,
    provider: providerId,
    baseUrl: discovered.baseUrl,
    reasoning: discovered.reasoning,
    input: discovered.input,
    cost: discovered.cost,
    contextWindow: discovered.contextWindow,
    maxTokens: discovered.maxTokens,
    ...(discovered.compat ? { compat: discovered.compat as Model<Api>["compat"] } : {}),
  } as Model<"openai-completions" | "openai-responses">;
}

export function restoreStoredModels(
  stored: RefreshModelsContext["stored"],
  config: ProviderEnvironmentConfig,
  providerId: string,
): Model<"openai-completions" | "openai-responses">[] {
  if (!stored) return [];

  const restored: Model<"openai-completions" | "openai-responses">[] = [];
  const seen = new Set<string>();
  for (const storedModel of stored.models) {
    if (storedModel.provider !== providerId || typeof storedModel.id !== "string") continue;
    if (seen.has(storedModel.id)) continue;
    seen.add(storedModel.id);

    // A fixed API selection is intentionally applied to cached records too.
    // This makes changing the scoped API mode environment variable take effect immediately rather
    // than waiting for a network refresh.  `auto` preserves a cached model's
    // API when it is one of the two APIs this provider owns.
    const api =
      config.api === "auto"
        ? isSupportedApi(storedModel.api)
          ? storedModel.api
          : "openai-completions"
        : config.api;
    restored.push({
      ...(storedModel as Model<Api>),
      api,
      provider: providerId,
      baseUrl: config.baseUrl,
    } as Model<"openai-completions" | "openai-responses">);
  }
  return restored;
}

function providerConfig(config: ProviderEnvironmentConfig): ProviderEnvironmentConfig {
  return config;
}

function catalogOptions(config: ProviderEnvironmentConfig): CatalogOptions {
  return {
    baseUrl: config.baseUrl,
    api: config.api,
    defaultContextWindow: config.defaultContextWindow,
    defaultMaxTokens: config.defaultMaxTokens,
    defaultReasoning: config.defaultReasoning,
    defaultInput: config.defaultInput,
    inferCapabilities: config.inferCapabilities,
  };
}

/**
 * Build the complete native provider.  `refreshModels` is implemented here
 * rather than in a session_start hook so Pi can refresh it from the model
 * selector and persist the last successful catalogue.
 */
export function createOpenAICompatibleProvider(
  inputConfig: ProviderEnvironmentConfig,
  initialModels: readonly DiscoveredModel[] = [],
): Provider<"openai-completions" | "openai-responses"> {
  const config = providerConfig(inputConfig);
  let models = initialModels.map((model) => toPiModel(model, config.providerId));
  const discoveryOptions = catalogOptions(config);

  const provider: Provider<"openai-completions" | "openai-responses"> = {
    id: config.providerId,
    name: config.displayName,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth(
        `${config.displayName} API key`,
        config.apiKeyEnvVars,
      ),
    },
    getModels: () => models,

    async refreshModels(context) {
      // Restore the last successful catalogue first.  This keeps Pi usable
      // offline and gives the model selector something to display while a
      // fresh request is in flight.
      if (context.stored) {
        const restored = restoreStoredModels(context.stored, config, config.providerId);
        const published = await context.publish({
          update: () => {
            models = restored;
          },
        });
        if (!published) return;
      }

      if (!context.allowNetwork || context.signal.aborted) return;

      const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      const refreshed = await fetchOpenAICompatibleCatalog({
        ...discoveryOptions,
        apiKey,
        signal: context.signal,
        timeoutMs: config.timeoutMs,
      });
      context.signal.throwIfAborted();
      const nextModels = refreshed.map((model) => toPiModel(model, config.providerId));
      await context.publish({
        persist: {
          models: nextModels,
          checkedAt: Date.now(),
        },
        update: () => {
          models = nextModels;
        },
      });
    },

    // The model list can contain either API.  Dispatching through the lazy
    // built-in adapters preserves Pi's normal streaming, tool-call, usage,
    // abort, and error handling for both protocols.
    stream(model, context, options) {
      const implementation = API_IMPLEMENTATIONS[model.api as keyof typeof API_IMPLEMENTATIONS];
      if (!implementation) {
        throw new Error(`Unsupported OpenAI-compatible API: ${String(model.api)}`);
      }
      return implementation.stream(model as never, context, options as never);
    },
    streamSimple(model, context, options?: SimpleStreamOptions): AssistantMessageEventStream {
      const implementation = API_IMPLEMENTATIONS[model.api as keyof typeof API_IMPLEMENTATIONS];
      if (!implementation) {
        throw new Error(`Unsupported OpenAI-compatible API: ${String(model.api)}`);
      }
      return implementation.streamSimple(model as never, context, options);
    },
  };

  return provider;
}

async function discoverInitialModels(config: ProviderEnvironmentConfig): Promise<DiscoveredModel[]> {
  if (isOffline()) return [];

  try {
    return await fetchOpenAICompatibleCatalog({
      ...catalogOptions(config),
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // A failed first request must not prevent Pi from starting. Each instance
    // owns its failure and can retry independently through refreshModels.
    if (config.debug) {
      console.warn(
        `[${config.providerId}] initial model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

export function selectProviderConfigs(
  configs: readonly ProviderEnvironmentConfig[],
  selector?: string,
): ProviderEnvironmentConfig[] {
  const value = selector?.trim();
  if (!value) return [...configs];
  return configs.filter((config) => config.instanceKey === value.toLowerCase() || config.providerId === value);
}

function registerRefreshCommand(pi: ExtensionAPI, configs: readonly ProviderEnvironmentConfig[]): void {
  pi.registerCommand("refresh-openai-compatible-models", {
    description: "Refresh all OpenAI-compatible catalogues, or one instance by key/provider ID",
    handler: async (args, ctx) => {
      const selector = typeof args === "string" ? args : "";
      const selected = selectProviderConfigs(configs, selector);
      if (selected.length === 0) {
        ctx.ui.notify(`Unknown OpenAI-compatible provider ${JSON.stringify(selector.trim())}. Use an instance key or provider ID.`, "error");
        return;
      }
      // Per-provider discovery still applies its own timeout. This aggregate
      // deadline prevents a command from waiting forever if a provider adapter
      // fails to honor its signal.
      const signal = AbortSignal.timeout(Math.max(...selected.map((config) => config.timeoutMs), 1_000));
      const result = await ctx.modelRegistry.refresh({
        providers: selected.map((config) => config.providerId),
        allowNetwork: true,
        force: true,
        signal,
      });
      const messages: string[] = [];
      for (const config of selected) {
        const error = result.errors.get(config.providerId);
        if (error) {
          messages.push(`${config.displayName} (${config.providerId}): error ${error.message}`);
          continue;
        }
        const count = ctx.modelRegistry.getAll().filter((model) => model.provider === config.providerId).length;
        messages.push(`${config.displayName} (${config.providerId}): ${count} model${count === 1 ? "" : "s"} from ${modelsEndpoint(config.baseUrl)}`);
      }
      ctx.ui.notify(messages.join("; "), result.aborted ? "warning" : messages.some((message) => message.includes(": error ")) ? "error" : "info");
    },
  });
}

/**
 * Async factory required by Pi's extension loader.  The first fetch is kept
 * outside session_start so discovered models are present during startup and
 * `pi --list-models`.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  const configs = readEnvironmentConfigs();
  const discoveries = await Promise.allSettled(configs.map((config) => discoverInitialModels(config)));
  for (let index = 0; index < configs.length; index += 1) {
    const result = discoveries[index];
    const initialModels = result?.status === "fulfilled" ? result.value : [];
    pi.registerProvider(createOpenAICompatibleProvider(configs[index]!, initialModels));
  }
  registerRefreshCommand(pi, configs);
}

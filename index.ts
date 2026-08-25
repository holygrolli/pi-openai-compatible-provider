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
  API_KEY_ENV_VARS,
  type CatalogOptions,
  type DiscoveredModel,
  type EnvironmentConfig,
  fetchOpenAICompatibleCatalog,
  isDebugEnabled,
  isOffline,
  modelsEndpoint,
  readEnvironmentConfig,
} from "./model-catalog.ts";

export const PROVIDER_ID = "openai-compatible";
export const PROVIDER_NAME = "OpenAI-compatible (dynamic)";

export type { ApiMode, CatalogOptions, DiscoveredModel, EnvironmentConfig } from "./model-catalog.ts";
export {
  DEFAULT_API,
  DEFAULT_REQUESTY_BASE_URL,
  fetchOpenAICompatibleCatalog,
  modelsEndpoint,
  parseApiMode,
  readEnvironmentConfig,
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

function toPiModel(discovered: DiscoveredModel): Model<"openai-completions" | "openai-responses"> {
  return {
    id: discovered.id,
    name: discovered.name,
    api: discovered.api,
    provider: PROVIDER_ID,
    baseUrl: discovered.baseUrl,
    reasoning: discovered.reasoning,
    input: discovered.input,
    cost: discovered.cost,
    contextWindow: discovered.contextWindow,
    maxTokens: discovered.maxTokens,
    ...(discovered.compat ? { compat: discovered.compat as Model<Api>["compat"] } : {}),
  } as Model<"openai-completions" | "openai-responses">;
}

function restoreStoredModels(
  stored: RefreshModelsContext["stored"],
  config: EnvironmentConfig,
): Model<"openai-completions" | "openai-responses">[] {
  if (!stored) return [];

  const restored: Model<"openai-completions" | "openai-responses">[] = [];
  const seen = new Set<string>();
  for (const storedModel of stored.models) {
    if (storedModel.provider !== PROVIDER_ID || typeof storedModel.id !== "string") continue;
    if (seen.has(storedModel.id)) continue;
    seen.add(storedModel.id);

    // A fixed API selection is intentionally applied to cached records too.
    // This makes changing OPENAI_COMPATIBLE_API take effect immediately rather
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
      provider: PROVIDER_ID,
      baseUrl: config.baseUrl,
    } as Model<"openai-completions" | "openai-responses">);
  }
  return restored;
}

function catalogOptions(config: EnvironmentConfig): CatalogOptions {
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
  config: EnvironmentConfig,
  initialModels: readonly DiscoveredModel[] = [],
): Provider<"openai-completions" | "openai-responses"> {
  let models = initialModels.map(toPiModel);
  const discoveryOptions = catalogOptions(config);

  const provider: Provider<"openai-completions" | "openai-responses"> = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: envApiKeyAuth("OpenAI-compatible API key", API_KEY_ENV_VARS),
    },
    getModels: () => models,

    async refreshModels(context) {
      // Restore the last successful catalogue first.  This keeps Pi usable
      // offline and gives the model selector something to display while a
      // fresh request is in flight.
      if (context.stored) {
        const restored = restoreStoredModels(context.stored, config);
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
      const nextModels = refreshed.map(toPiModel);
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

async function discoverInitialModels(config: EnvironmentConfig): Promise<DiscoveredModel[]> {
  if (isOffline()) return [];

  try {
    return await fetchOpenAICompatibleCatalog({
      ...catalogOptions(config),
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    // A failed first request must not prevent Pi from starting: the provider's
    // refreshModels callback can retry from /model or the command below.  Do
    // not log by default because an unavailable local endpoint is normal for
    // users who configure this extension globally.
    if (isDebugEnabled()) {
      console.warn(
        `[${PROVIDER_ID}] initial model discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

function registerRefreshCommand(pi: ExtensionAPI, config: EnvironmentConfig): void {
  pi.registerCommand("refresh-openai-compatible-models", {
    description: "Refresh the dynamic OpenAI-compatible /v1/models catalogue",
    handler: async (_args, ctx) => {
      const signal = AbortSignal.timeout(config.timeoutMs);
      const result = await ctx.modelRegistry.refresh({
        providers: [PROVIDER_ID],
        allowNetwork: true,
        force: true,
        signal,
      });
      const error = result.errors.get(PROVIDER_ID);
      if (error) {
        ctx.ui.notify(`Could not refresh ${PROVIDER_ID}: ${error.message}`, "error");
        return;
      }
      if (result.aborted) {
        ctx.ui.notify(`Refreshing ${PROVIDER_ID} was cancelled.`, "warning");
        return;
      }
      const count = ctx.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID).length;
      ctx.ui.notify(`Loaded ${count} model${count === 1 ? "" : "s"} from ${modelsEndpoint(config.baseUrl)}.`, "info");
    },
  });
}

/**
 * Async factory required by Pi's extension loader.  The first fetch is kept
 * outside session_start so discovered models are present during startup and
 * `pi --list-models`.
 */
export default async function (pi: ExtensionAPI): Promise<void> {
  const config = readEnvironmentConfig();
  const initialModels = await discoverInitialModels(config);
  pi.registerProvider(createOpenAICompatibleProvider(config, initialModels));
  registerRefreshCommand(pi, config);
}

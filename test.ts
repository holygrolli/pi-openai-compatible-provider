import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  fetchOpenAICompatibleCatalog,
  modelsEndpoint,
  normalizeBaseUrl,
  parseApiMode,
  parseModelCatalog,
  displayNameFromBaseUrl,
  providerIdForInstance,
  readEnvironmentConfigs,
} from "./model-catalog.ts";
import {
  createOpenAICompatibleProvider,
  restoreStoredModels,
  selectProviderConfigs,
  toPiModel,
} from "./index.ts";

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not expose an address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("normalizes provider roots and builds exactly /v1/models", () => {
  assert.equal(normalizeBaseUrl("https://router.eu.requesty.ai"), "https://router.eu.requesty.ai/v1");
  assert.equal(normalizeBaseUrl("https://router.eu.requesty.ai/v1/"), "https://router.eu.requesty.ai/v1");
  assert.equal(normalizeBaseUrl("http://localhost:4000/api/v1///"), "http://localhost:4000/api/v1");
  assert.equal(modelsEndpoint("http://localhost:4000"), "http://localhost:4000/v1/models");
  assert.throws(() => normalizeBaseUrl("localhost:4000"), /http or https/);
  assert.throws(() => normalizeBaseUrl("https://user:password@example.com"), /credentials/);
  assert.throws(() => normalizeBaseUrl("https://example.com/v1?token=secret"), /query/);
});

test("accepts the documented API mode aliases", () => {
  assert.equal(parseApiMode("chat"), "openai-completions");
  assert.equal(parseApiMode("chat-completions"), "openai-completions");
  assert.equal(parseApiMode("responses"), "openai-responses");
  assert.equal(parseApiMode("both"), "auto");
  assert.throws(() => parseApiMode("not-an-api"), /Invalid OpenAI-compatible API/);
});

test("requires the provider list and reads scoped configuration", () => {
  assert.throws(() => readEnvironmentConfigs({}), /OPENAI_COMPATIBLE_PROVIDERS is required/);
  const config = readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: "local",
    OPENAI_COMPATIBLE_LOCAL_BASE_URL: "http://localhost:4000/",
    OPENAI_COMPATIBLE_LOCAL_API: "responses",
    OPENAI_COMPATIBLE_LOCAL_API_KEY: "test-key",
    OPENAI_COMPATIBLE_LOCAL_MODEL_TIMEOUT_MS: "2500",
  })[0]!;

  assert.equal(config.baseUrl, "http://localhost:4000/v1");
  assert.equal(config.api, "openai-responses");
  assert.equal(config.apiKey, "test-key");
  assert.equal(config.timeoutMs, 2500);
});

test("maps Requesty model metadata, capabilities, and tiered pricing", () => {
  const [model] = parseModelCatalog(
    {
      object: "list",
      data: [
        {
          api: "chat",
          id: "vertex/claude-sonnet-4-5",
          model_canonical_name: "claude-sonnet-4-5",
          pricing: [
            {
              prompt_tokens_threshold: 0,
              input_price: 3e-6,
              caching_price: 3.75e-6,
              cached_price: 3e-7,
              output_price: 15e-6,
            },
            {
              prompt_tokens_threshold: 200000,
              input_price: 6e-6,
              caching_price: 7.5e-6,
              cached_price: 6e-7,
              output_price: 22.5e-6,
            },
          ],
          max_output_tokens: 64000,
          context_window: 200000,
          supports_vision: true,
          supports_reasoning: true,
          supports_role_developer: false,
        },
      ],
    },
    {
      baseUrl: "https://router.eu.requesty.ai",
      api: "openai-completions",
    },
  );

  assert.ok(model);
  assert.equal(model.id, "vertex/claude-sonnet-4-5");
  assert.equal(model.name, "claude-sonnet-4-5");
  assert.equal(model.api, "openai-completions");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 64000);
  assert.deepEqual(model.cost, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    tiers: [
      {
        inputTokensAbove: 200000,
        input: 6,
        output: 22.5,
        cacheRead: 0.6,
        cacheWrite: 7.5,
      },
    ],
  });
  assert.equal(model.compat?.supportsDeveloperRole, false);
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.supportsStore, false);
});

test("supports mixed/Responses selection and conservative defaults", () => {
  const models = parseModelCatalog(
    {
      data: [
        { id: "chat-model", api: "chat" },
        { id: "responses-model", api: "responses" },
        { id: "chat-model" },
      ],
    },
    {
      baseUrl: "http://localhost:1234/v1",
      api: "auto",
    },
  );

  assert.deepEqual(
    models.map((model) => [model.id, model.api]),
    [
      ["chat-model", "openai-completions"],
      ["responses-model", "openai-responses"],
    ],
  );
  assert.equal(models[0]?.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(models[0]?.maxTokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(models[0]?.input, ["text"]);
  assert.equal(models[0]?.reasoning, false);
});

test("reads named provider groups in order without unsuffixed fallback", () => {
  const configs = readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: " Requesty, local ",
    OPENAI_COMPATIBLE_REQUESTY_BASE_URL: "https://router.eu.requesty.ai/v1",
    OPENAI_COMPATIBLE_REQUESTY_API_KEY: "requesty-key",
    OPENAI_COMPATIBLE_REQUESTY_API: "auto",
    OPENAI_COMPATIBLE_REQUESTY_NAME: "Requesty EU",
    OPENAI_COMPATIBLE_LOCAL_BASE_URL: "http://localhost:4000",
    OPENAI_COMPATIBLE_LOCAL_API_KEY: "local-key",
    OPENAI_COMPATIBLE_LOCAL_API: "responses",
    OPENAI_COMPATIBLE_LOCAL_CONTEXT_WINDOW: "32768",
  });

  assert.deepEqual(configs.map((config) => config.instanceKey), ["requesty", "local"]);
  assert.deepEqual(configs.map((config) => config.providerId), [
    "openai-compatible-requesty",
    "openai-compatible-local",
  ]);
  assert.equal(configs[0]?.displayName, "Requesty EU");
  assert.equal(configs[0]?.api, "auto");
  assert.equal(configs[0]?.apiKey, "requesty-key");
  assert.deepEqual(configs[0]?.apiKeyEnvVars, ["OPENAI_COMPATIBLE_REQUESTY_API_KEY"]);
  assert.equal(configs[1]?.api, "openai-responses");
  assert.equal(configs[1]?.defaultContextWindow, 32768);
  assert.equal(configs[1]?.apiKey, "local-key");
  assert.equal(configs[1]?.displayName, "localhost:4000");
  assert.equal(readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: "local",
    OPENAI_COMPATIBLE_LOCAL_BASE_URL: "http://localhost:4000",
    OPENAI_COMPATIBLE_API_KEY: "wrong-unsuffixed-key",
  })[0]?.apiKey, undefined);
  assert.equal(readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: "default,local",
    OPENAI_COMPATIBLE_DEFAULT_BASE_URL: "https://default.example/v1",
    OPENAI_COMPATIBLE_LOCAL_BASE_URL: "http://localhost:4000/v1",
    OPENAI_COMPATIBLE_LOCAL_API_KEY: "local-key",
  })[0]?.apiKey, undefined);
});

test("derives deterministic identities and validates named configuration", () => {
  const config = readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: "default",
    OPENAI_COMPATIBLE_DEFAULT_BASE_URL: "https://example.com/custom/v1",
  })[0]!;
  assert.equal(config.providerId, "openai-compatible-default");
  assert.equal(config.displayName, "example.com/custom");
  assert.equal(providerIdForInstance("My_Local"), "openai-compatible-my_local");
  assert.equal(displayNameFromBaseUrl("https://example.com:8443/custom/v1"), "example.com:8443/custom");
  assert.throws(() => readEnvironmentConfigs({ OPENAI_COMPATIBLE_PROVIDERS: "a,a", OPENAI_COMPATIBLE_A_BASE_URL: "https://a.example" }), /Duplicate/);
  assert.throws(() => readEnvironmentConfigs({ OPENAI_COMPATIBLE_PROVIDERS: "a,b", OPENAI_COMPATIBLE_A_BASE_URL: "https://a.example", OPENAI_COMPATIBLE_B_BASE_URL: "https://b.example", OPENAI_COMPATIBLE_A_NAME: "Same", OPENAI_COMPATIBLE_B_NAME: "Same" }), /Duplicate display NAME/);
  const sameHost = readEnvironmentConfigs({ OPENAI_COMPATIBLE_PROVIDERS: "a,b", OPENAI_COMPATIBLE_A_BASE_URL: "https://same.example/v1", OPENAI_COMPATIBLE_B_BASE_URL: "https://same.example/v1" });
  assert.deepEqual(sameHost.map((config) => config.displayName), ["same.example (a)", "same.example (b)"]);
  assert.throws(() => readEnvironmentConfigs({ OPENAI_COMPATIBLE_PROVIDERS: "bad.key", "OPENAI_COMPATIBLE_BAD.KEY_BASE_URL": "https://bad.example" }), /Invalid/);
});

test("isolates provider identities, models, auth environment names, and refresh selection", async () => {
  const configs = readEnvironmentConfigs({
    OPENAI_COMPATIBLE_PROVIDERS: "a,b",
    OPENAI_COMPATIBLE_A_BASE_URL: "https://a.example/v1",
    OPENAI_COMPATIBLE_A_API_KEY: "a-key",
    OPENAI_COMPATIBLE_B_BASE_URL: "https://b.example/v1",
    OPENAI_COMPATIBLE_B_API_KEY: "b-key",
  });
  const aModel = toPiModel({
    id: "shared-model",
    name: "A shared",
    api: "openai-completions",
    baseUrl: configs[0]!.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100,
    maxTokens: 10,
  }, configs[0]!.providerId);
  const bModel = toPiModel({ ...aModel, name: "B shared", baseUrl: configs[1]!.baseUrl }, configs[1]!.providerId);
  const providerA = createOpenAICompatibleProvider(configs[0]!, [aModel]);
  const providerB = createOpenAICompatibleProvider(configs[1]!, [bModel]);
  assert.notEqual(providerA.id, providerB.id);
  assert.equal(providerA.baseUrl, configs[0]!.baseUrl);
  assert.equal(providerB.baseUrl, configs[1]!.baseUrl);
  assert.deepEqual(providerA.getModels().map((model) => [model.provider, model.id]), [[configs[0]!.providerId, "shared-model"]]);
  assert.deepEqual(providerB.getModels().map((model) => [model.provider, model.id]), [[configs[1]!.providerId, "shared-model"]]);
  const restoredA = restoreStoredModels({
    models: [aModel, bModel],
    checkedAt: 1,
  }, configs[0]!, configs[0]!.providerId);
  assert.deepEqual(restoredA.map((model) => [model.provider, model.id, model.baseUrl]), [[configs[0]!.providerId, "shared-model", configs[0]!.baseUrl]]);
  const authSignal = new AbortController().signal;
  const authA = await providerA.auth!.apiKey!.resolve({
    ctx: { env: async (name) => name, fileExists: async () => false },
    signal: authSignal,
  });
  const authB = await providerB.auth!.apiKey!.resolve({
    ctx: { env: async (name) => name, fileExists: async () => false },
    signal: authSignal,
  });
  assert.equal(authA?.auth.apiKey, "OPENAI_COMPATIBLE_A_API_KEY");
  assert.equal(authB?.auth.apiKey, "OPENAI_COMPATIBLE_B_API_KEY");
  assert.deepEqual(selectProviderConfigs(configs), configs);
  assert.deepEqual(selectProviderConfigs(configs, "b"), [configs[1]]);
  assert.deepEqual(selectProviderConfigs(configs, "openai-compatible-a"), [configs[0]]);
});

test("maps common LiteLLM/self-hosted fields and ignores malformed duplicates", () => {
  const models = parseModelCatalog(
    {
      models: [
        {
          id: "local/qwen",
          max_model_len: 32768,
          max_output_tokens: 4096,
          supported_parameters: ["tools", "temperature"],
          supports_vision: false,
          cost: { input: 0.2, output: 0.8 },
        },
        { id: "local/qwen" },
        null,
        { name: "" },
      ],
    },
    { baseUrl: "http://localhost:4000/v1", api: "openai-completions" },
  );

  assert.equal(models.length, 1);
  assert.equal(models[0]?.contextWindow, 32768);
  assert.equal(models[0]?.maxTokens, 4096);
  assert.equal(models[0]?.reasoning, false);
  assert.deepEqual(models[0]?.input, ["text"]);
  assert.deepEqual(models[0]?.cost, { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 });
});

test("fetches the dynamic catalogue from /v1/models with bearer auth", async () => {
  let seenPath = "";
  let seenMethod = "";
  let seenAuthorization: string | undefined;
  const { server, baseUrl } = await startServer((request, response) => {
    seenPath = request.url ?? "";
    seenMethod = request.method ?? "";
    seenAuthorization = request.headers.authorization;
    sendJson(response, 200, { data: [{ id: "served/model", context_window: 12345 }] });
  });

  try {
    const models = await fetchOpenAICompatibleCatalog({
      baseUrl,
      api: "openai-completions",
      apiKey: "ephemeral-test-key",
      fetchImpl: globalThis.fetch,
    });
    assert.equal(seenPath, "/v1/models");
    assert.equal(seenMethod, "GET");
    assert.equal(seenAuthorization, "Bearer ephemeral-test-key");
    assert.equal(models[0]?.id, "served/model");
    assert.equal(models[0]?.contextWindow, 12345);
  } finally {
    await stopServer(server);
  }
});

test("does not leak an API key in a model discovery error", async () => {
  const { server, baseUrl } = await startServer((_request, response) => {
    sendJson(response, 401, { error: "invalid ephemeral-test-key credentials" });
  });

  try {
    await assert.rejects(
      fetchOpenAICompatibleCatalog({
        baseUrl,
        api: "openai-completions",
        apiKey: "ephemeral-test-key",
      }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /ephemeral-test-key/);
        return true;
      },
    );
  } finally {
    await stopServer(server);
  }
});

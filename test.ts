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
  readEnvironmentConfig,
} from "./model-catalog.ts";

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

test("reads configurable base URL, API mode, and custom key names", () => {
  const config = readEnvironmentConfig({
    PI_CUSTOM_PROVIDER_BASE_URL: "http://localhost:4000/",
    PI_CUSTOM_PROVIDER_API: "responses",
    CUSTOM_PROVIDER_API_KEY: "test-key",
    PI_CUSTOM_PROVIDER_MODEL_TIMEOUT_MS: "2500",
  });

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

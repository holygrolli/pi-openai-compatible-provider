# Dynamic OpenAI-compatible provider for Pi

This directory contains a Pi extension that registers the provider
`openai-compatible`. It delegates requests to Pi's built-in OpenAI-compatible
adapters and discovers models from:

```text
GET <base URL>/v1/models
```

It supports both the standard Chat Completions API and the OpenAI Responses API.
The model catalogue is fetched by the asynchronous extension factory before
startup, and is fetched again by Pi's model refresh flow. The last successful
catalogue is persisted by Pi's model store, so cached models remain available
when a server is temporarily offline.

## Run it

From this directory, load it explicitly:

```bash
pi -e ./index.ts --list-models
# The package manifest also supports: pi -e . --list-models
```

To make this project-local package load automatically after the project is
trusted, install the local package into project settings:

```bash
pi install ./ -l
```

The root URL and `/v1` form are both accepted. The extension normalizes either
form and makes the model request at exactly `/v1/models`.

### Requesty EU example

Do not put an API key in this repository. Set it in the environment (or use
`/login openai-compatible`):

```bash
export REQUESTY_API_KEY='your-requesty-key'
export OPENAI_COMPATIBLE_BASE_URL='https://router.eu.requesty.ai'

# `auto` honors an explicit responses API marker in a model record; otherwise
# it uses Chat Completions. Use `openai-responses` to force Responses for all
# discovered models.
export OPENAI_COMPATIBLE_API='auto'
pi -e ./index.ts --list-models
```

Requesty documents the EU OpenAI-compatible base URL as
`https://router.eu.requesty.ai/v1`. The extension's default is that endpoint,
so setting `OPENAI_COMPATIBLE_BASE_URL` is optional for Requesty. The key is
never written to the provider config, model store, or session.

To use the Responses API explicitly:

```bash
OPENAI_COMPATIBLE_API=openai-responses \
  pi -e ./index.ts --model openai-compatible/<model-id> "Say hello"
```

To use Chat Completions explicitly:

```bash
OPENAI_COMPATIBLE_API=openai-completions \
  pi -e ./index.ts --model openai-compatible/<model-id> "Say hello"
```

`chat`, `chat-completions`, `completions`, `responses`, `response`, `both`, and
`mixed` are accepted aliases. `both`/`mixed` are aliases for `auto`.

## LiteLLM and self-hosted servers

```bash
export OPENAI_COMPATIBLE_BASE_URL='http://localhost:4000/v1'
export OPENAI_COMPATIBLE_API_KEY='your-local-or-litellm-key'
export OPENAI_COMPATIBLE_API='openai-completions'
pi -e ./index.ts --list-models
```

If the configured URL has no `/v1` suffix, `/v1` is added automatically. The
following environment variables are recognized:

| Purpose | Variables (first non-empty value wins) |
| --- | --- |
| Base URL | `PI_CUSTOM_PROVIDER_BASE_URL`, `OPENAI_COMPATIBLE_BASE_URL`, `CUSTOM_PROVIDER_BASE_URL`, `CUSTOM_OPENAI_BASE_URL`, `REQUESTY_BASE_URL`, `OPENAI_BASE_URL` |
| API mode | `PI_CUSTOM_PROVIDER_API`, `OPENAI_COMPATIBLE_API`, `CUSTOM_PROVIDER_API`, `REQUESTY_API` |
| API key | `PI_CUSTOM_PROVIDER_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `REQUESTY_API_KEY`, `CUSTOM_PROVIDER_API_KEY`, `CUSTOM_OPENAI_API_KEY` |
| Discovery timeout | `PI_CUSTOM_PROVIDER_MODEL_TIMEOUT_MS`, `OPENAI_COMPATIBLE_MODEL_TIMEOUT_MS` |
| Default context window | `PI_CUSTOM_PROVIDER_CONTEXT_WINDOW`, `OPENAI_COMPATIBLE_CONTEXT_WINDOW` |
| Default max output | `PI_CUSTOM_PROVIDER_MAX_TOKENS`, `OPENAI_COMPATIBLE_MAX_TOKENS` |

The extension also accepts `PI_CUSTOM_PROVIDER_DEFAULT_REASONING`,
`OPENAI_COMPATIBLE_DEFAULT_REASONING`,
`PI_CUSTOM_PROVIDER_DEFAULT_INPUT`, and the corresponding capability-inference
flags for model-list implementations that return only `{ id }`.

## Dynamic refresh

The initial asynchronous fetch makes models available to `--list-models`.
Pi also refreshes the provider when the model selector opens. In an interactive
session, use:

```text
/refresh-openai-compatible-models
```

That command forces a fresh request and reports the number of loaded models.
The extension honors `PI_OFFLINE=1` and `pi --offline`, skips network discovery,
and uses any previously persisted catalogue.

## Model-list metadata

The mapper understands the normal OpenAI `{ "data": [{ "id": "..." }] }`
shape, a top-level array, and a `{ "models": [...] }` compatibility shape. It
also understands common metadata from Requesty and LiteLLM, including:

- `context_window`, `max_output_tokens`, and common aliases;
- `supports_vision` / input modalities;
- `supports_reasoning` and `supported_parameters`;
- `supports_role_developer`;
- Requesty's tiered `pricing` entries (per-token prices are converted to Pi's
  dollars-per-million-token rates).

Unknown or malformed model records are ignored, duplicate IDs are removed, and
all HTTP errors are surfaced without including the API key.

## Tests

The catalog parser and `/v1/models` request are covered without external
services:

```bash
npm test
npm run check
```

`test.ts` uses a local mock HTTP server and verifies URL normalization,
Authorization handling, Requesty-style metadata, tiered pricing, API mode
selection, and failure behavior. `index.ts` uses Pi's `openAICompletionsApi()`
and `openAIResponsesApi()` implementations for actual inference, so standard
streaming/tool/usage/abort behavior is not reimplemented here.

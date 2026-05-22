# Changelog

All notable changes to the **Copilot LLM Proxy** extension are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added

- **Request/response inspection in the metrics dashboard** — every row in the request log now has a `View` button that expands an inline panel showing the captured request messages and the response. Messages are role-coded (user / assistant / system / tool) and collapsed to a single line by default; click to expand. Tool calls render as separate collapsible blocks with pretty-printed JSON arguments.
- **Vendor-prefixed model names** — chat completion requests may now use OpenRouter-style `vendor/model` IDs (e.g. `copilot/claude-sonnet-4.6`, `openai/gpt-4o`, `copilotcli/gpt-5.4`). Bare names continue to work unchanged. Resolution tries `{id}`, `{family}`, then if a `/` is present `{vendor, id}`, `{vendor, family}`, bare `{id}`, bare `{family}`.
- **Richer startup notification** — when the server starts, the toast now shows the full base URL, auth status, and live model count, with `Copy URL`, `View Models`, `Metrics`, and `Docs` action buttons.
- **`Open Documentation` command** — opens the extension's README/details page inside VS Code. Accessible from the Command Palette, status bar tooltip, and startup notification.
- **`response_format` passthrough** — when a client sends `response_format: { type: "json_object" }` or `json_schema`, the proxy injects a JSON-only instruction into the messages (the VS Code LM API has no native `responseFormat` field).

### Changed

- Response handlers (`handleStream`, `handleNonStream`) now return `responseText` and structured `toolCallsData` so the metrics layer can persist them. Internal API only — no impact on HTTP responses.
- `RequestMetric` gained three optional fields (`requestMessages`, `responseText`, `toolCallsData`). Existing persisted metrics from 1.0.0 load unchanged.

### Notes

- `GET /v1/models` output is unchanged — bare IDs only, no duplicates.
- Captured request/response data is truncated before storage (800 chars per message, 3000 chars of response, 1000 chars per tool call argument) to keep `globalState` size bounded.

## [1.0.0]

### Added

- OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoints backed by VS Code's Language Model API.
- Streaming (SSE) and non-streaming responses.
- Tool calls / function calling with `tools` and `tool_choice`.
- Thinking / reasoning tokens surfaced via `reasoning_content` (compatible with DeepSeek / OpenAI reasoning format).
- Image inputs as base64 data URIs (`image_url` content parts).
- Request cancellation on client disconnect.
- Optional API key authentication via `Authorization: Bearer <key>`.
- Auto-start option to launch the proxy when VS Code opens.
- Metrics dashboard with summary cards, hourly activity chart, per-model breakdown, request log, and date range filtering.
- Status bar item with live request/token counters and a rich Markdown tooltip exposing quick actions.

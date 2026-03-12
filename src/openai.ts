// Copyright (c) 2026 Ilayanambi Ponramu. MIT License.

/**
 * OpenAI Compatibility Layer
 *
 * This module handles bidirectional conversion between the OpenAI Chat Completions API
 * format and VS Code's Language Model API. It enables any OpenAI-compatible client
 * (SDKs, CLI tools, etc.) to use GitHub Copilot models exposed through VS Code.
 *
 * ## Conversion Design
 *
 * ### Request Flow (OpenAI → VS Code)
 *
 *   OpenAI ChatCompletionCreateParams
 *     ├── messages[]        → convertMessages()      → LanguageModelChatMessage[]
 *     │   ├── system/developer  → User("[SYSTEM] ...")   (VS Code has no system role)
 *     │   ├── user              → User(content)          (text + image parts)
 *     │   ├── assistant         → Assistant(content)     (text + tool_call parts)
 *     │   └── tool              → User(ToolResultPart)   (wrapped as user message)
 *     ├── tools[]           → convertTools()         → LanguageModelChatTool[]
 *     │   └── function.name/description/parameters → name/description/inputSchema
 *     └── tool_choice       → convertToolChoice()    → LanguageModelChatToolMode
 *         └── "auto"|"required"|"none" → Auto|Required|Auto (no "none" in VS Code)
 *
 * ### Response Flow (VS Code → OpenAI)
 *
 *   LanguageModelChatResponse.stream (AsyncIterable)
 *     ├── LanguageModelTextPart      → delta.content / message.content
 *     ├── LanguageModelToolCallPart  → delta.tool_calls / message.tool_calls
 *     └── ThinkingPart (dynamic)     → delta.reasoning_content / message.reasoning_content
 *
 *   Streaming: Each part → SSE "data: {chunk}\n\n", ends with "data: [DONE]\n\n"
 *   Non-streaming: All parts collected → single JSON response
 *
 * ### Key Limitations
 *   - VS Code LM API has no "system" role; system messages are prefixed and sent as User
 *   - Image URLs (non-data-URI) cannot be fetched; they're converted to text placeholders
 *   - Token counts are estimated (~4 chars/token) since VS Code doesn't expose exact counts
 *   - tool_choice "none" falls back to "auto" (VS Code doesn't support disabling tools)
 */

import * as vscode from 'vscode';
import * as http from 'http';

/** Result returned by handleStream/handleNonStream for metrics tracking. */
export interface ResponseResult {
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  hasToolCalls: boolean;
}

// ============================================================================
// REQUEST CONVERSION: Tools (OpenAI → VS Code)
// ============================================================================

/**
 * Converts OpenAI function tool definitions to VS Code's LanguageModelChatTool format.
 *
 * OpenAI format:  { type: "function", function: { name, description, parameters } }
 * VS Code format: { name, description, inputSchema }
 *
 * Only "function" type tools are supported; other types are filtered out.
 */
export function convertTools(tools: any[]): vscode.LanguageModelChatTool[] {
  return tools
    .filter((t: any) => t.type === 'function' && t.function)
    .map((t: any) => ({
      name: t.function.name,
      description: t.function.description || '',
      inputSchema: t.function.parameters || {},
    }));
}

/**
 * Maps OpenAI tool_choice values to VS Code's LanguageModelChatToolMode.
 *
 * Mapping:
 *   "auto"     → Auto     (model decides whether to call tools)
 *   "required" → Required (model must call at least one tool)
 *   "none"     → Auto     (VS Code has no "none" mode; falls back to Auto)
 *   { type: "function", ... } → Auto (specific tool selection not supported)
 */
export function convertToolChoice(toolChoice: any): vscode.LanguageModelChatToolMode {
  if (toolChoice === 'auto') {
    return vscode.LanguageModelChatToolMode.Auto;
  }
  if (toolChoice === 'required') {
    return vscode.LanguageModelChatToolMode.Required;
  }
  return vscode.LanguageModelChatToolMode.Auto;
}

// ============================================================================
// REQUEST CONVERSION: Messages (OpenAI → VS Code)
// ============================================================================

/**
 * Converts an array of OpenAI chat messages to VS Code LanguageModelChatMessage[].
 *
 * Role mapping:
 *   system/developer → User (prefixed with "[SYSTEM] " since VS Code has no system role)
 *   user             → User (handles text, image_url content parts)
 *   assistant        → Assistant (handles text content + tool_calls array)
 *   tool             → User (wraps content in LanguageModelToolResultPart)
 */
export function convertMessages(messages: any[]): vscode.LanguageModelChatMessage[] {
  return messages.map((msg: any) => {
    switch (msg.role) {
      case 'system':
      case 'developer':
        // VS Code LM API has no system role — send as User with [SYSTEM] prefix
        return vscode.LanguageModelChatMessage.User(convertContentParts(msg, true));
      case 'assistant':
        return convertAssistantMessage(msg);
      case 'tool':
        // Tool results must be wrapped in ToolResultPart and sent as User messages
        return convertToolResultMessage(msg);
      case 'user':
      default:
        return vscode.LanguageModelChatMessage.User(convertContentParts(msg, false));
    }
  });
}

/**
 * Converts OpenAI message content (string or content parts array) to VS Code format.
 *
 * Handles two content formats:
 *   - Simple string: returned as-is (or with [SYSTEM] prefix)
 *   - Content parts array: each part converted based on type:
 *       "text"      → LanguageModelTextPart
 *       "image_url" → LanguageModelDataPart.image() for base64 data URIs
 *                      LanguageModelTextPart("[Image: url]") for HTTP URLs (can't fetch)
 *
 * Optimization: if result is a single TextPart, unwraps to plain string
 * (VS Code API accepts both string and part arrays, but string is more efficient).
 */
function convertContentParts(msg: any, isSystem: boolean): string | (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] {
  // Simple string content — most common case
  if (typeof msg.content === 'string') {
    return isSystem ? `[SYSTEM] ${msg.content}` : msg.content;
  }

  if (!Array.isArray(msg.content)) {
    return '';
  }

  // Multi-part content (text + images)
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];

  if (isSystem) {
    parts.push(new vscode.LanguageModelTextPart('[SYSTEM] '));
  }

  for (const part of msg.content) {
    if (part.type === 'text') {
      parts.push(new vscode.LanguageModelTextPart(part.text || ''));
    } else if (part.type === 'image_url' && part.image_url) {
      const imageUrl: string = part.image_url.url || '';
      // Parse data URIs: "data:image/png;base64,iVBOR..."
      const dataUriMatch = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        // Decode base64 to binary and create image data part
        const mimeType = dataUriMatch[1];
        const data = Uint8Array.from(Buffer.from(dataUriMatch[2], 'base64'));
        parts.push(vscode.LanguageModelDataPart.image(data, mimeType));
      } else {
        // HTTP URLs can't be fetched — VS Code API requires raw bytes
        parts.push(new vscode.LanguageModelTextPart(`[Image: ${imageUrl}]`));
      }
    }
  }

  // Unwrap single text part to plain string for efficiency
  return parts.length === 1 && parts[0] instanceof vscode.LanguageModelTextPart
    ? (parts[0] as vscode.LanguageModelTextPart).value
    : parts;
}

/**
 * Converts an OpenAI assistant message to VS Code format.
 *
 * Assistant messages can contain both text content and tool calls:
 *   - msg.content (string or parts[]) → LanguageModelTextPart(s)
 *   - msg.tool_calls[] → LanguageModelToolCallPart(s)
 *     Each tool call: { id, function: { name, arguments } }
 *     Arguments are JSON-parsed since VS Code expects an object, not a string.
 *
 * Both are combined into a single Assistant message with mixed parts.
 */
function convertAssistantMessage(msg: any): vscode.LanguageModelChatMessage {
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];

  // Extract text content
  if (typeof msg.content === 'string' && msg.content) {
    parts.push(new vscode.LanguageModelTextPart(msg.content));
  } else if (Array.isArray(msg.content)) {
    for (const p of msg.content) {
      if (p.type === 'text') {
        parts.push(new vscode.LanguageModelTextPart(p.text || ''));
      }
    }
  }

  // Extract tool calls — OpenAI sends arguments as JSON string, VS Code expects object
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const args = typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments || {};
      parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, args));
    }
  }

  // Optimize: unwrap single text part to plain string
  return vscode.LanguageModelChatMessage.Assistant(
    parts.length === 1 && parts[0] instanceof vscode.LanguageModelTextPart
      ? (parts[0] as vscode.LanguageModelTextPart).value
      : parts
  );
}

/**
 * Converts an OpenAI tool result message to VS Code format.
 *
 * OpenAI: { role: "tool", tool_call_id: "call_xyz", content: "result text" }
 * VS Code: User message containing a LanguageModelToolResultPart
 *
 * The tool result must be sent as a User message because VS Code's LM API
 * only supports User and Assistant roles — tool results are wrapped in
 * ToolResultPart which carries the call ID for correlation.
 */
function convertToolResultMessage(msg: any): vscode.LanguageModelChatMessage {
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return vscode.LanguageModelChatMessage.User([
    new vscode.LanguageModelToolResultPart(msg.tool_call_id || '', [
      new vscode.LanguageModelTextPart(content),
    ]),
  ]);
}

// ============================================================================
// RESPONSE CONVERSION: Streaming (VS Code → OpenAI SSE)
// ============================================================================

/**
 * Streams VS Code LM response as OpenAI-compatible Server-Sent Events (SSE).
 *
 * Iterates response.stream which yields typed parts:
 *   - LanguageModelTextPart      → chunk with delta.content
 *   - LanguageModelToolCallPart  → chunk with delta.tool_calls[]
 *   - ThinkingPart (duck-typed)  → chunk with delta.reasoning_content
 *
 * SSE format per the OpenAI spec:
 *   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[...]}\n\n
 *
 * The first chunk includes role: "assistant" in the delta.
 * Final chunk has finish_reason ("stop" or "tool_calls") and usage stats.
 * Stream terminates with "data: [DONE]\n\n".
 *
 * Error recovery: if the stream fails mid-way, an error chunk is sent to the
 * client before closing, so the client knows the response was incomplete.
 *
 * Cancellation: checks the cancellation token between chunks and breaks early
 * if the client disconnected (managed by extension.ts via req.on('close')).
 */
export async function handleStream(
  res: http.ServerResponse,
  response: vscode.LanguageModelChatResponse,
  modelId: string,
  cancellationToken?: vscode.CancellationToken,
): Promise<ResponseResult> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const id = `chatcmpl-${randomId()}`;
  const created = Math.floor(Date.now() / 1000);
  let first = true;             // Track first chunk to include role in delta
  let hasToolCalls = false;     // Track if any tool calls were emitted
  let toolCallIndex = -1;       // Incrementing index for each tool call
  let completionTokens = 0;     // Estimated token count for usage stats

  try {
    for await (const part of response.stream) {
      if (cancellationToken?.isCancellationRequested) {
        break;
      }

      // --- Text content ---
      if (part instanceof vscode.LanguageModelTextPart) {
        completionTokens += estimateTokens(part.value);
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: first
              ? { role: 'assistant', content: part.value }  // First chunk includes role
              : { content: part.value },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        first = false;
      }

      // --- Tool calls ---
      // Each ToolCallPart is a complete tool call (not streamed incrementally)
      // because VS Code LM API emits tool calls as whole objects, unlike OpenAI
      // which streams them in fragments (name first, then arguments in pieces).
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        hasToolCalls = true;
        toolCallIndex++;
        const argsStr = JSON.stringify(part.input);
        completionTokens += estimateTokens(argsStr);
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              ...(first ? { role: 'assistant', content: null } : {}),
              tool_calls: [{
                index: toolCallIndex,   // Position index for multiple tool calls
                id: part.callId,        // Unique ID for correlating with tool results
                type: 'function',
                function: {
                  name: part.name,
                  arguments: argsStr,   // Full arguments JSON (not streamed incrementally)
                },
              }],
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        first = false;
      }

      // --- Thinking / reasoning tokens ---
      // LanguageModelThinkingPart is not yet in stable VS Code types, so we
      // duck-type check for the .thinking property. Emitted as reasoning_content
      // in the delta (compatible with DeepSeek/OpenAI reasoning format).
      else if ((part as any).thinking !== undefined) {
        const thinkingPart = part as any;
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelId,
          choices: [{
            index: 0,
            delta: {
              ...(first ? { role: 'assistant' } : {}),
              reasoning_content: thinkingPart.thinking,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        first = false;
      }
    }
  } catch (err: any) {
    // Mid-stream error — notify client with an error chunk before closing
    if (!res.writableEnded && !cancellationToken?.isCancellationRequested) {
      const errorChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'error',
        }],
        error: { message: err.message, type: 'server_error' },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    }
  }

  // Send final chunk with finish_reason and terminate stream
  if (!res.writableEnded) {
    const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  return {
    usage: { promptTokens: 0, completionTokens, totalTokens: completionTokens },
    hasToolCalls,
  };
}

// ============================================================================
// RESPONSE CONVERSION: Non-Streaming (VS Code → OpenAI JSON)
// ============================================================================

/**
 * Collects the full VS Code LM response and returns it as a single OpenAI
 * chat.completion JSON object.
 *
 * Iterates response.stream to collect all parts into:
 *   - fullText: concatenated text from all LanguageModelTextPart(s)
 *   - toolCalls[]: array of OpenAI-format tool call objects
 *   - thinkingText: concatenated reasoning tokens (if any)
 *
 * Error recovery: if the stream fails after partial content has been collected,
 * returns what we have rather than throwing (partial response > no response).
 * If the stream fails with no content at all, the error is re-thrown.
 *
 * finish_reason is "tool_calls" if any tool calls were emitted, otherwise "stop".
 */
export async function handleNonStream(
  res: http.ServerResponse,
  response: vscode.LanguageModelChatResponse,
  modelId: string,
): Promise<ResponseResult> {
  let fullText = '';
  let thinkingText = '';
  const toolCalls: any[] = [];
  let toolCallIndex = 0;

  try {
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        fullText += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input),
          },
          index: toolCallIndex++,
        });
      } else if ((part as any).thinking !== undefined) {
        thinkingText += (part as any).thinking;
      }
    }
  } catch (err: any) {
    // If no content collected at all, re-throw so caller returns an error response
    if (!fullText && toolCalls.length === 0) {
      throw err;
    }
    // Otherwise return partial content — better than nothing
  }

  const hasToolCalls = toolCalls.length > 0;

  // Build the assistant message
  const message: any = { role: 'assistant', content: fullText || null };
  if (hasToolCalls) {
    message.tool_calls = toolCalls;
  }
  if (thinkingText) {
    message.reasoning_content = thinkingText;
  }

  const completionTokens = estimateTokens(fullText + thinkingText);

  sendJson(res, 200, {
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message,
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: 0,              // Not available from VS Code LM API
      completion_tokens: completionTokens,
      total_tokens: completionTokens,
    },
  });

  return {
    usage: { promptTokens: 0, completionTokens, totalTokens: completionTokens },
    hasToolCalls,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/** Generates a random alphanumeric ID for chat completion response IDs. */
function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Rough token estimate based on character count (~4 chars per token).
 * Not exact, but provides a reasonable approximation for usage stats
 * since the VS Code LM API doesn't expose actual token counts.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sends a JSON response with the given HTTP status code. */
export function sendJson(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Sends an OpenAI-compatible error JSON response. */
export function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, status, {
    error: { message, type: 'invalid_request_error', code: status },
  });
}

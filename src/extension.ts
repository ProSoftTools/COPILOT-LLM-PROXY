// Copyright (c) 2026 Ilayanambi Ponramu. MIT License.

import * as vscode from 'vscode';
import * as http from 'http';
import {
  convertMessages,
  convertTools,
  convertToolChoice,
  handleStream,
  handleNonStream,
  sendJson,
  sendError,
} from './openai';
import { initMetrics, recordRequest, markSessionStart, getSummary, showMetricsPanel, refreshPanel } from './metrics';

let server: http.Server | null = null;
let activePort: number = 0;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let metricsBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;

// Active request cancellation tokens
const activeRequests = new Map<string, vscode.CancellationTokenSource>();

// --- Logging ---

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
const LOG_LEVELS: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function getLogLevel(): LogLevel {
  return vscode.workspace.getConfiguration('copilotLlmProxy').get<LogLevel>('logLevel', 'INFO');
}

function log(level: LogLevel, msg: string) {
  if (LOG_LEVELS[level] < LOG_LEVELS[getLogLevel()]) { return; }
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] [${level}] ${msg}`);
}

// --- Extension Lifecycle ---

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  initMetrics(context.globalState);
  outputChannel = vscode.window.createOutputChannel('Copilot LLM Proxy');

  // Server status bar (right side)
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(circle-slash) Copilot LLM Proxy';
  statusBarItem.command = 'copilot-llm-proxy.toggle';
  statusBarItem.show();

  // Metrics bar (right side, next to server status)
  metricsBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  metricsBarItem.command = 'copilot-llm-proxy.metrics';
  metricsBarItem.hide();

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    metricsBarItem,
    vscode.commands.registerCommand('copilot-llm-proxy.start', () => { bootServer(getConfigPort(), getApiKey()); }),
    vscode.commands.registerCommand('copilot-llm-proxy.stop', () => { stopServer(); }),
    vscode.commands.registerCommand('copilot-llm-proxy.toggle', () => { server ? stopServer() : bootServer(getConfigPort(), getApiKey()); }),
    vscode.commands.registerCommand('copilot-llm-proxy.metrics', () => showMetricsPanel(extensionContext)),
    vscode.commands.registerCommand('copilot-llm-proxy.configPort', configurePort),
    vscode.commands.registerCommand('copilot-llm-proxy.configApiKey', configureApiKey),
    vscode.commands.registerCommand('copilot-llm-proxy.toggleAutoStart', toggleAutoStart),
  );

  // Set initial tooltip state
  updateStatusBar();

  // Auto-start if configured
  const autoStart = vscode.workspace.getConfiguration('copilotLlmProxy').get<boolean>('autoStart', false);
  if (autoStart) {
    bootServer(getConfigPort(), getApiKey());
  }
}

export function deactivate() {
  for (const [, cts] of activeRequests) {
    cts.cancel();
    cts.dispose();
  }
  activeRequests.clear();
  stopServer();
}

function getConfigPort(): number {
  return vscode.workspace.getConfiguration('copilotLlmProxy').get<number>('port', 4141);
}

function getApiKey(): string {
  return vscode.workspace.getConfiguration('copilotLlmProxy').get<string>('apiKey', '');
}

// --- Toggle Commands ---

async function toggleAutoStart() {
  const current = vscode.workspace.getConfiguration('copilotLlmProxy').get<boolean>('autoStart', false);
  await vscode.workspace.getConfiguration('copilotLlmProxy').update('autoStart', !current, vscode.ConfigurationTarget.Global);
  updateStatusBar();
}

// --- Configuration Commands ---

async function configurePort() {
  const port = getConfigPort();
  const input = await vscode.window.showInputBox({
    title: 'Copilot LLM Proxy — Port',
    prompt: 'Port number (1–65535)',
    value: String(port),
    validateInput: (v) => {
      const n = parseInt(v, 10);
      return (n >= 1 && n <= 65535) ? null : 'Enter a valid port (1–65535)';
    },
  });
  if (input !== undefined) {
    await vscode.workspace.getConfiguration('copilotLlmProxy').update('port', parseInt(input, 10), vscode.ConfigurationTarget.Global);
    updateStatusBar();
  }
}

async function configureApiKey() {
  const apiKey = getApiKey();
  const input = await vscode.window.showInputBox({
    title: 'Copilot LLM Proxy — API Key',
    prompt: 'API key for authentication (leave empty for no auth)',
    value: apiKey,
    password: true,
  });
  if (input !== undefined) {
    await vscode.workspace.getConfiguration('copilotLlmProxy').update('apiKey', input, vscode.ConfigurationTarget.Global);
    updateStatusBar();
  }
}

function bootServer(port: number, apiKey: string) {
  activePort = port;
  server = http.createServer(requestHandler);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      vscode.window.showErrorMessage(`Port ${port} is already in use.`);
    } else {
      vscode.window.showErrorMessage(`Server error: ${err.message}`);
    }
    server = null;
    updateStatusBar();
  });

  markSessionStart();

  server.listen(port, () => {
    const authStatus = apiKey ? ' (auth enabled)' : '';
    log('INFO', `Server started on port ${port}${authStatus}`);
    vscode.window.showInformationMessage(`Copilot LLM Proxy running on http://localhost:${port}${authStatus}`);
    updateStatusBar();
  });
}

function stopServer() {
  if (!server) { return; }
  server.close();
  server = null;
  log('INFO', 'Server stopped');
  updateStatusBar();
}

function updateStatusBar() {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.supportHtml = true;

  const port = server ? activePort : getConfigPort();
  const apiKey = getApiKey();
  const autoStart = vscode.workspace.getConfiguration('copilotLlmProxy').get<boolean>('autoStart', false);
  const autoStartIcon = autoStart ? '$(check)' : '$(blank)';

  // Header
  md.appendMarkdown(`**Copilot LLM Proxy**\n\n`);
  md.appendMarkdown(`---\n\n`);

  if (server) {
    const { requests, tokens } = getSummary();
    const tokensStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;

    statusBarItem.text = `$(radio-tower) Copilot LLM Proxy :${activePort}`;

    // Status
    md.appendMarkdown(`$(circle-filled) &nbsp; **Status** &nbsp;&nbsp; Running &nbsp; \`localhost:${port}\`\n\n`);
    md.appendMarkdown(`$(key) &nbsp; **Auth** &nbsp;&nbsp; ${apiKey ? 'Enabled' : 'Disabled'}\n\n`);
    md.appendMarkdown(`$(pulse) &nbsp; **Requests** &nbsp;&nbsp; ${requests} &nbsp; | &nbsp; **Tokens** &nbsp;&nbsp; ${tokensStr}\n\n`);
    md.appendMarkdown(`---\n\n`);

    // Settings
    md.appendMarkdown(`[$(gear) Port: \`${port}\`](command:copilot-llm-proxy.configPort) &nbsp;&nbsp; `);
    md.appendMarkdown(`[$(key) API Key](command:copilot-llm-proxy.configApiKey)\n\n`);
    md.appendMarkdown(`[${autoStartIcon} Auto-start](command:copilot-llm-proxy.toggleAutoStart)\n\n`);
    md.appendMarkdown(`---\n\n`);

    // Actions
    md.appendMarkdown(`[$(dashboard) Metrics](command:copilot-llm-proxy.metrics) &nbsp;&nbsp; `);
    md.appendMarkdown(`[$(debug-stop) Stop Server](command:copilot-llm-proxy.stop)`);

    updateMetricsBar();
    metricsBarItem.show();
  } else {
    statusBarItem.text = '$(circle-slash) Copilot LLM Proxy';

    // Status
    md.appendMarkdown(`$(circle-slash) &nbsp; **Status** &nbsp;&nbsp; Stopped\n\n`);
    md.appendMarkdown(`---\n\n`);

    // Settings
    md.appendMarkdown(`[$(gear) Port: \`${port}\`](command:copilot-llm-proxy.configPort) &nbsp;&nbsp; `);
    md.appendMarkdown(`[$(key) API Key: ${apiKey ? 'Configured' : 'None'}](command:copilot-llm-proxy.configApiKey)\n\n`);
    md.appendMarkdown(`[${autoStartIcon} Auto-start](command:copilot-llm-proxy.toggleAutoStart)\n\n`);
    md.appendMarkdown(`---\n\n`);

    // Actions
    md.appendMarkdown(`[$(play) Start Server](command:copilot-llm-proxy.start)`);

    metricsBarItem.hide();
  }

  statusBarItem.tooltip = md;
}

function updateMetricsBar() {
  const { requests, tokens } = getSummary();
  const tokensStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`;
  metricsBarItem.text = `$(pulse) ${requests} req | ${tokensStr} tok`;
  metricsBarItem.tooltip = 'Click to view usage metrics';
}

// --- HTTP Handler ---

async function requestHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://localhost`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API key authentication
  const apiKey = getApiKey();
  if (apiKey) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== apiKey) {
      log('WARN', `Unauthorized request to ${url.pathname}`);
      sendError(res, 401, 'Invalid or missing API key. Send Authorization: Bearer <key>.');
      return;
    }
  }

  log('INFO', `${req.method} ${url.pathname}`);

  try {
    // GET /v1/models
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return await handleListModels(res);
    }
    // GET /v1/models/:model
    const modelMatch = url.pathname.match(/^\/v1\/models\/(.+)$/);
    if (modelMatch && req.method === 'GET') {
      return await handleGetModel(res, decodeURIComponent(modelMatch[1]));
    }
    // POST /v1/chat/completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return await handleChatCompletions(req, res);
    }
    sendError(res, 404, 'Not found');
  } catch (err: any) {
    log('ERROR', `${err.message}\n${err.stack || ''}`);
    const status = mapErrorStatus(err);
    sendError(res, status, err.message);
  }
}

// --- GET /v1/models ---

async function handleListModels(res: http.ServerResponse) {
  const models = await vscode.lm.selectChatModels();
  const data = models.map(formatModel);
  sendJson(res, 200, { object: 'list', data });
}

// --- GET /v1/models/:model ---

async function handleGetModel(res: http.ServerResponse, modelId: string) {
  const model = await resolveModel(modelId);
  if (!model) {
    sendError(res, 404, `Model "${modelId}" not found.`);
    return;
  }
  sendJson(res, 200, formatModel(model));
}

function formatModel(m: vscode.LanguageModelChat) {
  return {
    id: m.id,
    object: 'model' as const,
    created: Math.floor(Date.now() / 1000),
    owned_by: m.vendor,
    max_model_len: m.maxInputTokens,
  };
}

// --- POST /v1/chat/completions ---

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  const startTime = Date.now();
  const body = JSON.parse(await readBody(req));
  const { model: modelId, messages, stream, max_tokens, tools, tool_choice, temperature, top_p } = body;

  if (!modelId || !messages) {
    sendError(res, 400, 'Missing required fields: model, messages');
    return;
  }

  const model = await resolveModel(modelId);
  if (!model) {
    const available = (await vscode.lm.selectChatModels()).map(m => m.id);
    sendError(res, 404, `Model "${modelId}" not found. Available: ${available.join(', ')}`);
    return;
  }

  const vsMessages = convertMessages(messages);

  // Build model options
  const modelOptions: Record<string, any> = {};
  if (max_tokens !== undefined) { modelOptions.maxTokens = max_tokens; }
  if (temperature !== undefined) { modelOptions.temperature = temperature; }
  if (top_p !== undefined) { modelOptions.topP = top_p; }

  const options: vscode.LanguageModelChatRequestOptions = {};
  if (Object.keys(modelOptions).length > 0) {
    options.modelOptions = modelOptions;
  }
  if (tools && tools.length > 0) {
    options.tools = convertTools(tools);
    if (tool_choice) {
      options.toolMode = convertToolChoice(tool_choice);
    }
  }

  // Set up cancellation
  const requestId = randomId();
  const cts = new vscode.CancellationTokenSource();
  activeRequests.set(requestId, cts);

  req.on('close', () => {
    if (!res.writableEnded) {
      log('DEBUG', `Client disconnected, cancelling request ${requestId}`);
      cts.cancel();
    }
  });

  log('DEBUG', `Request ${requestId}: model=${modelId}, stream=${!!stream}, messages=${messages.length}`);

  let error: string | undefined;
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let hasToolCalls = false;

  try {
    const response = await model.sendRequest(vsMessages, options, cts.token);

    if (stream) {
      const result = await handleStream(res, response, modelId, cts.token);
      usage = result.usage;
      hasToolCalls = result.hasToolCalls;
    } else {
      const result = await handleNonStream(res, response, modelId);
      usage = result.usage;
      hasToolCalls = result.hasToolCalls;
    }
  } catch (err: any) {
    error = err.message;
    if (cts.token.isCancellationRequested) {
      log('DEBUG', `Request ${requestId} cancelled`);
      if (!res.writableEnded) { res.end(); }
      return;
    }
    throw err;
  } finally {
    // Record metric for every completed request
    recordRequest({
      timestamp: startTime,
      model: modelId,
      streaming: !!stream,
      durationMs: Date.now() - startTime,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      hasToolCalls,
      error,
    });
    updateMetricsBar();
    refreshPanel();

    cts.dispose();
    activeRequests.delete(requestId);
  }
}

// --- Model Resolution ---

async function resolveModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
  let models = await vscode.lm.selectChatModels({ id: modelId });
  if (models.length > 0) { return models[0]; }

  models = await vscode.lm.selectChatModels({ family: modelId });
  if (models.length > 0) { return models[0]; }

  return undefined;
}

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}

function mapErrorStatus(err: any): number {
  if (err instanceof vscode.LanguageModelError) {
    if (err.code === 'NoPermissions' || err.code === 'Blocked') { return 403; }
    if (err.code === 'NotFound') { return 404; }
  }
  return 500;
}

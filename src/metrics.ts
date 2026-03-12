// Copyright (c) 2026 Ilayanambi Ponramu. MIT License.

/**
 * Usage Metrics Tracker (Persistent)
 *
 * Metrics are persisted to VS Code's globalState so they survive across
 * sessions and VS Code restarts. The webview dashboard defaults to today's
 * view and supports date range filtering for historical analysis.
 *
 * Storage key: "copilotApiProxy.metrics"
 * Format: JSON array of RequestMetric objects
 * Retention: last 1000 requests (auto-pruned on save)
 */

import * as vscode from 'vscode';

// --- Types ---

export interface RequestMetric {
  timestamp: number;
  model: string;
  streaming: boolean;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasToolCalls: boolean;
  error?: string;
}

interface ModelStats {
  requests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  p95DurationMs: number;
  errors: number;
  streamCount: number;
  toolCallCount: number;
  durations: number[];
}

interface HourlyStat {
  hour: string;
  requests: number;
  tokens: number;
}

// --- Constants ---

const STORAGE_KEY = 'copilotApiProxy.metrics';
const MAX_HISTORY = 1000;

// --- State ---

let extensionState: vscode.Memento | undefined;
let allHistory: RequestMetric[] = [];
let sessionStartTime = Date.now();
let sessionStartIndex = 0;

// --- Initialization ---

export function initMetrics(globalState: vscode.Memento) {
  extensionState = globalState;
  allHistory = globalState.get<RequestMetric[]>(STORAGE_KEY, []);
  sessionStartTime = Date.now();
  sessionStartIndex = allHistory.length;
}

// --- Public API ---

export function recordRequest(metric: RequestMetric) {
  allHistory.push(metric);
  if (allHistory.length > MAX_HISTORY) {
    const removed = allHistory.length - MAX_HISTORY;
    allHistory = allHistory.slice(removed);
    sessionStartIndex = Math.max(0, sessionStartIndex - removed);
  }
  extensionState?.update(STORAGE_KEY, allHistory);
}

export function markSessionStart() {
  sessionStartTime = Date.now();
  sessionStartIndex = allHistory.length;
}

export function clearMetrics() {
  allHistory = [];
  sessionStartIndex = 0;
  sessionStartTime = Date.now();
  extensionState?.update(STORAGE_KEY, []);
}

export function getSummary(): { requests: number; tokens: number; errors: number } {
  const session = allHistory.slice(sessionStartIndex);
  let tokens = 0;
  let errors = 0;
  for (const m of session) {
    tokens += m.totalTokens;
    if (m.error) { errors++; }
  }
  return { requests: session.length, tokens, errors };
}

// --- Filtering ---

function filterByDateRange(data: RequestMetric[], startMs: number, endMs: number): RequestMetric[] {
  return data.filter(r => r.timestamp >= startMs && r.timestamp <= endMs);
}

function computeSummary(data: RequestMetric[]): {
  requests: number; tokens: number; errors: number;
  avgLatency: number; p95Latency: number;
  streamCount: number; toolCallCount: number;
} {
  if (data.length === 0) {
    return { requests: 0, tokens: 0, errors: 0, avgLatency: 0, p95Latency: 0, streamCount: 0, toolCallCount: 0 };
  }
  let tokens = 0, errors = 0, totalDuration = 0, streamCount = 0, toolCallCount = 0;
  const durations: number[] = [];
  for (const m of data) {
    tokens += m.totalTokens;
    if (m.error) { errors++; }
    totalDuration += m.durationMs;
    durations.push(m.durationMs);
    if (m.streaming) { streamCount++; }
    if (m.hasToolCalls) { toolCallCount++; }
  }
  durations.sort((a, b) => a - b);
  const p95Idx = Math.min(Math.floor(durations.length * 0.95), durations.length - 1);
  return {
    requests: data.length,
    tokens,
    errors,
    avgLatency: totalDuration / data.length,
    p95Latency: durations[p95Idx],
    streamCount,
    toolCallCount,
  };
}

// --- Webview Panel ---

let panel: vscode.WebviewPanel | undefined;

export function showMetricsPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal();
    panel.webview.html = buildHtml();
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'copilotApiProxyMetrics',
    'Copilot LLM Proxy Metrics',
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  panel.webview.html = buildHtml();

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg.command === 'clearMetrics') {
      clearMetrics();
      panel!.webview.html = buildHtml();
    } else if (msg.command === 'filterRange') {
      panel!.webview.html = buildHtml(msg.startDate, msg.endDate);
    }
  }, null, context.subscriptions);

  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
}

export function refreshPanel() {
  if (panel) {
    panel.webview.html = buildHtml();
  }
}

// --- HTML Builder ---

function buildHtml(startDate?: string, endDate?: string): string {
  const todayStr = toDateStr(new Date());
  const rangeStart = startDate || todayStr;
  const rangeEnd = endDate || todayStr;

  const startMs = new Date(rangeStart + 'T00:00:00').getTime();
  const endMs = new Date(rangeEnd + 'T23:59:59.999').getTime();
  const filtered = filterByDateRange(allHistory, startMs, endMs);
  const summary = computeSummary(filtered);
  const perModel = getPerModelStats(filtered);
  const hourly = getHourlyStats(filtered);
  const requests = filtered.slice(-100).reverse();

  const isToday = rangeStart === todayStr && rangeEnd === todayStr;
  const rangeLabel = isToday ? 'Today' : rangeStart === rangeEnd
    ? new Date(rangeStart).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : `${rangeStart} to ${rangeEnd}`;

  // Date range for inputs
  const firstDate = allHistory.length > 0 ? toDateStr(new Date(allHistory[0].timestamp)) : todayStr;

  const topModel = perModel.length > 0 ? perModel[0] : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    line-height: 1.5;
    max-width: 1100px;
    margin: 0 auto;
  }
  h1 { font-size: 1.4em; margin: 0 0 4px; }
  h2 { font-size: 1.05em; margin: 24px 0 10px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .header-left { }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; }

  /* Date range controls */
  .date-controls {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1));
    padding: 8px 12px; border-radius: 6px;
  }
  .date-controls label { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .date-controls input[type="date"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
    padding: 3px 6px; border-radius: 4px; font-size: 0.85em;
  }
  .preset-btn {
    padding: 3px 10px; border-radius: 4px; font-size: 0.8em; cursor: pointer;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-widget-border);
  }
  .preset-btn:hover, .preset-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .apply-btn {
    padding: 3px 12px; border-radius: 4px; font-size: 0.85em; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none;
  }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1));
    border-radius: 8px; padding: 14px 18px; text-align: center;
  }
  .card-value { font-size: 1.8em; font-weight: bold; line-height: 1.2; }
  .card-label { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .card-sub { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-top: 4px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border); }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:hover td { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.05)); }

  /* Tags */
  .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 0.8em; }
  .tag-stream { background: #2d6a4f22; color: #52b788; }
  .tag-sync { background: #3a86ff22; color: #3a86ff; }
  .tag-error { background: #e5383b22; color: #e5383b; }
  .tag-tools { background: #f4a26122; color: #f4a261; }
  .tag-think { background: #9b5de522; color: #9b5de5; }

  /* Bar chart */
  .bar-chart { margin: 8px 0; }
  .bar-row { display: flex; align-items: center; margin: 3px 0; gap: 8px; }
  .bar-label { min-width: 50px; font-size: 0.8em; color: var(--vscode-descriptionForeground); text-align: right; font-variant-numeric: tabular-nums; }
  .bar-track { flex: 1; height: 22px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.1)); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; display: flex; align-items: center; padding: 0 8px; min-width: 2px; }
  .bar-fill-req { background: var(--vscode-button-background); }
  .bar-fill-tok { background: #52b788; }
  .bar-value { font-size: 0.7em; color: var(--vscode-button-foreground); white-space: nowrap; }
  .bar-legend { display: flex; gap: 16px; margin-bottom: 8px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .bar-legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 12px 0; }
  .section-row { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 700px) { .section-row { grid-template-columns: 1fr; } }
  .clear-btn {
    margin-top: 16px; padding: 6px 16px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em;
  }
  .clear-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .muted { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>Copilot LLM Proxy Metrics</h1>
      <div class="subtitle">${rangeLabel} &nbsp;&middot;&nbsp; ${escHtml(String(allHistory.length))} total requests stored</div>
    </div>
    <div class="date-controls">
      <button class="preset-btn ${isToday ? 'active' : ''}" data-preset="today">Today</button>
      <button class="preset-btn" data-preset="7d">7 Days</button>
      <button class="preset-btn" data-preset="30d">30 Days</button>
      <button class="preset-btn" data-preset="all">All Time</button>
      <span class="muted">|</span>
      <label>From</label>
      <input type="date" id="startDate" value="${rangeStart}" min="${firstDate}" max="${todayStr}">
      <label>To</label>
      <input type="date" id="endDate" value="${rangeEnd}" min="${firstDate}" max="${todayStr}">
      <button class="apply-btn" id="applyRange">Apply</button>
    </div>
  </div>

  <!-- Summary Cards -->
  <div class="cards">
    <div class="card">
      <div class="card-value">${summary.requests}</div>
      <div class="card-label">Requests</div>
      <div class="card-sub">${summary.streamCount} stream &middot; ${summary.requests - summary.streamCount} sync</div>
    </div>
    <div class="card">
      <div class="card-value">${formatNumber(summary.tokens)}</div>
      <div class="card-label">Est. Tokens</div>
    </div>
    <div class="card">
      <div class="card-value">${summary.avgLatency > 0 ? summary.avgLatency.toFixed(0) : '—'}<span style="font-size:0.5em"> ms</span></div>
      <div class="card-label">Avg Latency</div>
      <div class="card-sub">p95: ${summary.p95Latency > 0 ? summary.p95Latency.toFixed(0) + ' ms' : '—'}</div>
    </div>
    <div class="card">
      <div class="card-value">${summary.toolCallCount}</div>
      <div class="card-label">Tool Calls</div>
    </div>
    <div class="card">
      <div class="card-value">${summary.errors}</div>
      <div class="card-label">Errors</div>
      <div class="card-sub">${summary.requests > 0 ? ((summary.errors / summary.requests) * 100).toFixed(1) : '0'}% error rate</div>
    </div>
    <div class="card">
      <div class="card-value">${topModel ? escHtml(shortModel(topModel[0])) : '—'}</div>
      <div class="card-label">Top Model</div>
      <div class="card-sub">${topModel ? topModel[1].requests + ' requests' : ''}</div>
    </div>
  </div>

  <!-- Hourly Activity + Model Breakdown side by side -->
  <div class="section-row">
    <div>
      <h2>Hourly Activity</h2>
      ${renderHourlyChart(hourly)}
    </div>
    <div>
      <h2>Models</h2>
      ${renderModelTable(perModel)}
    </div>
  </div>

  <!-- Request Log -->
  <h2>Requests ${requests.length > 0 ? `<span class="muted" style="font-weight:normal;font-size:0.85em">(last ${Math.min(requests.length, 100)})</span>` : ''}</h2>
  ${requests.length === 0 ? '<div class="empty">No requests in this range.</div>' : `
  <table>
    <tr><th>Time</th><th>Model</th><th>Type</th><th>Tokens</th><th>Latency</th><th>Status</th></tr>
    ${requests.map(r => `
    <tr>
      <td>${formatDateTime(r.timestamp)}</td>
      <td><code>${escHtml(shortModel(r.model))}</code></td>
      <td>
        ${r.streaming ? '<span class="tag tag-stream">stream</span>' : '<span class="tag tag-sync">sync</span>'}
        ${r.hasToolCalls ? ' <span class="tag tag-tools">tools</span>' : ''}
      </td>
      <td>${formatNumber(r.totalTokens)}</td>
      <td>${r.durationMs.toFixed(0)} ms</td>
      <td>${r.error ? `<span class="tag tag-error">${escHtml(r.error.substring(0, 40))}</span>` : '<span class="muted">OK</span>'}</td>
    </tr>`).join('')}
  </table>`}

  <button class="clear-btn" id="clearBtn">Clear All History</button>

  <script>
    const vscode = acquireVsCodeApi();
    const today = '${todayStr}';
    const firstDate = '${firstDate}';

    // Presets
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        let start, end = today;
        if (preset === 'today') { start = today; }
        else if (preset === '7d') { start = offsetDate(today, -6); }
        else if (preset === '30d') { start = offsetDate(today, -29); }
        else if (preset === 'all') { start = firstDate; }
        document.getElementById('startDate').value = start;
        document.getElementById('endDate').value = end;
        vscode.postMessage({ command: 'filterRange', startDate: start, endDate: end });
      });
    });

    // Apply
    document.getElementById('applyRange').addEventListener('click', () => {
      const start = document.getElementById('startDate').value;
      const end = document.getElementById('endDate').value;
      vscode.postMessage({ command: 'filterRange', startDate: start, endDate: end });
    });

    // Clear
    document.getElementById('clearBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'clearMetrics' });
    });

    function offsetDate(dateStr, days) {
      const d = new Date(dateStr);
      d.setDate(d.getDate() + days);
      return d.toISOString().split('T')[0];
    }
  </script>
</body>
</html>`;
}

// --- Render Helpers ---

function renderModelTable(perModel: [string, ModelStats][]): string {
  if (perModel.length === 0) {
    return '<div class="empty">No data.</div>';
  }
  return `
  <table>
    <tr><th>Model</th><th>Req</th><th>Tokens</th><th>Avg</th><th>p95</th><th>Err</th></tr>
    ${perModel.map(([model, s]) => `
    <tr>
      <td><code>${escHtml(shortModel(model))}</code></td>
      <td>${s.requests}</td>
      <td>${formatNumber(s.totalTokens)}</td>
      <td>${s.avgDurationMs.toFixed(0)} ms</td>
      <td>${s.p95DurationMs.toFixed(0)} ms</td>
      <td>${s.errors > 0 ? `<span class="tag tag-error">${s.errors}</span>` : '<span class="muted">0</span>'}</td>
    </tr>`).join('')}
  </table>`;
}

function renderHourlyChart(hourly: HourlyStat[]): string {
  if (hourly.length === 0) {
    return '<div class="empty">No data.</div>';
  }
  const maxReqs = Math.max(...hourly.map(h => h.requests), 1);
  return `
  <div class="bar-chart">
    ${hourly.map(h => `
    <div class="bar-row">
      <div class="bar-label">${h.hour}</div>
      <div class="bar-track">
        <div class="bar-fill bar-fill-req" style="width: ${Math.max((h.requests / maxReqs * 100), 2).toFixed(1)}%">
          <span class="bar-value">${h.requests} req &middot; ${formatNumber(h.tokens)} tok</span>
        </div>
      </div>
    </div>`).join('')}
  </div>`;
}

// --- Stats Helpers ---

function getPerModelStats(data: RequestMetric[]): [string, ModelStats][] {
  const map = new Map<string, ModelStats>();
  for (const r of data) {
    let s = map.get(r.model);
    if (!s) {
      s = { requests: 0, totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0,
            avgDurationMs: 0, p95DurationMs: 0, errors: 0,
            streamCount: 0, toolCallCount: 0, durations: [] };
      map.set(r.model, s);
    }
    s.requests++;
    s.totalPromptTokens += r.promptTokens;
    s.totalCompletionTokens += r.completionTokens;
    s.totalTokens += r.totalTokens;
    s.avgDurationMs += r.durationMs;
    s.durations.push(r.durationMs);
    if (r.error) { s.errors++; }
    if (r.streaming) { s.streamCount++; }
    if (r.hasToolCalls) { s.toolCallCount++; }
  }
  for (const s of map.values()) {
    s.avgDurationMs = s.requests > 0 ? s.avgDurationMs / s.requests : 0;
    s.durations.sort((a, b) => a - b);
    const p95Idx = Math.min(Math.floor(s.durations.length * 0.95), s.durations.length - 1);
    s.p95DurationMs = s.durations[p95Idx] || 0;
  }
  return [...map.entries()].sort((a, b) => b[1].requests - a[1].requests);
}

function getHourlyStats(data: RequestMetric[]): HourlyStat[] {
  const map = new Map<number, { requests: number; tokens: number }>();
  for (const r of data) {
    const hour = new Date(r.timestamp).getHours();
    let h = map.get(hour);
    if (!h) { h = { requests: 0, tokens: 0 }; map.set(hour, h); }
    h.requests++;
    h.tokens += r.totalTokens;
  }

  // Only return hours that have data, in order
  const hours = [...map.keys()].sort((a, b) => a - b);
  return hours.map(hour => {
    const h = map.get(hour)!;
    const label = `${hour.toString().padStart(2, '0')}:00`;
    return { hour: label, requests: h.requests, tokens: h.tokens };
  });
}

// --- Format Helpers ---

function toDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString()}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'K'; }
  return n.toString();
}

/** Shorten model IDs like "copilot-gpt-4o-2024" → "gpt-4o-2024" */
function shortModel(model: string): string {
  return model.replace(/^copilot-/, '');
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

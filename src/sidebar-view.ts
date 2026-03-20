// ─── Sidebar WebView ─────────────────────────────────────────────────────────
// [Fork-only] Provides a sidebar view for Agent Manager mode.
// This module is NOT part of the upstream project.
//
// Unlike the upstream webview-panel.ts (which creates a panel in the editor area),
// this creates a WebviewView in the sidebar — visible even in Agent Manager mode
// where the editor area is hidden.

import * as vscode from 'vscode';
import { ContextUsage } from './tracker';
import { ModelConfig, UserStatusInfo } from './models';

// ─── View Provider ────────────────────────────────────────────────────────────

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'antigravity-context-monitor.sidebarView';

    private view?: vscode.WebviewView;
    private usage: ContextUsage | null = null;
    private allUsages: ContextUsage[] = [];
    private configs: ModelConfig[] = [];
    private userInfo: UserStatusInfo | null = null;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.buildHtml();

        webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
            if (msg.command === 'refresh') {
                vscode.commands.executeCommand('antigravity-context-monitor.refresh');
            } else if (msg.command === 'exportConversation') {
                vscode.commands.executeCommand('antigravity-context-monitor.exportConversation');
            } else if (msg.command === 'openDumpFolder') {
                vscode.commands.executeCommand('antigravity-context-monitor.openDumpFolder');
            } else if (msg.command === 'showDetails') {
                vscode.commands.executeCommand('antigravity-context-monitor.showDetails');
            }
        });
    }

    /** Update sidebar with latest data. */
    update(
        usage: ContextUsage | null,
        allUsages: ContextUsage[],
        configs: ModelConfig[],
        userInfo: UserStatusInfo | null,
    ): void {
        this.usage = usage;
        this.allUsages = allUsages;
        this.configs = configs;
        this.userInfo = userInfo;
        if (this.view) {
            this.view.webview.html = this.buildHtml();
        }
    }

    // ─── HTML Builder ─────────────────────────────────────────────────────

    private buildHtml(): string {
        const usage = this.usage;
        const userInfo = this.userInfo;
        const configs = this.configs;
        const allUsages = this.allUsages;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${this.getStyles()}</style>
</head>
<body>
    ${this.buildAccountSection(userInfo)}
    ${this.buildQuotaSection(configs)}
    ${this.buildCurrentSessionSection(usage)}
    ${this.buildOtherSessionsSection(allUsages, usage)}
    ${this.buildActionsSection()}
    <script>${this.getScript()}</script>
</body>
</html>`;
    }

    private buildAccountSection(userInfo: UserStatusInfo | null): string {
        if (!userInfo) { return ''; }

        const promptPct = userInfo.monthlyPromptCredits > 0
            ? Math.round((userInfo.availablePromptCredits / userInfo.monthlyPromptCredits) * 100) : 0;
        const flowPct = userInfo.monthlyFlowCredits > 0
            ? Math.round((userInfo.availableFlowCredits / userInfo.monthlyFlowCredits) * 100) : 0;

        return `
        <div class="section">
            <div class="section-title">👤 ${esc(userInfo.planName)} ${userInfo.userTierName ? `· ${esc(userInfo.userTierName)}` : ''}</div>
            <div class="credit-row">
                <span>Prompt</span>
                <div class="bar-wrap"><div class="bar" style="width:${promptPct}%;background:${barColor(promptPct)}"></div></div>
                <span class="pct">${promptPct}%</span>
            </div>
            <div class="credit-row">
                <span>Flow</span>
                <div class="bar-wrap"><div class="bar" style="width:${flowPct}%;background:${barColor(flowPct)}"></div></div>
                <span class="pct">${flowPct}%</span>
            </div>
        </div>`;
    }

    private buildQuotaSection(configs: ModelConfig[]): string {
        const quotaModels = configs.filter(c => c.quotaInfo);
        if (quotaModels.length === 0) { return ''; }

        const rows = quotaModels.map(c => {
            const qi = c.quotaInfo!;
            const pct = Math.round(qi.remainingFraction * 100);
            let resetLabel = '';
            if (qi.resetTime) {
                try {
                    const d = new Date(qi.resetTime);
                    const now = new Date();
                    const diffMs = d.getTime() - now.getTime();
                    if (diffMs > 0) {
                        const h = Math.floor(diffMs / 3600000);
                        const m = Math.floor((diffMs % 3600000) / 60000);
                        resetLabel = `⏳${h}h${m}m`;
                    }
                } catch { /* ignore */ }
            }
            return `
            <div class="quota-row">
                <span class="quota-label">${esc(c.label)}</span>
                <div class="bar-wrap"><div class="bar" style="width:${pct}%;background:${barColor(pct)}"></div></div>
                <span class="pct">${pct}%</span>
                ${resetLabel ? `<span class="reset">${resetLabel}</span>` : ''}
            </div>`;
        }).join('');

        return `
        <div class="section">
            <div class="section-title">⚡ 模型配额</div>
            ${rows}
        </div>`;
    }

    private buildCurrentSessionSection(usage: ContextUsage | null): string {
        if (!usage) {
            return `
            <div class="section empty">
                <div class="section-title">🕐 等待会话...</div>
                <div class="hint">在 Antigravity 中开始对话即可查看</div>
            </div>`;
        }

        const pct = Math.min(usage.usagePercent, 100);
        const remaining = Math.max(0, usage.contextLimit - usage.contextUsed);

        return `
        <div class="section">
            <div class="section-title">🕐 当前会话</div>
            <div class="kv"><span>模型</span><span class="val">${esc(usage.modelDisplayName)}</span></div>
            <div class="kv"><span>会话</span><span class="val title-val">${esc(usage.title || usage.cascadeId.substring(0, 8))}</span></div>
            <div class="kv"><span>状态</span><span class="badge">${esc(usage.status.replace('CASCADE_RUN_STATUS_', ''))}</span></div>
            <div class="progress-section">
                <div class="progress-header">
                    <span>上下文</span>
                    <span class="pct-large">${usage.usagePercent.toFixed(1)}%</span>
                </div>
                <div class="bar-wrap large"><div class="bar" style="width:${pct}%;background:${barColor(100 - pct)}"></div></div>
                <div class="progress-detail">
                    ${fmtTokens(usage.contextUsed)} / ${fmtTokens(usage.contextLimit)}
                    <span class="dim">剩余 ${fmtTokens(remaining)}</span>
                </div>
            </div>
            <div class="stats-row">
                <div class="stat"><div class="stat-label">步骤</div><div class="stat-val">${usage.stepCount}</div></div>
                <div class="stat"><div class="stat-label">输出</div><div class="stat-val">${fmtTokens(usage.totalOutputTokens)}</div></div>
                <div class="stat"><div class="stat-label">工具</div><div class="stat-val">${fmtTokens(usage.totalToolCallOutputTokens)}</div></div>
            </div>
            ${usage.compressionDetected ? '<div class="compress-alert">🗜️ 压缩已触发</div>' : ''}
            ${usage.lastModelUsage ? `
            <div class="checkpoint">
                <div class="checkpoint-label">最近检查点</div>
                <div class="stats-row">
                    <div class="stat"><div class="stat-label">输入</div><div class="stat-val">${usage.lastModelUsage.inputTokens.toLocaleString()}</div></div>
                    <div class="stat"><div class="stat-label">输出</div><div class="stat-val">${usage.lastModelUsage.outputTokens.toLocaleString()}</div></div>
                    <div class="stat"><div class="stat-label">缓存</div><div class="stat-val">${usage.lastModelUsage.cacheReadTokens.toLocaleString()}</div></div>
                </div>
            </div>` : ''}
            ${usage.isEstimated ? '<div class="hint">⚠️ 估算值</div>' : '<div class="hint">✓ 精确值</div>'}
        </div>`;
    }

    private buildOtherSessionsSection(allUsages: ContextUsage[], currentUsage: ContextUsage | null): string {
        const others = allUsages.filter(u => u.cascadeId !== currentUsage?.cascadeId);
        if (others.length === 0) { return ''; }

        const rows = others.slice(0, 5).map(u => {
            const pct = Math.min(u.usagePercent, 100);
            return `
            <div class="other-session">
                <div class="other-header">
                    <span class="other-title">${esc(u.title || u.cascadeId.substring(0, 8))}</span>
                    <span class="pct">${u.usagePercent.toFixed(0)}%</span>
                </div>
                <div class="bar-wrap small"><div class="bar" style="width:${pct}%;background:${barColor(100 - pct)}"></div></div>
            </div>`;
        }).join('');

        return `
        <div class="section">
            <div class="section-title">💬 其他会话 (${others.length})</div>
            ${rows}
        </div>`;
    }

    private buildActionsSection(): string {
        return `
        <div class="section actions">
            <button class="action-btn" data-cmd="refresh">🔄 刷新</button>
            <button class="action-btn" data-cmd="exportConversation">📤 导出对话</button>
            <button class="action-btn" data-cmd="openDumpFolder">📂 Dump 目录</button>
            <button class="action-btn" data-cmd="showDetails">📊 完整面板</button>
        </div>`;
    }

    // ─── Styles ───────────────────────────────────────────────────────────

    private getStyles(): string {
        return `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
            font-size: 12px;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background, transparent);
            padding: 8px;
            line-height: 1.4;
        }

        .section {
            background: var(--vscode-editorWidget-background, rgba(255,255,255,0.04));
            border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.08));
            border-radius: 6px;
            padding: 10px;
            margin-bottom: 8px;
        }
        .section.empty { opacity: 0.6; text-align: center; }
        .section-title {
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
            opacity: 0.85;
        }

        /* Key-Value rows */
        .kv {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 2px 0;
            font-size: 11px;
        }
        .kv span:first-child { opacity: 0.65; }
        .val { font-weight: 500; }
        .title-val {
            max-width: 140px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .badge {
            font-size: 9px;
            padding: 1px 5px;
            border-radius: 3px;
            background: rgba(255,255,255,0.08);
            font-weight: 500;
        }

        /* Progress bars */
        .bar-wrap {
            flex: 1;
            height: 6px;
            background: rgba(255,255,255,0.08);
            border-radius: 3px;
            margin: 0 6px;
            overflow: hidden;
        }
        .bar-wrap.large { height: 8px; margin: 4px 0; border-radius: 4px; }
        .bar-wrap.small { height: 4px; margin: 2px 0; }
        .bar {
            height: 100%;
            border-radius: inherit;
            transition: width 0.4s ease;
        }

        /* Credits */
        .credit-row, .quota-row {
            display: flex;
            align-items: center;
            font-size: 11px;
            padding: 3px 0;
            gap: 4px;
        }
        .credit-row span:first-child, .quota-label { 
            min-width: 40px; 
            opacity: 0.65;
            font-size: 10px;
        }
        .pct { 
            min-width: 28px; 
            text-align: right; 
            font-weight: 600; 
            font-size: 10px;
        }
        .reset {
            font-size: 9px;
            opacity: 0.5;
        }

        /* Progress section */
        .progress-section { margin: 6px 0 4px; }
        .progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2px;
        }
        .progress-header span:first-child { font-size: 11px; opacity: 0.65; }
        .pct-large { font-size: 16px; font-weight: 700; }
        .progress-detail {
            font-size: 10px;
            opacity: 0.5;
            margin-top: 2px;
        }
        .dim { margin-left: 4px; }

        /* Stats grid */
        .stats-row {
            display: flex;
            gap: 4px;
            margin-top: 6px;
        }
        .stat {
            flex: 1;
            text-align: center;
            padding: 4px 2px;
            background: rgba(255,255,255,0.04);
            border-radius: 4px;
        }
        .stat-label { font-size: 9px; opacity: 0.5; text-transform: uppercase; }
        .stat-val { font-size: 12px; font-weight: 600; margin-top: 1px; }

        /* Compression */
        .compress-alert {
            margin-top: 6px;
            padding: 4px 8px;
            background: rgba(239,68,68,0.12);
            color: #f87171;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
        }

        /* Checkpoint */
        .checkpoint {
            margin-top: 6px;
            padding-top: 6px;
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .checkpoint-label {
            font-size: 9px;
            opacity: 0.5;
            text-transform: uppercase;
            margin-bottom: 4px;
        }

        /* Other sessions */
        .other-session { margin-bottom: 6px; }
        .other-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
        }
        .other-title {
            max-width: 140px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* Hints */
        .hint {
            font-size: 10px;
            opacity: 0.45;
            margin-top: 4px;
        }

        /* Actions */
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            background: none;
            border: none;
            padding: 0;
        }
        .action-btn {
            flex: 1;
            min-width: calc(50% - 4px);
            padding: 6px 4px;
            font-size: 11px;
            border: 1px solid var(--vscode-widget-border, rgba(255,255,255,0.12));
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, rgba(255,255,255,0.06));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            cursor: pointer;
            transition: background 0.15s;
        }
        .action-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,0.12));
        }
        `;
    }

    // ─── Script ───────────────────────────────────────────────────────────

    private getScript(): string {
        return `
        (function() {
            var vscode = acquireVsCodeApi();
            document.querySelectorAll('.action-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    vscode.postMessage({ command: this.dataset.cmd });
                });
            });
        })();
        `;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function barColor(pctRemaining: number): string {
    if (pctRemaining <= 20) { return '#ef4444'; }
    if (pctRemaining <= 50) { return '#eab308'; }
    return '#22c55e';
}

function fmtTokens(n: number): string {
    if (n >= 1_000_000) { return (n / 1_000_000).toFixed(1) + 'M'; }
    if (n >= 1_000) { return (n / 1_000).toFixed(0) + 'k'; }
    return n.toString();
}

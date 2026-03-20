// ─── Fork Entry Point ────────────────────────────────────────────────────────
// [Fork-only] Wraps the upstream extension entry point to add context dump.
//
// ZERO changes to upstream extension.ts — this file:
// 1. Re-exports upstream's activate/deactivate
// 2. Wraps activate() to inject dump commands and auto-dump polling
// 3. Only file that needs `main` field change in package.json
//
// To revert the fork: change package.json "main" back to "./out/extension.js"
// and delete this file + context-dumper.ts. That's it.

import * as vscode from 'vscode';
import * as originalExtension from './extension';
import { discoverLanguageServer, LSInfo } from './discovery';
import { getAllTrajectories, getContextUsage, normalizeUri, ContextUsage } from './tracker';
import { dumpConversation, forceDumpConversation, resetDumpState, getDumpDir } from './context-dumper';
import { CascadeStatus, STEP_BATCH_SIZE } from './constants';

// ─── Fork State ───────────────────────────────────────────────────────────────

let dumpEnabled = true;
let dumpTimer: NodeJS.Timeout | undefined;
let dumpAbortController = new AbortController();
let forkOutputChannel: vscode.OutputChannel | undefined;
let cachedLsForDump: LSInfo | null = null;

/** Dump polling interval — slower than the main extension to avoid doubling RPC load. */
const DUMP_POLL_INTERVAL_MS = 15_000; // 15 seconds

// ─── Activation Wrapper ──────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
    // 1. Call upstream activate — everything works as before
    originalExtension.activate(context);

    // 2. Fork additions
    dumpAbortController = new AbortController();
    forkOutputChannel = vscode.window.createOutputChannel('Context Dump (Fork)');
    forkLog('Fork entry point activated — context dump enabled');

    // Register dump commands
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-context-monitor.exportConversation', async () => {
            await manualExport(context);
        }),
        vscode.commands.registerCommand('antigravity-context-monitor.toggleDump', () => {
            dumpEnabled = !dumpEnabled;
            const state = dumpEnabled ? 'ON' : 'OFF';
            vscode.window.showInformationMessage(`Context auto-dump: ${state}`);
            forkLog(`Auto-dump toggled: ${state}`);
            if (dumpEnabled) {
                scheduleDumpPoll();
            } else if (dumpTimer) {
                clearTimeout(dumpTimer);
                dumpTimer = undefined;
            }
        }),
        vscode.commands.registerCommand('antigravity-context-monitor.openDumpFolder', () => {
            const dir = getDumpDir();
            vscode.env.openExternal(vscode.Uri.file(dir));
        }),
    );

    // Cleanup on dispose
    context.subscriptions.push({
        dispose: () => {
            if (dumpTimer) {
                clearTimeout(dumpTimer);
                dumpTimer = undefined;
            }
            dumpAbortController.abort();
            resetDumpState();
        },
    });

    if (forkOutputChannel) {
        context.subscriptions.push(forkOutputChannel);
    }

    // 3. Start dump polling (independent of main extension's polling)
    scheduleDumpPoll();
}

export function deactivate(): void {
    // Cleanup fork state
    if (dumpTimer) {
        clearTimeout(dumpTimer);
        dumpTimer = undefined;
    }
    dumpAbortController.abort();
    resetDumpState();

    // Call upstream deactivate
    originalExtension.deactivate();
}

// ─── Dump Polling ─────────────────────────────────────────────────────────────

function scheduleDumpPoll(): void {
    if (!dumpEnabled) { return; }
    dumpTimer = setTimeout(async () => {
        try {
            await dumpPollCycle();
        } catch (err) {
            forkLog(`Dump poll error: ${err}`);
        } finally {
            scheduleDumpPoll();
        }
    }, DUMP_POLL_INTERVAL_MS);
}

async function dumpPollCycle(): Promise<void> {
    if (!dumpEnabled) { return; }

    const workspaceUri = getWorkspaceUri();
    const signal = dumpAbortController.signal;

    // Discover LS (independent cache from main extension)
    if (!cachedLsForDump) {
        cachedLsForDump = await discoverLanguageServer(workspaceUri, signal);
        if (!cachedLsForDump) { return; }
        forkLog(`LS discovered for dump: port=${cachedLsForDump.port}`);
    }

    try {
        // Get trajectories
        const trajectories = await getAllTrajectories(cachedLsForDump, signal);
        if (trajectories.length === 0) { return; }

        // Filter to current workspace
        const normalizedWs = workspaceUri ? normalizeUri(workspaceUri) : '(none)';
        const qualified = trajectories.filter(t => {
            if (workspaceUri) {
                return t.workspaceUris.some(u => normalizeUri(u) === normalizedWs);
            }
            return t.workspaceUris.length === 0;
        });

        // Find the most active trajectory (RUNNING first, then most recent)
        const running = qualified.filter(t => t.status === CascadeStatus.RUNNING);
        const target = running.length > 0 ? running[0] : (qualified.length > 0 ? qualified[0] : null);

        if (!target) { return; }

        // Get context usage (reuses upstream's getContextUsage — read-only)
        const config = vscode.workspace.getConfiguration('antigravityContextMonitor');
        const customLimits = config.get<Record<string, number>>('contextLimits');
        const usage = await getContextUsage(cachedLsForDump, target, customLimits, signal);

        // Dump (incremental — only writes if stepCount changed)
        const filePath = await dumpConversation(cachedLsForDump, usage, signal);
        if (filePath) {
            forkLog(`Dumped: ${target.summary?.substring(0, 30)} (${target.stepCount} steps) → ${filePath}`);
        }
    } catch (err) {
        forkLog(`Dump cycle error: ${err}`);
        // Reset LS cache on connection errors — will re-discover next cycle
        cachedLsForDump = null;
    }
}

// ─── Manual Export ────────────────────────────────────────────────────────────

async function manualExport(context: vscode.ExtensionContext): Promise<void> {
    const workspaceUri = getWorkspaceUri();
    const signal = dumpAbortController.signal;

    // Discover LS
    let ls = cachedLsForDump;
    if (!ls) {
        ls = await discoverLanguageServer(workspaceUri, signal);
        if (!ls) {
            vscode.window.showErrorMessage('Language Server not found — cannot export.');
            return;
        }
        cachedLsForDump = ls;
    }

    // Get trajectories for picker
    const trajectories = await getAllTrajectories(ls, signal);
    if (trajectories.length === 0) {
        vscode.window.showInformationMessage('No conversations found.');
        return;
    }

    // Filter to workspace
    const normalizedWs = workspaceUri ? normalizeUri(workspaceUri) : '(none)';
    const qualified = trajectories.filter(t => {
        if (workspaceUri) {
            return t.workspaceUris.some(u => normalizeUri(u) === normalizedWs);
        }
        return t.workspaceUris.length === 0;
    });

    const items = (qualified.length > 0 ? qualified : trajectories).slice(0, 10).map(t => ({
        label: t.summary || t.cascadeId.substring(0, 8),
        description: `${t.stepCount} steps · ${t.status.replace('CASCADE_RUN_STATUS_', '')}`,
        trajectory: t,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select conversation to export',
    });

    if (!selected) { return; }

    const config = vscode.workspace.getConfiguration('antigravityContextMonitor');
    const customLimits = config.get<Record<string, number>>('contextLimits');
    const usage = await getContextUsage(ls, selected.trajectory, customLimits, signal);

    const filePath = await forceDumpConversation(ls, usage, signal);
    const action = await vscode.window.showInformationMessage(
        `Exported: ${filePath}`,
        'Open File',
        'Open Folder',
    );

    if (action === 'Open File') {
        const doc = await vscode.workspace.openTextDocument(filePath);
        vscode.window.showTextDocument(doc);
    } else if (action === 'Open Folder') {
        const dir = getDumpDir();
        vscode.env.openExternal(vscode.Uri.file(dir));
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getWorkspaceUri(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    return folders[0].uri.toString();
}

function forkLog(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    forkOutputChannel?.appendLine(`[${timestamp}] ${message}`);
}

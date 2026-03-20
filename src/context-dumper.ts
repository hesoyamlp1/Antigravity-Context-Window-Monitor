// ─── Context Dumper ──────────────────────────────────────────────────────────
// [Fork-only] Dumps full conversation context to local JSON files.
// This module is NOT part of the upstream project.
//
// Design: ZERO modification to upstream files.
// - Imports rpcCall / LSInfo / ContextUsage as read-only dependencies
// - Has its own step-fetching logic (parallel to tracker.ts)
// - Self-contained: can be deleted to fully revert the fork

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LSInfo } from './discovery';
import { rpcCall } from './rpc-client';
import { ContextUsage } from './tracker';
import { STEP_BATCH_SIZE, MAX_CONCURRENT_BATCHES } from './constants';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DumpedStep {
    index: number;
    type: string;
    userMessage: string | null;
    aiResponse: string | null;
    thinking: string | null;
    toolCalls: Array<{
        functionName: string;
        argumentsJson: string;
    }> | null;
    toolCallOutputTokens: number;
    model: string;
    generatorModel: string;
    checkpoint: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
    } | null;
}

export interface DumpedConversation {
    cascadeId: string;
    title: string;
    model: string;
    modelDisplayName: string;
    stepCount: number;
    contextUsed: number;
    contextLimit: number;
    usagePercent: number;
    status: string;
    createdTime: string;
    lastModifiedTime: string;
    exportedAt: string;
    steps: DumpedStep[];
}

// ─── State ────────────────────────────────────────────────────────────────────

/** Track last dumped stepCount per cascade to avoid redundant I/O. */
const lastDumpedStepCounts = new Map<string, number>();

/** Dump output directory — lazily created. */
let dumpDir: string | null = null;

// ─── Step Fetching (self-contained, mirrors tracker.ts logic) ────────────────

/**
 * Fetch all steps for a cascade directly via RPC.
 * This duplicates getTrajectoryTokenUsage's fetch logic on purpose —
 * to avoid modifying tracker.ts.
 */
async function fetchAllSteps(
    ls: LSInfo,
    cascadeId: string,
    totalSteps: number,
    signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
    const maxSteps = Math.max(totalSteps, 0);
    const allSteps: Array<Record<string, unknown>> = [];

    const batchRanges: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < maxSteps; start += STEP_BATCH_SIZE) {
        batchRanges.push({ start, end: Math.min(start + STEP_BATCH_SIZE, maxSteps) });
    }

    for (let groupStart = 0; groupStart < batchRanges.length; groupStart += MAX_CONCURRENT_BATCHES) {
        const group = batchRanges.slice(groupStart, groupStart + MAX_CONCURRENT_BATCHES);
        const groupResults = await Promise.allSettled(
            group.map(({ start, end }) =>
                rpcCall(ls, 'GetCascadeTrajectorySteps', {
                    cascadeId,
                    startIndex: start,
                    endIndex: end,
                }, 30000, signal)
            )
        );

        for (const result of groupResults) {
            if (result.status === 'fulfilled') {
                const steps = result.value.steps as Array<Record<string, unknown>> | undefined;
                if (steps && steps.length > 0) {
                    allSteps.push(...steps);
                }
            }
        }
    }

    return allSteps;
}

// ─── Step Parsing ─────────────────────────────────────────────────────────────

function parseStep(step: Record<string, unknown>, idx: number): DumpedStep {
    const type = (step.type as string) || '';
    const meta = step.metadata as Record<string, unknown> | undefined;

    // User input
    const ui = step.userInput as Record<string, unknown> | undefined;
    const userMessage = ui ? ((ui.userResponse as string) || '') : null;

    // Planner response
    const pr = step.plannerResponse as Record<string, unknown> | undefined;
    const aiResponse = pr ? ((pr.response as string) || '') : null;
    const thinking = pr ? ((pr.thinking as string) || null) : null;

    // Tool calls
    let toolCalls: DumpedStep['toolCalls'] = null;
    if (pr) {
        const rawToolCalls = pr.toolCalls as Array<Record<string, unknown>> | undefined;
        if (rawToolCalls && rawToolCalls.length > 0) {
            toolCalls = rawToolCalls.map(tc => ({
                functionName: (tc.functionName as string) || (tc.name as string) || '',
                argumentsJson: (tc.argumentsJson as string) || '',
            }));
        }
    }

    // Metadata
    const toolCallOutputTokens = meta ? ((meta.toolCallOutputTokens as number) || 0) : 0;
    const stepModel = meta ? ((meta.generatorModel as string) || '') : '';
    const requestedModel = meta
        ? (((meta.requestedModel as Record<string, unknown>)?.model as string) || '')
        : '';

    // Checkpoint
    let checkpoint: DumpedStep['checkpoint'] = null;
    if (type === 'CORTEX_STEP_TYPE_CHECKPOINT' && meta) {
        const mu = meta.modelUsage as Record<string, unknown> | undefined;
        if (mu) {
            checkpoint = {
                inputTokens: parseInt(String(mu.inputTokens || '0'), 10),
                outputTokens: parseInt(String(mu.outputTokens || '0'), 10),
                cacheReadTokens: parseInt(String(mu.cacheReadTokens || '0'), 10),
            };
        }
    }

    return {
        index: idx,
        type,
        userMessage,
        aiResponse,
        thinking,
        toolCalls,
        toolCallOutputTokens,
        model: requestedModel || stepModel,
        generatorModel: stepModel,
        checkpoint,
    };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get or create the dump directory.
 */
export function getDumpDir(customDir?: string): string {
    if (dumpDir && !customDir) { return dumpDir; }
    dumpDir = customDir || path.join(os.homedir(), '.antigravity-context-dumps');
    if (!fs.existsSync(dumpDir)) {
        fs.mkdirSync(dumpDir, { recursive: true });
    }
    return dumpDir;
}

/**
 * Fetch steps, build structured data, and write to disk.
 * Only writes when stepCount changes (incremental).
 *
 * @returns File path if written, null if skipped.
 */
export async function dumpConversation(
    ls: LSInfo,
    usage: ContextUsage,
    signal?: AbortSignal,
    customDir?: string,
): Promise<string | null> {
    const { cascadeId, stepCount } = usage;

    // Skip if nothing changed
    const lastCount = lastDumpedStepCounts.get(cascadeId);
    if (lastCount !== undefined && lastCount === stepCount) {
        return null;
    }

    // Fetch steps via our own RPC calls (no upstream dependency)
    const rawSteps = await fetchAllSteps(ls, cascadeId, stepCount, signal);

    const conversation: DumpedConversation = {
        cascadeId,
        title: usage.title,
        model: usage.model,
        modelDisplayName: usage.modelDisplayName,
        stepCount: rawSteps.length,
        contextUsed: usage.contextUsed,
        contextLimit: usage.contextLimit,
        usagePercent: usage.usagePercent,
        status: usage.status,
        createdTime: usage.createdTime,
        lastModifiedTime: usage.lastModifiedTime,
        exportedAt: new Date().toISOString(),
        steps: rawSteps.map((s, i) => parseStep(s, i)),
    };

    const dir = getDumpDir(customDir);
    const titleSlug = usage.title
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 50);
    const idPrefix = cascadeId.substring(0, 8);
    const fileName = `${idPrefix}_${titleSlug}.json`;
    const filePath = path.join(dir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
    lastDumpedStepCounts.set(cascadeId, stepCount);

    return filePath;
}

/**
 * Force dump (for manual export command). Always writes with a timestamp.
 */
export async function forceDumpConversation(
    ls: LSInfo,
    usage: ContextUsage,
    signal?: AbortSignal,
    customDir?: string,
): Promise<string> {
    const rawSteps = await fetchAllSteps(ls, usage.cascadeId, usage.stepCount, signal);

    const conversation: DumpedConversation = {
        cascadeId: usage.cascadeId,
        title: usage.title,
        model: usage.model,
        modelDisplayName: usage.modelDisplayName,
        stepCount: rawSteps.length,
        contextUsed: usage.contextUsed,
        contextLimit: usage.contextLimit,
        usagePercent: usage.usagePercent,
        status: usage.status,
        createdTime: usage.createdTime,
        lastModifiedTime: usage.lastModifiedTime,
        exportedAt: new Date().toISOString(),
        steps: rawSteps.map((s, i) => parseStep(s, i)),
    };

    const dir = getDumpDir(customDir);
    const titleSlug = usage.title
        .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 50);
    const idPrefix = usage.cascadeId.substring(0, 8);
    const ts = Date.now();
    const fileName = `${idPrefix}_${titleSlug}_${ts}.json`;
    const filePath = path.join(dir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8');
    lastDumpedStepCounts.set(usage.cascadeId, usage.stepCount);

    return filePath;
}

/** Reset dump state (on deactivate). */
export function resetDumpState(): void {
    lastDumpedStepCounts.clear();
    dumpDir = null;
}

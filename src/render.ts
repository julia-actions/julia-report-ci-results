import { LintDiagnostic, TestMessage, TestitemProfile } from './types';
import { GroupedTestitem, DefinitionErrorWithLocation } from './testResults';
import { NormalizedLocation, PathContext, agnosticMessage, displayPath, githubBlobUrl, normalizeFileUri } from './paths';
import { compressProfileList, formatDuration, isNonFailing, statusEmoji, statusSeverity, worstStatus } from './profiles';

export interface RenderInput {
    grouped: GroupedTestitem[];
    definitionErrors: DefinitionErrorWithLocation[];
    processOutputs: Record<string, string>;
    lint: LintDiagnostic[];
    noResultFiles: boolean;
    ctx: PathContext;
}

export interface RenderOutput {
    markdown: string;
    failOverall: boolean;
    truncated: boolean;
}

export interface BudgetOptions {
    totalBytes: number; // GitHub silently truncates step summaries at 1 MiB
    messageBytes: number; // per failure-message code block, head kept
    outputBytes: number; // per raw-output block, tail kept (failures print last)
    maxLintRows: number;
    maxSummaryRows: number;
}

export const DEFAULT_BUDGET: BudgetOptions = {
    totalBytes: 1_000_000,
    messageBytes: 4_096,
    outputBytes: 16_384,
    maxLintRows: 500,
    maxSummaryRows: 1_000,
};

const TRUNCATION_NOTICE_RESERVE = 256;

export function escapeTableCell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function quoteBlock(s: string): string {
    return '> ' + s.replace(/\n/g, '\n> ');
}

export function truncateHead(s: string, maxBytes: number): string {
    if (Buffer.byteLength(s) <= maxBytes) {
        return s;
    }
    let kept = Buffer.from(s).subarray(0, maxBytes).toString();
    // Drop a possibly mangled trailing character from the byte cut.
    kept = kept.replace(/\uFFFD$/, '');
    const omitted = Buffer.byteLength(s) - Buffer.byteLength(kept);
    return `${kept}\n… [truncated, ${omitted} more bytes]`;
}

export function truncateTail(s: string, maxBytes: number): string {
    if (Buffer.byteLength(s) <= maxBytes) {
        return s;
    }
    const buffer = Buffer.from(s);
    let kept = buffer.subarray(buffer.length - maxBytes).toString();
    kept = kept.replace(/^\uFFFD/, '');
    const omitted = Buffer.byteLength(s) - Buffer.byteLength(kept);
    return `[… ${omitted} bytes omitted] …\n${kept}`;
}

function locationMarkdown(loc: NormalizedLocation, line: number | null, ctx: PathContext): string {
    const label = line === null ? displayPath(loc) : `${displayPath(loc)}:${line}`;
    const url = githubBlobUrl(loc, line, ctx);
    return url === null ? `\`${escapeTableCell(label)}\`` : `[${escapeTableCell(label)}](${url})`;
}

function lintLevelEmoji(level: string): string {
    return level === 'error' ? '❌' : level === 'warning' ? '⚠️' : 'ℹ️';
}

// Byte-budgeted assembly: sections are appended atomically so the summary
// never ends mid-table or mid-<details>.
class Budget {
    private parts: string[] = [];
    private used = 0;
    constructor(private readonly totalBytes: number) {}

    tryAppend(chunk: string): boolean {
        const size = Buffer.byteLength(chunk);
        if (this.used + size > this.totalBytes - TRUNCATION_NOTICE_RESERVE) {
            return false;
        }
        this.parts.push(chunk);
        this.used += size;
        return true;
    }

    forceAppend(chunk: string): void {
        this.parts.push(chunk);
        this.used += Buffer.byteLength(chunk);
    }

    toString(): string {
        return this.parts.join('');
    }
}

interface DeduplicatedMessage {
    location: NormalizedLocation;
    line: number;
    message: string;
    profileNames: string[];
    stackFrames: TestMessage['stack_frames'];
}

function deduplicateMessages(profiles: TestitemProfile[], ctx: PathContext): DeduplicatedMessage[] {
    const byKey = new Map<string, DeduplicatedMessage>();
    for (const profile of profiles) {
        for (const message of profile.messages ?? []) {
            const location = normalizeFileUri(message.uri, ctx);
            const agnostic = agnosticMessage(message.message, ctx);
            const key = `${displayPath(location)} ${message.line} ${agnostic}`;
            const existing = byKey.get(key);
            if (existing === undefined) {
                byKey.set(key, {
                    location,
                    line: message.line,
                    message: agnostic,
                    profileNames: [profile.profile_name],
                    stackFrames: message.stack_frames,
                });
            } else {
                existing.profileNames.push(profile.profile_name);
                if (existing.stackFrames === null) {
                    existing.stackFrames = message.stack_frames;
                }
            }
        }
    }
    return [...byKey.values()];
}

function renderTestitemDetails(ti: GroupedTestitem, input: RenderInput, budget: BudgetOptions): string {
    const { ctx } = input;
    const lines: string[] = [];
    const allPassed = isNonFailing(ti.profiles);
    const emoji = statusEmoji(worstStatus(ti.profiles));

    lines.push(`<details${allPassed ? '' : ' open'}>`);
    lines.push(`<summary>${emoji} <strong>${ti.name}</strong> — <code>${displayPath(ti.location)}</code></summary>`);
    lines.push('');

    if (allPassed) {
        lines.push(`> Passed on all profiles: ${compressProfileList(ti.profiles.map(p => p.profile_name))}`);
    } else {
        const passed = ti.profiles.filter(p => p.status === 'passed');
        const notPassed = ti.profiles.filter(p => p.status !== 'passed');

        if (passed.length > 0) {
            lines.push(`> ✅ **Passed** on: ${compressProfileList(passed.map(p => p.profile_name))}`);
            lines.push('>');
        }

        // Group by status, least severe first.
        const statuses = [...new Set(notPassed.map(p => p.status))].sort(
            (a, b) => statusSeverity(a) - statusSeverity(b)
        );
        for (const status of statuses) {
            const group = notPassed.filter(p => p.status === status);
            lines.push(`> ### ${statusEmoji(status)} ${status.charAt(0).toUpperCase()}${status.slice(1)}`);
            lines.push(`> **Profiles:** ${compressProfileList(group.map(p => p.profile_name))}`);
            lines.push('>');

            for (const msg of deduplicateMessages(group, ctx)) {
                lines.push(`> **${locationMarkdown(msg.location, msg.line, ctx)}** on ${compressProfileList(msg.profileNames)}`);
                lines.push('>');
                lines.push('> ```');
                lines.push(quoteBlock(truncateHead(msg.message, budget.messageBytes)));
                lines.push('> ```');
                lines.push('>');
                if (msg.stackFrames !== null && msg.stackFrames.length > 0) {
                    lines.push('> **Stack trace:**');
                    for (const frame of msg.stackFrames) {
                        const frameLocation = normalizeFileUri(frame.uri, ctx);
                        lines.push(`> - \`${frame.label}\` at ${locationMarkdown(frameLocation, frame.line, ctx)}`);
                    }
                    lines.push('>');
                }
            }
        }

        for (const profile of notPassed) {
            if (profile.output === null || profile.output.trim() === '') {
                continue;
            }
            lines.push('> <details>');
            lines.push(`> <summary>Raw output — ${profile.profile_name.replace(/~/g, '\\~')}</summary>`);
            lines.push('>');
            lines.push('> ```');
            lines.push(quoteBlock(truncateTail(profile.output, budget.outputBytes)));
            lines.push('> ```');
            lines.push('>');
            lines.push('> </details>');
            lines.push('>');
        }
    }

    lines.push('</details>');
    lines.push('');
    return lines.join('\n') + '\n';
}

export function renderSummary(input: RenderInput, budgetOptions: BudgetOptions = DEFAULT_BUDGET): RenderOutput {
    const { grouped, definitionErrors, processOutputs, lint, noResultFiles, ctx } = input;

    const lintErrors = lint.filter(d => d.level === 'error').length;
    const lintWarnings = lint.filter(d => d.level === 'warning').length;

    const numTestitems = grouped.length;
    const numPassed = grouped.filter(ti => isNonFailing(ti.profiles)).length;
    const numFailed = numTestitems - numPassed;

    const failOverall = lintErrors > 0 || numFailed > 0 || definitionErrors.length > 0 || noResultFiles;

    const budget = new Budget(budgetOptions.totalBytes);
    let truncated = false;

    // ── Banner ────────────────────────────────────────────────────────────
    const statsParts: string[] = [`**${numTestitems}** test items`];
    if (numPassed > 0) statsParts.push(`**${numPassed}** passed`);
    if (numFailed > 0) statsParts.push(`**${numFailed}** with issues`);
    if (definitionErrors.length > 0) statsParts.push(`**${definitionErrors.length}** definition errors`);
    if (lint.length > 0) statsParts.push(`**${lint.length}** lint messages`);

    const banner = failOverall ? '# ❌ CI Report — Issues Found' : '# ✅ CI Report — All Checks Passed';
    budget.forceAppend(`${banner}\n> ${statsParts.join(' · ')}\n\n`);

    if (noResultFiles) {
        budget.forceAppend('> ⚠️ **No test result files were found.** This usually means the test jobs failed before writing results or the artifact upload/download broke.\n\n');
    }

    // ── Definition errors ─────────────────────────────────────────────────
    if (definitionErrors.length > 0) {
        const lines = ['## 🚫 Test Definition Errors', '', '| | Location | Message |', '|---|---|---|'];
        for (const e of definitionErrors) {
            lines.push(`| ❌ | ${locationMarkdown(e.location, e.line, ctx)} | ${escapeTableCell(e.message)} |`);
        }
        lines.push('', '');
        if (!budget.tryAppend(lines.join('\n'))) {
            truncated = true;
        }
    }

    // ── Lint results ──────────────────────────────────────────────────────
    if (lint.length > 0) {
        const lintOther = lint.length - lintErrors - lintWarnings;
        const summaryParts: string[] = [];
        if (lintErrors > 0) summaryParts.push(`${lintErrors} error${lintErrors === 1 ? '' : 's'}`);
        if (lintWarnings > 0) summaryParts.push(`${lintWarnings} warning${lintWarnings === 1 ? '' : 's'}`);
        if (lintOther > 0) summaryParts.push(`${lintOther} info`);

        // Errors first, then input order; cap the row count.
        const ordered = [...lint].sort(
            (a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1)
        );
        const shown = ordered.slice(0, budgetOptions.maxLintRows);

        const lines = [
            `<details${lintErrors > 0 ? ' open' : ''}>`,
            `<summary><h2>🔍 Lint Results — ${summaryParts.join(', ')}</h2></summary>`,
            '',
            '| | Severity | Location | Rule | Message |',
            '|---|---|---|---|---|',
        ];
        for (const d of shown) {
            const location: NormalizedLocation =
                d.relPath === null ? { kind: 'external', display: '?' } : { kind: 'repo', relPath: d.relPath };
            const severityLabel = d.level === 'note' ? 'info' : d.level;
            lines.push(
                `| ${lintLevelEmoji(d.level)} | ${severityLabel} | ${locationMarkdown(location, d.line, ctx)} | ${escapeTableCell(d.ruleId)} | ${escapeTableCell(d.message)} |`
            );
        }
        if (shown.length < lint.length) {
            lines.push('', `> … and ${lint.length - shown.length} more lint messages not shown`);
        }
        lines.push('', '</details>', '', '');
        if (!budget.tryAppend(lines.join('\n'))) {
            truncated = true;
        }
    }

    // ── Test summary table ────────────────────────────────────────────────
    if (numTestitems > 0) {
        const shown = grouped.slice(0, budgetOptions.maxSummaryRows);
        const lines = ['## 📋 Test Summary', '', '| | Test Item | File | Duration | Profiles |', '|---|---|---|---|---|'];
        for (const ti of shown) {
            lines.push(
                `| ${statusEmoji(worstStatus(ti.profiles))} | **${escapeTableCell(ti.name)}** | ${escapeTableCell(displayPath(ti.location))} | ${formatDuration(ti.profiles)} | ${escapeTableCell(compressProfileList(ti.profiles.map(p => p.profile_name)))} |`
            );
        }
        if (shown.length < grouped.length) {
            lines.push(`| … | *and ${grouped.length - shown.length} more test items* | | | |`);
        }
        lines.push('', '');
        if (!budget.tryAppend(lines.join('\n'))) {
            truncated = true;
        }
    }

    // ── Detailed results ──────────────────────────────────────────────────
    if (numTestitems > 0) {
        let omitted = 0;
        let headerAppended = budget.tryAppend('## 🔬 Detailed Results\n\n');
        if (headerAppended) {
            for (const ti of grouped) {
                if (omitted > 0 || !budget.tryAppend(renderTestitemDetails(ti, input, budgetOptions))) {
                    omitted += 1;
                }
            }
        } else {
            truncated = true;
            omitted = grouped.length;
        }
        if (omitted > 0) {
            truncated = true;
            budget.forceAppend(
                `> ⚠️ **Report truncated** — ${omitted} test item detail section${omitted === 1 ? '' : 's'} omitted to stay under GitHub's step-summary size limit.\n\n`
            );
        }
    }

    // ── Process outputs ───────────────────────────────────────────────────
    const processIds = Object.keys(processOutputs).filter(id => processOutputs[id].trim() !== '');
    if (processIds.length > 0) {
        const lines: string[] = [];
        for (const id of processIds) {
            lines.push('<details>');
            lines.push(`<summary>🖥️ Test process output — <code>${escapeTableCell(id)}</code></summary>`);
            lines.push('');
            lines.push('```');
            lines.push(truncateTail(processOutputs[id], budgetOptions.outputBytes));
            lines.push('```');
            lines.push('');
            lines.push('</details>');
            lines.push('');
        }
        if (!budget.tryAppend(lines.join('\n') + '\n')) {
            truncated = true;
        }
    }

    return { markdown: budget.toString(), failOverall, truncated };
}

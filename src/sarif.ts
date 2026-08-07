import { LintDiagnostic, LintLevel } from './types';

function toLevel(sarifLevel: unknown): LintLevel {
    // SARIF levels are error/warning/note/none; the spec default is warning.
    switch (sarifLevel) {
        case 'error':
            return 'error';
        case 'note':
        case 'none':
            return 'note';
        default:
            return 'warning';
    }
}

export function parseSarifLog(json: unknown, fileName: string): LintDiagnostic[] {
    const runs = (json as { runs?: unknown[] })?.runs;
    if (!Array.isArray(runs)) {
        throw new Error(`${fileName}: not a SARIF log (missing "runs" array)`);
    }

    const diagnostics: LintDiagnostic[] = [];
    for (const run of runs as Record<string, any>[]) {
        const toolName = run?.tool?.driver?.name ?? 'lint';
        const results = run?.results;
        if (!Array.isArray(results)) {
            continue;
        }
        for (const result of results as Record<string, any>[]) {
            const physical = result?.locations?.[0]?.physicalLocation;
            diagnostics.push({
                level: toLevel(result?.level),
                relPath: physical?.artifactLocation?.uri ?? null,
                line: physical?.region?.startLine ?? null,
                ruleId: result?.ruleId ?? '',
                message: result?.message?.text ?? '',
                toolName,
            });
        }
    }
    return diagnostics;
}

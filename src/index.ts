import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { PathContext } from './paths';
import { parseSarifLog } from './sarif';
import { ResultFile, groupTestitems, mergeResults, normalizeDefinitionErrors, parseTestrunResult } from './testResults';
import { renderSummary } from './render';
import { uploadProcessLogs } from './artifacts';
import { LintDiagnostic } from './types';

function listFiles(directory: string, extensions: string[]): string[] {
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
        return [];
    }
    return fs
        .readdirSync(directory)
        .filter(name => extensions.some(ext => name.toLowerCase().endsWith(ext)))
        .map(name => path.join(directory, name));
}

// Like core.getBooleanInput, but an empty/unset input falls back to the given
// default instead of throwing.
function getBoolInput(name: string, defaultValue: boolean): boolean {
    const raw = core.getInput(name).trim().toLowerCase();
    if (raw === '') return defaultValue;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new TypeError(`Input "${name}" must be 'true' or 'false', got '${raw}'`);
}

// An empty/unset input yields null (meaning "use the default").
function getIntInput(name: string): number | null {
    const raw = core.getInput(name).trim();
    if (raw === '') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`Input "${name}" must be a positive integer, got '${raw}'`);
    }
    return value;
}

async function run(): Promise<void> {
    const resultsPath = core.getInput('results-path', { required: true });
    const lintResultsPath = core.getInput('lint-results-path');
    const allowedFailureResultsPath = core.getInput('allowed-failure-results-path');
    const failOnMissingResults = getBoolInput('fail-on-missing-results', true);
    const failOnTestFailures = getBoolInput('fail-on-test-failures', true);
    const failOnLintErrors = getBoolInput('fail-on-lint-errors', true);
    const processLogsRetentionDays = getIntInput('process-logs-retention-days');

    const ctx: PathContext = {
        workspace: process.env.GITHUB_WORKSPACE,
        repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.GITHUB_SHA,
        serverUrl: process.env.GITHUB_SERVER_URL,
    };

    // Skip files that are not test-result JSONs (with a warning) instead of
    // failing the whole report on one stray file.
    const parts: ResultFile[] = [];
    function readResults(directory: string, allowFailure: boolean): number {
        let read = 0;
        for (const file of listFiles(directory, ['.json'])) {
            const fileName = path.basename(file);
            try {
                const result = parseTestrunResult(JSON.parse(fs.readFileSync(file, 'utf8')), fileName);
                parts.push({ fileName, result, allowFailure });
                read += 1;
            } catch (error) {
                core.warning(`Skipping ${fileName}: ${(error as Error).message}`);
            }
        }
        return read;
    }
    const numBlockingFiles = readResults(resultsPath, false);
    if (allowedFailureResultsPath !== '') {
        readResults(allowedFailureResultsPath, true);
    }
    const results = mergeResults(parts);

    let lint: LintDiagnostic[] = [];
    if (lintResultsPath !== '') {
        for (const file of listFiles(lintResultsPath, ['.sarif', '.sarif.json'])) {
            lint.push(...parseSarifLog(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file)));
        }
    }

    // Upload before rendering so the summary can link to the artifact.
    const logs = await uploadProcessLogs(results.processOutputs, processLogsRetentionDays);

    const { markdown, failOverall, truncated, stats } = renderSummary({
        grouped: groupTestitems(results.testitems, ctx),
        definitionErrors: normalizeDefinitionErrors(results.definition_errors, ctx),
        processOutputs: results.processOutputs,
        processLogsUrl: logs?.url ?? null,
        lint,
        noResultFiles: parts.length === 0,
        noBlockingResultFiles: numBlockingFiles === 0,
        ctx,
    });

    await core.summary.addRaw(markdown).write();

    core.setOutput('failed', failOverall);
    core.setOutput('process-logs-artifact-id', logs?.artifactId ?? '');
    core.setOutput('test-count', stats.numTestitems);
    core.setOutput('failed-count', stats.numFailed);
    core.setOutput('allowed-failure-count', stats.numAllowedFailures);
    core.setOutput('definition-error-count', stats.numDefinitionErrors);
    core.setOutput('lint-error-count', stats.numLintErrors);

    if (truncated) {
        core.warning('The CI report was truncated to stay under the step-summary size limit.');
    }

    const shouldFail =
        (failOnMissingResults && stats.noResultFiles) ||
        (failOnTestFailures && (stats.numFailed > 0 || stats.numBlockingDefinitionErrors > 0)) ||
        (failOnLintErrors && stats.numLintErrors > 0);
    if (shouldFail) {
        core.setFailed('CI issues found — see the job summary for details.');
    }
}

run().catch(error => {
    core.setFailed((error as Error).message);
});

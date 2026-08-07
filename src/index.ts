import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { PathContext } from './paths';
import { parseSarifLog } from './sarif';
import { groupTestitems, mergeResults, normalizeDefinitionErrors, parseTestrunResult } from './testResults';
import { renderSummary } from './render';
import { LintDiagnostic, TestrunResult } from './types';

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

async function run(): Promise<void> {
    const resultsPath = core.getInput('results-path', { required: true });
    const lintResultsPath = core.getInput('lint-results-path');
    const failOnMissingResults = getBoolInput('fail-on-missing-results', true);
    const failOnTestFailures = getBoolInput('fail-on-test-failures', true);
    const failOnLintErrors = getBoolInput('fail-on-lint-errors', true);

    const ctx: PathContext = {
        workspace: process.env.GITHUB_WORKSPACE,
        repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.GITHUB_SHA,
        serverUrl: process.env.GITHUB_SERVER_URL,
    };

    // Skip files that are not test-result JSONs (with a warning) instead of
    // failing the whole report on one stray file.
    const parts: TestrunResult[] = [];
    for (const file of listFiles(resultsPath, ['.json'])) {
        try {
            parts.push(parseTestrunResult(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file)));
        } catch (error) {
            core.warning(`Skipping ${path.basename(file)}: ${(error as Error).message}`);
        }
    }
    const results = mergeResults(parts);

    let lint: LintDiagnostic[] = [];
    if (lintResultsPath !== '') {
        for (const file of listFiles(lintResultsPath, ['.sarif', '.sarif.json'])) {
            lint.push(...parseSarifLog(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file)));
        }
    }

    const { markdown, failOverall, truncated, stats } = renderSummary({
        grouped: groupTestitems(results.testitems, ctx),
        definitionErrors: normalizeDefinitionErrors(results.definition_errors, ctx),
        processOutputs: results.process_outputs,
        lint,
        noResultFiles: parts.length === 0,
        ctx,
    });

    await core.summary.addRaw(markdown).write();

    core.setOutput('failed', failOverall);
    core.setOutput('test-count', stats.numTestitems);
    core.setOutput('failed-count', stats.numFailed);
    core.setOutput('definition-error-count', stats.numDefinitionErrors);
    core.setOutput('lint-error-count', stats.numLintErrors);

    if (truncated) {
        core.warning('The CI report was truncated to stay under the step-summary size limit.');
    }

    const shouldFail =
        (failOnMissingResults && stats.noResultFiles) ||
        (failOnTestFailures && (stats.numFailed > 0 || stats.numDefinitionErrors > 0)) ||
        (failOnLintErrors && stats.numLintErrors > 0);
    if (shouldFail) {
        core.setFailed('CI issues found — see the job summary for details.');
    }
}

run().catch(error => {
    core.setFailed((error as Error).message);
});

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

async function run(): Promise<void> {
    const resultsPath = core.getInput('results-path', { required: true });
    const lintResultsPath = core.getInput('lint-results-path');

    const ctx: PathContext = {
        workspace: process.env.GITHUB_WORKSPACE,
        repository: process.env.GITHUB_REPOSITORY,
        sha: process.env.GITHUB_SHA,
    };

    const resultFiles = listFiles(resultsPath, ['.json']);
    const parts: TestrunResult[] = resultFiles.map(file =>
        parseTestrunResult(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file))
    );
    const results = mergeResults(parts);

    let lint: LintDiagnostic[] = [];
    if (lintResultsPath !== '') {
        for (const file of listFiles(lintResultsPath, ['.sarif', '.sarif.json'])) {
            lint.push(...parseSarifLog(JSON.parse(fs.readFileSync(file, 'utf8')), path.basename(file)));
        }
    }

    const { markdown, failOverall, truncated } = renderSummary({
        grouped: groupTestitems(results.testitems, ctx),
        definitionErrors: normalizeDefinitionErrors(results.definition_errors, ctx),
        processOutputs: results.process_outputs,
        lint,
        noResultFiles: resultFiles.length === 0,
        ctx,
    });

    await core.summary.addRaw(markdown).write();

    if (truncated) {
        core.warning('The CI report was truncated to stay under the step-summary size limit.');
    }
    if (failOverall) {
        core.setFailed('CI issues found — see the job summary for details.');
    }
}

run().catch(error => {
    core.setFailed((error as Error).message);
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import { DefaultArtifactClient } from '@actions/artifact';
import { ProcessOutput } from './types';

export const LOGS_ARTIFACT_NAME = 'test-process-logs';

export interface UploadedLogs {
    artifactId: number;
    url: string;
}

export function shortId(id: string): string {
    return id.slice(0, 8);
}

// "Julia 1.12.6~x64:ubuntu-latest" + "1a2b3c4d-…" → "Julia-1.12.6-x64-ubuntu-latest-1a2b3c4d.log"
export function logFileName(po: ProcessOutput): string {
    const sanitized = po.label
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return `${sanitized === '' ? 'process' : sanitized}-${shortId(po.id)}.log`;
}

// Uploads one log file per process output as a single artifact and returns a
// link to it, or null when there is nothing to upload or the upload is not
// possible (e.g. outside the Actions runtime). Labels in the summary do not
// depend on this — a failed upload only loses the links.
export async function uploadProcessLogs(
    outputs: ProcessOutput[],
    retentionDays: number | null
): Promise<UploadedLogs | null> {
    if (outputs.length === 0) {
        return null;
    }
    try {
        const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), 'test-process-logs-'));
        const files: string[] = [];
        for (const po of outputs) {
            const file = path.join(dir, logFileName(po));
            fs.writeFileSync(file, po.output);
            files.push(file);
        }
        const client = new DefaultArtifactClient();
        const response = await client.uploadArtifact(
            LOGS_ARTIFACT_NAME,
            files,
            dir,
            retentionDays === null ? {} : { retentionDays }
        );
        const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
        const repository = process.env.GITHUB_REPOSITORY;
        const runId = process.env.GITHUB_RUN_ID;
        if (response.id === undefined || repository === undefined || runId === undefined) {
            return null;
        }
        return {
            artifactId: response.id,
            url: `${serverUrl}/${repository}/actions/runs/${runId}/artifacts/${response.id}`,
        };
    } catch (error) {
        core.warning(`Failed to upload the ${LOGS_ARTIFACT_NAME} artifact: ${(error as Error).message}`);
        return null;
    }
}

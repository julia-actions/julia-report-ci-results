import { TestitemProfile } from './types';

export function statusEmoji(status: string): string {
    switch (status) {
        case 'passed':
            return '✅';
        case 'failed':
            return '❌';
        case 'errored':
            return '💥';
        case 'crash':
            return '💀';
        case 'timeout':
            return '⏱️';
        case 'skipped':
            return '⏭️';
        default:
            return '❓';
    }
}

const STATUS_SEVERITY: Record<string, number> = {
    passed: 0,
    skipped: 0.5,
    failed: 1,
    errored: 2,
    crash: 3,
    timeout: 4,
};

export function statusSeverity(status: string): number {
    return STATUS_SEVERITY[status] ?? 99;
}

export function worstStatus(profiles: TestitemProfile[]): string {
    if (profiles.length === 0) return 'skipped';
    let worst = profiles[0].status;
    for (const p of profiles) {
        if (statusSeverity(p.status) > statusSeverity(worst)) {
            worst = p.status;
        }
    }
    return worst;
}

// A test item counts as non-failing when every profile passed or was skipped.
export function isNonFailing(profiles: TestitemProfile[]): boolean {
    return profiles.every(p => p.status === 'passed' || p.status === 'skipped');
}

function isFailing(profile: TestitemProfile): boolean {
    return profile.status !== 'passed' && profile.status !== 'skipped';
}

// A failure on a leg that is allowed to fail is reported but never fails the job, so
// "did this test item fail" has two answers: one for the reader, one for the exit code.
export function hasBlockingFailure(profiles: TestitemProfile[]): boolean {
    return profiles.some(p => isFailing(p) && p.allowFailure !== true);
}

export function hasAllowedFailure(profiles: TestitemProfile[]): boolean {
    return profiles.some(p => isFailing(p) && p.allowFailure === true);
}

export function formatDuration(profiles: TestitemProfile[]): string {
    const durations = profiles.map(p => p.duration).filter((d): d is number => d !== null);
    if (durations.length === 0) {
        return '—';
    }
    const totalMs = durations.reduce((a, b) => a + b, 0);
    if (totalMs < 1000) {
        return `${Math.round(totalMs)} ms`;
    } else if (totalMs < 60_000) {
        return `${(totalMs / 1000).toFixed(1)} s`;
    } else {
        return `${(totalMs / 60_000).toFixed(1)} min`;
    }
}

const VERSION_ARCH_PATTERN = /^Julia (\d+\.\d+\.\d+)~([^:]*):(.*)$/;
// Pre-release legs carry an arch too, but their channel is a name rather than a version.
const CHANNEL_ARCH_PATTERN = /^Julia ([^:~]+)~([^:]*):(.*)$/;
const CHANNEL_PATTERN = /^Julia ([^:~]+):(.*)$/;

const VERSION_LIKE = /^\d+(\.\d+)*$/;

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) {
            return d;
        }
    }
    return 0;
}

// Versions in numeric order first, then named channels alphabetically, so a matrix
// reads "1.10.5~x64, 1.12.7~x64, rc~x64" rather than by discovery order.
function compareChannels(a: string, b: string): number {
    const aVersion = VERSION_LIKE.test(a);
    const bVersion = VERSION_LIKE.test(b);
    if (aVersion !== bVersion) {
        return aVersion ? -1 : 1;
    }
    return aVersion ? compareVersions(a, b) : a.localeCompare(b);
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

// Compress a list of profile names into a compact per-OS form, e.g.
//   ["Julia 1.10.5~x64:ubuntu-latest", "Julia 1.10.5~x86:ubuntu-latest"]
//     -> "ubuntu-latest (1.10.5~x64~x86)"
//   ["Julia rc~x64:ubuntu-latest", "Julia 1.10.5~x64:ubuntu-latest"]
//     -> "ubuntu-latest (1.10.5~x64, rc~x64)"
//   ["Julia 1.10:ubuntu-latest", "Julia lts:ubuntu-latest"]
//     -> "ubuntu-latest (1.10, lts)"
// Unrecognized names pass through unchanged. `~` is escaped for Markdown.
export function compressProfileList(profileNames: string[]): string {
    // A leg is identified by a channel — a version like "1.10.5" or a name like "rc" —
    // optionally carrying an arch. Both kinds group under the same OS so one runner
    // never yields two parenthesized groups.
    const legs: { channel: string; arch: string | null; os: string }[] = [];
    const unmatched: string[] = [];

    for (const name of profileNames) {
        // Versions are tried first so a numeric channel keeps its version ordering.
        const mv = name.match(VERSION_ARCH_PATTERN) ?? name.match(CHANNEL_ARCH_PATTERN);
        if (mv !== null) {
            legs.push({ channel: mv[1], arch: mv[2], os: mv[3] });
            continue;
        }
        const mc = name.match(CHANNEL_PATTERN);
        if (mc !== null) {
            legs.push({ channel: mc[1], arch: null, os: mc[2] });
            continue;
        }
        unmatched.push(name);
    }

    const parts: string[] = [];

    if (legs.length > 0) {
        // os -> channel -> archs (empty for a channel named without one)
        const byOs = new Map<string, Map<string, string[]>>();
        for (const { channel, arch, os } of legs) {
            const byChannel = byOs.get(os) ?? new Map<string, string[]>();
            byOs.set(os, byChannel);
            const archs = byChannel.get(channel) ?? [];
            byChannel.set(channel, arch === null ? archs : [...archs, arch]);
        }
        for (const os of [...byOs.keys()].sort()) {
            const byChannel = byOs.get(os)!;
            const channelStrings = [...byChannel.keys()]
                .sort(compareChannels)
                .map(c => {
                    const archs = unique(byChannel.get(c)!);
                    return archs.length === 0 ? c : `${c}~${archs.join('~')}`;
                });
            parts.push(`${os} (${channelStrings.join(', ')})`);
        }
    }

    parts.push(...unique(unmatched));

    return parts.join(', ').replace(/~/g, '\\~');
}

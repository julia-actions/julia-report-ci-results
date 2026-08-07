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
const CHANNEL_PATTERN = /^Julia ([^:~]+):(.*)$/;

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

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

// Compress a list of profile names into a compact per-OS form, e.g.
//   ["Julia 1.10.5~x64:ubuntu-latest", "Julia 1.10.5~x86:ubuntu-latest"]
//     -> "ubuntu-latest (1.10.5~x64~x86)"
//   ["Julia 1.10:ubuntu-latest", "Julia lts:ubuntu-latest"]
//     -> "ubuntu-latest (1.10, lts)"
// Unrecognized names pass through unchanged. `~` is escaped for Markdown.
export function compressProfileList(profileNames: string[]): string {
    const versionArch: { version: string; arch: string; os: string }[] = [];
    const channel: { channel: string; os: string }[] = [];
    const unmatched: string[] = [];

    for (const name of profileNames) {
        const mv = name.match(VERSION_ARCH_PATTERN);
        if (mv !== null) {
            versionArch.push({ version: mv[1], arch: mv[2], os: mv[3] });
            continue;
        }
        const mc = name.match(CHANNEL_PATTERN);
        if (mc !== null) {
            channel.push({ channel: mc[1], os: mc[2] });
            continue;
        }
        unmatched.push(name);
    }

    const parts: string[] = [];

    if (versionArch.length > 0) {
        // os -> version -> archs
        const byOs = new Map<string, Map<string, string[]>>();
        for (const { version, arch, os } of versionArch) {
            const byVersion = byOs.get(os) ?? new Map<string, string[]>();
            byOs.set(os, byVersion);
            byVersion.set(version, [...(byVersion.get(version) ?? []), arch]);
        }
        for (const os of [...byOs.keys()].sort()) {
            const byVersion = byOs.get(os)!;
            const versionStrings = [...byVersion.keys()]
                .sort(compareVersions)
                .map(v => `${v}~${unique(byVersion.get(v)!).join('~')}`);
            parts.push(`${os} (${versionStrings.join(', ')})`);
        }
    }

    if (channel.length > 0) {
        const byOs = new Map<string, string[]>();
        for (const { channel: ch, os } of channel) {
            byOs.set(os, [...(byOs.get(os) ?? []), ch]);
        }
        for (const os of [...byOs.keys()].sort()) {
            parts.push(`${os} (${unique(byOs.get(os)!).join(', ')})`);
        }
    }

    parts.push(...unique(unmatched));

    return parts.join(', ').replace(/~/g, '\\~');
}

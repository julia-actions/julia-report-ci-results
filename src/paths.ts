// URI/path normalization. Test-result URIs are absolute file:// paths from the
// runner that executed the tests — which may be a different OS than the one
// this reporter runs on (results from Windows/macOS legs are reported on
// Linux). Normalization therefore tries the reporter's own workspace first and
// falls back to the well-known hosted-runner directory layouts.

export interface PathContext {
    workspace?: string; // GITHUB_WORKSPACE
    repository?: string; // GITHUB_REPOSITORY, "owner/repo"
    sha?: string; // GITHUB_SHA
}

export type NormalizedLocation =
    | { kind: 'repo'; relPath: string }
    | { kind: 'external'; display: string };

// file:///d%3A/a/Repo/Repo/src/x.jl -> "/d:/a/Repo/Repo/src/x.jl"
function decodeFileUriPath(uri: string): string | null {
    if (!/^file:/i.test(uri)) {
        return null;
    }
    try {
        return decodeURIComponent(new URL(uri).pathname);
    } catch {
        return null;
    }
}

function hasDriveLetter(p: string): boolean {
    return /^\/?[a-zA-Z]:\//.test(p);
}

// Strip `workspace` (the reporter's own GITHUB_WORKSPACE) as a prefix of the
// decoded URI path. Only matches same-machine paths.
function stripWorkspacePrefix(uriPath: string, workspace: string): string | null {
    let ws = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
    let p = uriPath;
    // A URI path for a Windows location has a leading slash ("/d:/..."); the
    // env var does not ("D:/...").
    if (hasDriveLetter(p) && !ws.startsWith('/')) {
        ws = '/' + ws;
    }
    const caseInsensitive = hasDriveLetter(p) || hasDriveLetter(ws);
    const pCmp = caseInsensitive ? p.toLowerCase() : p;
    const wsCmp = caseInsensitive ? ws.toLowerCase() : ws;
    if (pCmp.startsWith(wsCmp + '/')) {
        return p.slice(ws.length + 1);
    }
    return null;
}

// Hosted-runner workspace layouts: <root>/<repo>/<repo>/<relpath>. The
// duplicated repo directory makes these patterns safe to apply to foreign
// absolute paths.
const RUNNER_PATTERNS = [
    /^\/Users\/runner\/work\/([^/]+)\/\1\/(.*)$/, // macOS
    /^\/home\/runner\/work\/([^/]+)\/\1\/(.*)$/, // Linux
    /^\/[a-zA-Z]:\/a\/([^/]+)\/\1\/(.*)$/, // Windows (any drive letter)
];

export function normalizeFileUri(uri: string, ctx: PathContext): NormalizedLocation {
    const p = decodeFileUriPath(uri);
    if (p === null) {
        return { kind: 'external', display: uri };
    }

    if (ctx.workspace) {
        const rel = stripWorkspacePrefix(p, ctx.workspace);
        if (rel !== null) {
            return { kind: 'repo', relPath: rel };
        }
    }

    for (const pattern of RUNNER_PATTERNS) {
        const m = p.match(pattern);
        if (m !== null) {
            return { kind: 'repo', relPath: m[2] };
        }
    }

    return { kind: 'external', display: p };
}

export function displayPath(loc: NormalizedLocation): string {
    return loc.kind === 'repo' ? loc.relPath : loc.display;
}

export function githubBlobUrl(loc: NormalizedLocation, line: number | null, ctx: PathContext): string | null {
    if (loc.kind !== 'repo' || !ctx.repository || !ctx.sha) {
        return null;
    }
    const fragment = line === null ? '' : `#L${line}`;
    return `https://github.com/${ctx.repository}/blob/${ctx.sha}/${loc.relPath}${fragment}`;
}

// Rewrite the "Test Failed at <absolute runner path>" first line of a failure
// message into a runner-independent form ("<repo>/<relpath>") so that
// identical failures from different OS legs deduplicate.
const MESSAGE_PATTERNS: { pattern: RegExp; backslash: boolean }[] = [
    { pattern: /^Test Failed at \/Users\/runner\/work\/([^/]+)\/\1\/(.*)$/, backslash: false },
    { pattern: /^Test Failed at \/home\/runner\/work\/([^/]+)\/\1\/(.*)$/, backslash: false },
    { pattern: /^Test Failed at [a-zA-Z]:\\a\\([^\\]+)\\\1\\(.*)$/, backslash: true },
];

export function agnosticMessage(message: string, ctx: PathContext): string {
    let s = message.replace(/\r\n/g, '\n');
    s = s.replace(/\n$/, ''); // chomp a single trailing newline
    const newlineIndex = s.indexOf('\n');
    const firstLine = newlineIndex === -1 ? s : s.slice(0, newlineIndex);
    const rest = newlineIndex === -1 ? '' : s.slice(newlineIndex);

    for (const { pattern, backslash } of MESSAGE_PATTERNS) {
        const m = firstLine.match(pattern);
        if (m !== null) {
            const rel = backslash ? m[2].replace(/\\/g, '/') : m[2];
            return `Test Failed at ${m[1]}/${rel}${rest}`;
        }
    }

    // Fall back to the reporter's own workspace (same-machine paths).
    if (ctx.workspace) {
        const prefixMatch = firstLine.match(/^Test Failed at (.*)$/);
        if (prefixMatch !== null) {
            const rel = stripWorkspacePrefix(
                '/' + prefixMatch[1].replace(/\\/g, '/').replace(/^\//, ''),
                ctx.workspace
            );
            if (rel !== null) {
                const wsName = ctx.workspace.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
                return `Test Failed at ${wsName}/${rel}${rest}`;
            }
        }
    }

    return s;
}

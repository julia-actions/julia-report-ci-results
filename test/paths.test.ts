import test from 'node:test';
import assert from 'node:assert';
import { agnosticMessage, displayPath, githubBlobUrl, normalizeFileUri, PathContext } from '../src/paths';

const ctx: PathContext = { workspace: '/home/runner/work/MyRepo/MyRepo', repository: 'me/MyRepo', sha: 'abc123' };

test('normalizes linux hosted-runner paths', () => {
    const loc = normalizeFileUri('file:///home/runner/work/MyRepo/MyRepo/src/x.jl', {});
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'src/x.jl' });
});

test('normalizes macos hosted-runner paths', () => {
    const loc = normalizeFileUri('file:///Users/runner/work/MyRepo/MyRepo/test/y.jl', {});
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'test/y.jl' });
});

test('normalizes windows hosted-runner paths, any drive, encoded or not', () => {
    assert.deepStrictEqual(normalizeFileUri('file:///d%3A/a/MyRepo/MyRepo/src/z.jl', {}), {
        kind: 'repo',
        relPath: 'src/z.jl',
    });
    assert.deepStrictEqual(normalizeFileUri('file:///c:/a/MyRepo/MyRepo/src/z.jl', {}), {
        kind: 'repo',
        relPath: 'src/z.jl',
    });
});

test('workspace prefix wins when it matches', () => {
    const loc = normalizeFileUri('file:///home/runner/work/MyRepo/MyRepo/src/x.jl', ctx);
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'src/x.jl' });
});

test('workspace prefix strip works with a custom (non-hosted) layout', () => {
    const custom: PathContext = { workspace: '/srv/build/checkout' };
    const loc = normalizeFileUri('file:///srv/build/checkout/src/x.jl', custom);
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'src/x.jl' });
});

test('windows workspace comparison is case-insensitive', () => {
    const custom: PathContext = { workspace: 'D:\\Custom\\Checkout' };
    const loc = normalizeFileUri('file:///d:/custom/checkout/src/x.jl', custom);
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'src/x.jl' });
});

test('foreign windows path on a linux reporter falls back to runner pattern', () => {
    const loc = normalizeFileUri('file:///d:/a/MyRepo/MyRepo/src/z.jl', ctx);
    assert.deepStrictEqual(loc, { kind: 'repo', relPath: 'src/z.jl' });
});

test('unrecognized locations stay external without a link', () => {
    const loc = normalizeFileUri('file:///tmp/scratch/thing.jl', ctx);
    assert.strictEqual(loc.kind, 'external');
    assert.strictEqual(displayPath(loc), '/tmp/scratch/thing.jl');
    assert.strictEqual(githubBlobUrl(loc, 3, ctx), null);
    const nonFile = normalizeFileUri('untitled:Untitled-1', ctx);
    assert.strictEqual(nonFile.kind, 'external');
});

test('github blob urls include sha and line fragment', () => {
    const loc = normalizeFileUri('file:///home/runner/work/MyRepo/MyRepo/src/x.jl', ctx);
    assert.strictEqual(githubBlobUrl(loc, 12, ctx), 'https://github.com/me/MyRepo/blob/abc123/src/x.jl#L12');
    assert.strictEqual(githubBlobUrl(loc, null, ctx), 'https://github.com/me/MyRepo/blob/abc123/src/x.jl');
});

test('agnosticMessage rewrites hosted-runner paths from all three OSes to one form', () => {
    const linux = agnosticMessage('Test Failed at /home/runner/work/MyRepo/MyRepo/test/a.jl:5\n  Expression: 1 == 2\n', {});
    const macos = agnosticMessage('Test Failed at /Users/runner/work/MyRepo/MyRepo/test/a.jl:5\n  Expression: 1 == 2', {});
    const windows = agnosticMessage(
        'Test Failed at d:\\a\\MyRepo\\MyRepo\\test\\a.jl:5\r\n  Expression: 1 == 2',
        {}
    );
    assert.strictEqual(linux, 'Test Failed at MyRepo/test/a.jl:5\n  Expression: 1 == 2');
    assert.strictEqual(linux, macos);
    assert.strictEqual(linux, windows);
});

test('agnosticMessage leaves non-matching messages unchanged (modulo newline normalization)', () => {
    assert.strictEqual(agnosticMessage('Some other failure\n', {}), 'Some other failure');
    const already = 'Test Failed at MyRepo/test/a.jl:5\n  Expression: 1 == 2';
    assert.strictEqual(agnosticMessage(already, {}), already);
});

import test from 'node:test';
import assert from 'node:assert';
import { DEFAULT_BUDGET, escapeTableCell, renderSummary, truncateHead, truncateTail } from '../src/render';
import { groupTestitems, normalizeDefinitionErrors } from '../src/testResults';
import { LintDiagnostic, Testitem, TestitemProfile } from '../src/types';
import { PathContext } from '../src/paths';

const ctx: PathContext = { repository: 'me/MyRepo', sha: 'abc123' };
const uri = 'file:///home/runner/work/MyRepo/MyRepo/test/a.jl';

function profile(status: string, overrides: Partial<TestitemProfile> = {}): TestitemProfile {
    return {
        profile_name: 'Julia 1.10:ubuntu-latest',
        status,
        duration: 10,
        messages: null,
        output: null,
        ...overrides,
    };
}

function testitem(name: string, profiles: TestitemProfile[]): Testitem {
    return { name, uri, profiles };
}

function lintError(message = 'boom'): LintDiagnostic {
    return { level: 'error', relPath: 'src/x.jl', line: 3, ruleId: 'syntax_errors', message, toolName: 'julialint' };
}

function render(overrides: Partial<Parameters<typeof renderSummary>[0]> = {}, budget = DEFAULT_BUDGET) {
    return renderSummary(
        {
            grouped: [],
            definitionErrors: [],
            processOutputs: {},
            lint: [],
            noResultFiles: false,
            ctx,
            ...overrides,
        },
        budget
    );
}

test('all-passed run renders a green banner and no lint section', () => {
    const grouped = groupTestitems([testitem('t1', [profile('passed')])], ctx);
    const { markdown, failOverall, truncated } = render({ grouped });
    assert.match(markdown, /# ✅ CI Report — All Checks Passed/);
    assert.ok(!markdown.includes('Lint Results'));
    assert.match(markdown, /Passed on all profiles: ubuntu-latest \(1\.10\)/);
    assert.strictEqual(failOverall, false);
    assert.strictEqual(truncated, false);
});

test('mixed run dedups identical failures across profiles and renders stack trace once', () => {
    const message = {
        message: 'Test Failed at /home/runner/work/MyRepo/MyRepo/test/a.jl:5\n  Expression: 1 == 2',
        expected_output: null,
        actual_output: null,
        uri,
        line: 5,
        column: 1,
        stack_frames: [{ label: 'f', uri, line: 9, column: 1 }],
    };
    const windowsMessage = {
        ...message,
        message: 'Test Failed at d:\\a\\MyRepo\\MyRepo\\test\\a.jl:5\r\n  Expression: 1 == 2',
        uri: 'file:///d:/a/MyRepo/MyRepo/test/a.jl',
    };
    const items = [
        testitem('t1', [
            profile('failed', { messages: [message] }),
            profile('failed', { profile_name: 'Julia 1.10:windows-latest', messages: [windowsMessage] }),
            profile('passed', { profile_name: 'Julia lts:ubuntu-latest' }),
        ]),
    ];
    const { markdown, failOverall } = render({ grouped: groupTestitems(items, ctx) });
    assert.strictEqual(failOverall, true);
    assert.match(markdown, /# ❌ CI Report — Issues Found/);
    // The two failures collapse into one message block naming both profiles.
    const occurrences = markdown.split('Expression: 1 == 2').length - 1;
    assert.strictEqual(occurrences, 1);
    assert.match(markdown, /ubuntu-latest \(1\.10\), windows-latest \(1\.10\)/);
    assert.match(markdown, /✅ \*\*Passed\*\* on: ubuntu-latest \(lts\)/);
    assert.match(markdown, /Stack trace:/);
    assert.match(markdown, /https:\/\/github\.com\/me\/MyRepo\/blob\/abc123\/test\/a\.jl#L9/);
});

test('definition errors render and fail the run', () => {
    const definitionErrors = normalizeDefinitionErrors(
        [{ message: 'bad @testitem', uri, line: 3, column: 1 }],
        ctx
    );
    const { markdown, failOverall } = render({ definitionErrors });
    assert.strictEqual(failOverall, true);
    assert.match(markdown, /🚫 Test Definition Errors/);
    assert.match(markdown, /bad @testitem/);
});

test('lint errors open the details block and fail the run; note maps to info', () => {
    const lint = [lintError(), { ...lintError('meh'), level: 'note' as const, ruleId: 'unused_binding' }];
    const { markdown, failOverall } = render({ lint });
    assert.strictEqual(failOverall, true);
    assert.match(markdown, /<details open>/);
    assert.match(markdown, /1 error, 1 info/);
    assert.match(markdown, /\| ℹ️ \| info \|/);
    assert.match(markdown, /https:\/\/github\.com\/me\/MyRepo\/blob\/abc123\/src\/x\.jl#L3/);
});

test('lint-only warnings do not fail the run', () => {
    const lint = [{ ...lintError(), level: 'warning' as const }];
    const { failOverall } = render({ lint });
    assert.strictEqual(failOverall, false);
});

test('no result files fails the run with a notice', () => {
    const { markdown, failOverall } = render({ noResultFiles: true });
    assert.strictEqual(failOverall, true);
    assert.match(markdown, /No test result files were found/);
});

test('table cells escape pipes and newlines', () => {
    assert.strictEqual(escapeTableCell('a|b\nc'), 'a\\|b c');
});

test('truncateHead and truncateTail annotate the omission', () => {
    const long = 'x'.repeat(100);
    const head = truncateHead(long, 10);
    assert.ok(head.startsWith('xxxxxxxxxx'));
    assert.match(head, /truncated, 90 more bytes/);
    const tail = truncateTail(long, 10);
    assert.ok(tail.endsWith('xxxxxxxxxx'));
    assert.match(tail, /90 bytes omitted/);
    assert.strictEqual(truncateHead('short', 100), 'short');
});

test('per-block output caps keep the tail of raw output', () => {
    const items = [
        testitem('t1', [
            profile('failed', { output: 'early\n' + 'filler\n'.repeat(50) + 'THE END' }),
        ]),
    ];
    const budget = { ...DEFAULT_BUDGET, outputBytes: 64 };
    const { markdown } = render({ grouped: groupTestitems(items, ctx) }, budget);
    assert.match(markdown, /THE END/);
    assert.ok(!markdown.includes('early'));
    assert.match(markdown, /bytes omitted/);
});

test('total budget overflow drops trailing detail blocks atomically', () => {
    const items = Array.from({ length: 30 }, (_, i) =>
        testitem(`item ${i}`, [profile('failed', { output: 'output '.repeat(200) })])
    );
    const budget = { ...DEFAULT_BUDGET, totalBytes: 12_000 };
    const { markdown, truncated } = render({ grouped: groupTestitems(items, ctx) }, budget);
    assert.strictEqual(truncated, true);
    assert.match(markdown, /Report truncated/);
    // No dangling <details>: every opened tag is closed.
    const opened = markdown.split('<details').length - 1;
    const closed = markdown.split('</details>').length - 1;
    assert.strictEqual(opened, closed);
    assert.ok(Buffer.byteLength(markdown) <= 12_000 + 256);
});

test('lint row cap shows errors first and counts the rest', () => {
    const lint: LintDiagnostic[] = [
        { ...lintError('w1'), level: 'warning' },
        { ...lintError('w2'), level: 'warning' },
        lintError('e1'),
    ];
    const budget = { ...DEFAULT_BUDGET, maxLintRows: 2 };
    const { markdown } = render({ lint }, budget);
    assert.match(markdown, /e1/);
    assert.match(markdown, /w1/);
    assert.ok(!markdown.includes('w2'));
    assert.match(markdown, /1 more lint message/);
});

test('process outputs render collapsed', () => {
    const { markdown } = render({ processOutputs: { 'proc-1': 'process died horribly' } });
    assert.match(markdown, /Test process output — <code>proc-1<\/code>/);
    assert.match(markdown, /process died horribly/);
});

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
            processOutputs: [],
            processLogsUrl: null,
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
        [{ message: 'bad @testitem', uri, line: 3, column: 1, allowFailure: false }],
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
    assert.ok(Buffer.byteLength(markdown) <= 12_000 + 1024);
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

test('process outputs render collapsed with their profile label', () => {
    const { markdown } = render({
        processOutputs: [
            { id: '4767ab5a-67a4-47b4-ab39-20f5dfc7aecb', label: 'Julia 1.12.6~x64:ubuntu-latest', output: 'process died horribly' },
        ],
    });
    assert.match(markdown, /Test process output — Julia 1\.12\.6\\~x64:ubuntu-latest/);
    assert.match(markdown, /process died horribly/);
    assert.ok(!markdown.includes('4767ab5a-67a4-47b4-ab39-20f5dfc7aecb'));
});

test('short process id disambiguates only duplicate labels', () => {
    const { markdown } = render({
        processOutputs: [
            { id: '4767ab5a-67a4-47b4-ab39-20f5dfc7aecb', label: 'leg-a', output: 'one' },
            { id: 'b6a5898d-9cad-4d13-baa2-af64e3305b4d', label: 'leg-a', output: 'two' },
            { id: 'cd33e036-3391-4572-bf58-61484da7cdf9', label: 'leg-b', output: 'three' },
        ],
    });
    assert.match(markdown, /leg-a — <code>4767ab5a<\/code>/);
    assert.match(markdown, /leg-a — <code>b6a5898d<\/code>/);
    assert.match(markdown, /Test process output — leg-b</);
    assert.ok(!markdown.includes('cd33e036'));
});

test('process-output section links to the logs artifact', () => {
    const url = 'https://github.com/me/MyRepo/actions/runs/1/artifacts/2';
    const { markdown } = render({
        processOutputs: [{ id: 'proc-1', label: 'leg-a', output: 'hello' }],
        processLogsUrl: url,
    });
    assert.ok(markdown.includes(`Full, untruncated logs: [test-process-logs artifact](${url})`));
});

test('omitted process outputs leave a notice linking to the logs artifact', () => {
    const url = 'https://github.com/me/MyRepo/actions/runs/1/artifacts/2';
    const outputs = Array.from({ length: 10 }, (_, i) => ({
        id: `proc-${i}`,
        label: `leg-${i}`,
        output: 'output '.repeat(300),
    }));
    const budget = { ...DEFAULT_BUDGET, totalBytes: 5_000 };
    const { markdown, truncated } = render({ processOutputs: outputs, processLogsUrl: url }, budget);
    assert.strictEqual(truncated, true);
    assert.match(markdown, /test process outputs omitted/);
    assert.ok(markdown.includes(`Full logs are in the [test-process-logs artifact](${url})`));
    const opened = markdown.split('<details').length - 1;
    const closed = markdown.split('</details>').length - 1;
    assert.strictEqual(opened, closed);
});

test('a lint section that does not fit leaves an in-summary notice', () => {
    const lint = Array.from({ length: 50 }, (_, i) => lintError(`message ${i} ${'x'.repeat(100)}`));
    const budget = { ...DEFAULT_BUDGET, totalBytes: 2_000 };
    const { markdown, truncated } = render({ lint }, budget);
    assert.strictEqual(truncated, true);
    assert.match(markdown, /Report truncated.*lint result section/);
});

test('lint row cap marks the report as truncated', () => {
    const lint = [lintError('a'), lintError('b')];
    const budget = { ...DEFAULT_BUDGET, maxLintRows: 1 };
    const { truncated } = render({ lint }, budget);
    assert.strictEqual(truncated, true);
});

test('a test item failing only on a leg allowed to fail does not fail the run', () => {
    const grouped = groupTestitems(
        [
            testitem('t1', [
                profile('passed'),
                profile('failed', { profile_name: 'Julia rc~x64:ubuntu-latest', allowFailure: true }),
            ]),
        ],
        ctx
    );
    const { markdown, failOverall, stats } = render({ grouped });
    assert.strictEqual(failOverall, false);
    assert.strictEqual(stats.numFailed, 0);
    assert.strictEqual(stats.numAllowedFailures, 1);
    assert.match(markdown, /# ✅ CI Report — All Checks Passed/);
    assert.match(markdown, /\*\*1\*\* with issues on legs allowed to fail/);
    assert.match(markdown, /failed only on legs that are allowed to fail/);
    assert.match(markdown, /### ❌ Failed \(allowed to fail\)/);
    // The summary-table row warns too, rather than showing a failure.
    assert.match(markdown, /\| ⚠️ \| \*\*t1\*\*/);
});

test('the same failure on a blocking leg does fail the run', () => {
    const grouped = groupTestitems(
        [
            testitem('t1', [
                profile('failed'),
                profile('failed', { profile_name: 'Julia rc~x64:ubuntu-latest', allowFailure: true }),
            ]),
        ],
        ctx
    );
    const { markdown, failOverall, stats } = render({ grouped });
    assert.strictEqual(failOverall, true);
    assert.strictEqual(stats.numFailed, 1);
    assert.strictEqual(stats.numAllowedFailures, 0);
    // Both sections render, the blocking one without the suffix.
    assert.match(markdown, /### ❌ Failed\n/);
    assert.match(markdown, /### ❌ Failed \(allowed to fail\)/);
});

test('a definition error on a leg allowed to fail is reported but not fatal', () => {
    const definitionErrors = normalizeDefinitionErrors(
        [{ message: 'bad @testitem', uri, line: 3, column: 1, allowFailure: true }],
        ctx
    );
    const { markdown, failOverall, stats } = render({ definitionErrors });
    assert.strictEqual(failOverall, false);
    assert.strictEqual(stats.numDefinitionErrors, 1);
    assert.strictEqual(stats.numBlockingDefinitionErrors, 0);
    assert.match(markdown, /Test Definition Errors/);
    assert.match(markdown, /\| ⚠️ \|/);
});

test('results from only the allowed-to-fail legs count as missing results', () => {
    const grouped = groupTestitems(
        [testitem('t1', [profile('passed', { allowFailure: true })])],
        ctx
    );
    const { markdown, failOverall, stats } = render({
        grouped,
        noResultFiles: false,
        noBlockingResultFiles: true,
    });
    assert.strictEqual(failOverall, true);
    assert.strictEqual(stats.noResultFiles, true);
    assert.match(markdown, /Only legs allowed to fail reported results/);
});

test('a missing blocking leg fails the report and is named in the summary', () => {
    const out = render({
        grouped: groupTestitems([testitem('a', [profile('passed')])], ctx),
        missingProfiles: [
            { name: 'Julia 1.11~x64:windows-latest', allowFailure: false },
            { name: 'Julia lts~x86:ubuntu-latest', allowFailure: false },
        ],
    });
    assert.strictEqual(out.failOverall, true);
    assert.strictEqual(out.stats.numMissingBlockingProfiles, 2);
    assert.deepStrictEqual(out.stats.missingProfileNames, [
        'Julia 1.11~x64:windows-latest',
        'Julia lts~x86:ubuntu-latest',
    ]);
    assert.match(out.markdown, /# ❌ CI Report/);
    assert.match(out.markdown, /2 legs that must pass reported no results/);
    assert.match(out.markdown, /`Julia 1.11~x64:windows-latest`, `Julia lts~x86:ubuntu-latest`/);
    assert.match(out.markdown, /\*\*2\*\* legs missing/);
});

test('a missing leg that is allowed to fail is reported without failing the report', () => {
    const out = render({
        grouped: groupTestitems([testitem('a', [profile('passed')])], ctx),
        missingProfiles: [{ name: 'Julia rc~x64:macos-latest', allowFailure: true }],
    });
    assert.strictEqual(out.failOverall, false);
    assert.strictEqual(out.stats.numMissingBlockingProfiles, 0);
    assert.deepStrictEqual(out.stats.missingProfileNames, ['Julia rc~x64:macos-latest']);
    assert.match(out.markdown, /1 leg allowed to fail reported no results/);
    assert.doesNotMatch(out.markdown, /that must pass reported no results/);
});

test('blocking missing legs are listed before allowed ones', () => {
    const out = render({
        grouped: groupTestitems([testitem('a', [profile('passed')])], ctx),
        missingProfiles: [
            { name: 'allowed', allowFailure: true },
            { name: 'blocking', allowFailure: false },
        ],
    });
    assert.deepStrictEqual(out.stats.missingProfileNames, ['blocking', 'allowed']);
});

test('no expected profiles means no missing-leg reporting at all', () => {
    const out = render({ grouped: groupTestitems([testitem('a', [profile('passed')])], ctx) });
    assert.strictEqual(out.failOverall, false);
    assert.deepStrictEqual(out.stats.missingProfileNames, []);
    assert.strictEqual(out.stats.numMissingBlockingProfiles, 0);
    assert.doesNotMatch(out.markdown, /reported no results/);
    assert.doesNotMatch(out.markdown, /legs missing/);
});

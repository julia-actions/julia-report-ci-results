import test from 'node:test';
import assert from 'node:assert';
import { ResultFile, deriveFileLabel, groupTestitems, mergeResults, parseTestrunResult } from '../src/testResults';
import { TestrunResult } from '../src/types';

const linuxUri = 'file:///home/runner/work/MyRepo/MyRepo/test/a.jl';
const windowsUri = 'file:///d:/a/MyRepo/MyRepo/test/a.jl';

function resultFile(result: TestrunResult, fileName = 'results.json', allowFailure = false): ResultFile {
    return { fileName, result, allowFailure };
}

function resultFixture(profileName: string, status: string, uri: string): TestrunResult {
    return {
        definition_errors: [],
        testitems: [
            {
                name: 'my test',
                uri,
                profiles: [
                    {
                        profile_name: profileName,
                        status,
                        duration: status === 'passed' ? 12.5 : null,
                        messages: null,
                        output: null,
                    },
                ],
            },
        ],
        process_outputs: {},
    };
}

test('parses a null-heavy result file', () => {
    const parsed = parseTestrunResult(
        {
            definition_errors: [{ message: 'bad', uri: linuxUri, line: 1, column: 1 }],
            testitems: [
                {
                    name: 't',
                    uri: linuxUri,
                    profiles: [
                        { profile_name: 'p', status: 'crash', duration: null, messages: null, output: null },
                    ],
                },
            ],
            process_outputs: { '123': 'boom' },
        },
        'a.json'
    );
    assert.strictEqual(parsed.testitems[0].profiles[0].duration, null);
});

test('rejects a non-result file naming the file', () => {
    assert.throws(() => parseTestrunResult({ foo: 1 }, 'bad.json'), /bad\.json/);
});

test('merges parts and groups cross-OS test items together', () => {
    const merged = mergeResults([
        resultFile(resultFixture('Julia 1.10:ubuntu-latest', 'passed', linuxUri), 'a.json'),
        resultFile(resultFixture('Julia 1.10:windows-latest', 'failed', windowsUri), 'b.json'),
    ]);
    assert.strictEqual(merged.testitems.length, 2);

    const grouped = groupTestitems(merged.testitems, {});
    assert.strictEqual(grouped.length, 1);
    assert.strictEqual(grouped[0].profiles.length, 2);
    assert.deepStrictEqual(grouped[0].location, { kind: 'repo', relPath: 'test/a.jl' });
});

test('sorts worst-status items first', () => {
    const ok = resultFixture('p1', 'passed', linuxUri);
    ok.testitems[0].name = 'ok item';
    const bad = resultFixture('p1', 'errored', linuxUri);
    bad.testitems[0].name = 'bad item';
    const grouped = groupTestitems(mergeResults([resultFile(ok), resultFile(bad)]).testitems, {});
    assert.deepStrictEqual(
        grouped.map(g => g.name),
        ['bad item', 'ok item']
    );
});

test('process outputs are labeled with the profile of their source file', () => {
    const result = resultFixture('Julia 1.12.6~x64:ubuntu-latest', 'passed', linuxUri);
    result.process_outputs = { 'aaaa-bbbb': 'some output' };
    const merged = mergeResults([resultFile(result, 'testitemresults-ubuntu-latest-1.12.6~x64.json')]);
    assert.deepStrictEqual(merged.processOutputs, [
        { id: 'aaaa-bbbb', label: 'Julia 1.12.6~x64:ubuntu-latest', output: 'some output' },
    ]);
});

test('label falls back to the file name for empty or multi-profile files', () => {
    const empty: TestrunResult = { definition_errors: [], testitems: [], process_outputs: {} };
    assert.strictEqual(deriveFileLabel(resultFile(empty, 'crashed-leg.json')), 'crashed-leg.json');

    const multi = resultFixture('p1', 'passed', linuxUri);
    multi.testitems[0].profiles.push({ ...multi.testitems[0].profiles[0], profile_name: 'p2' });
    assert.strictEqual(deriveFileLabel(resultFile(multi, 'multi.json')), 'multi.json');
});

test('whitespace-only process outputs are dropped and duplicate ids deduped', () => {
    const a = resultFixture('p1', 'passed', linuxUri);
    a.process_outputs = { blank: '  \n', dup: 'from a' };
    const b = resultFixture('p2', 'passed', linuxUri);
    b.process_outputs = { dup: 'from b' };
    const merged = mergeResults([resultFile(a, 'a.json'), resultFile(b, 'b.json')]);
    assert.deepStrictEqual(merged.processOutputs, [{ id: 'dup', label: 'p2', output: 'from b' }]);
});

test('merge stamps allow-failure from the file it came from', () => {
    const blocking = resultFixture('Julia 1.11~x64:ubuntu-latest', 'passed', linuxUri);
    const allowed = resultFixture('Julia rc~x64:ubuntu-latest', 'failed', linuxUri);
    allowed.definition_errors.push({ message: 'bad @testitem', uri: linuxUri, line: 1, column: 1 });

    const merged = mergeResults([
        resultFile(blocking, 'blocking.json', false),
        resultFile(allowed, 'allowfail.json', true),
    ]);

    const stamped = merged.testitems.flatMap(ti => ti.profiles).map(p => [p.profile_name, p.allowFailure]);
    assert.deepStrictEqual(stamped, [
        ['Julia 1.11~x64:ubuntu-latest', false],
        ['Julia rc~x64:ubuntu-latest', true],
    ]);
    assert.deepStrictEqual(merged.definition_errors.map(e => e.allowFailure), [true]);
});

test('merge does not mutate the parsed result files', () => {
    const source = resultFixture('Julia rc~x64:ubuntu-latest', 'failed', linuxUri);
    mergeResults([resultFile(source, 'allowfail.json', true)]);
    assert.strictEqual('allowFailure' in source.testitems[0].profiles[0], false);
});

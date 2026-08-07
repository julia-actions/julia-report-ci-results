import test from 'node:test';
import assert from 'node:assert';
import { groupTestitems, mergeResults, parseTestrunResult } from '../src/testResults';
import { TestrunResult } from '../src/types';

const linuxUri = 'file:///home/runner/work/MyRepo/MyRepo/test/a.jl';
const windowsUri = 'file:///d:/a/MyRepo/MyRepo/test/a.jl';

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
        resultFixture('Julia 1.10:ubuntu-latest', 'passed', linuxUri),
        resultFixture('Julia 1.10:windows-latest', 'failed', windowsUri),
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
    const grouped = groupTestitems(mergeResults([ok, bad]).testitems, {});
    assert.deepStrictEqual(
        grouped.map(g => g.name),
        ['bad item', 'ok item']
    );
});

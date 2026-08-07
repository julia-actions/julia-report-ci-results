import test from 'node:test';
import assert from 'node:assert';
import { parseSarifLog } from '../src/sarif';

function julialintSarif(results: unknown[]): unknown {
    return {
        version: '2.1.0',
        runs: [
            {
                tool: { driver: { name: 'julialint', version: '0.1.0' } },
                originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///home/runner/work/R/R/' } },
                results,
            },
        ],
    };
}

test('parses julialint-shaped SARIF', () => {
    const diagnostics = parseSarifLog(
        julialintSarif([
            {
                ruleId: 'unused_binding',
                level: 'note',
                message: { text: 'Variable has been assigned but not used.' },
                locations: [
                    {
                        physicalLocation: {
                            artifactLocation: { uri: 'src/bad.jl', uriBaseId: '%SRCROOT%' },
                            region: { startLine: 2, startColumn: 5, endLine: 2, endColumn: 11 },
                        },
                    },
                ],
            },
        ]),
        'lint.sarif'
    );
    assert.deepStrictEqual(diagnostics, [
        {
            level: 'note',
            relPath: 'src/bad.jl',
            line: 2,
            ruleId: 'unused_binding',
            message: 'Variable has been assigned but not used.',
            toolName: 'julialint',
        },
    ]);
});

test('missing level defaults to warning per the SARIF spec', () => {
    const diagnostics = parseSarifLog(julialintSarif([{ ruleId: 'r', message: { text: 'm' } }]), 'l.sarif');
    assert.strictEqual(diagnostics[0].level, 'warning');
    assert.strictEqual(diagnostics[0].relPath, null);
    assert.strictEqual(diagnostics[0].line, null);
});

test('concatenates multiple runs and tolerates empty results', () => {
    const sarif = {
        runs: [
            { tool: { driver: { name: 'julialint' } }, results: [] },
            {
                tool: { driver: { name: 'other' } },
                results: [{ ruleId: 'r', level: 'error', message: { text: 'm' } }],
            },
        ],
    };
    const diagnostics = parseSarifLog(sarif, 'l.sarif');
    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].toolName, 'other');
});

test('rejects non-SARIF json naming the file', () => {
    assert.throws(() => parseSarifLog({ nope: true }, 'weird.sarif'), /weird\.sarif/);
});

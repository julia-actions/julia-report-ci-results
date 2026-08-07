import test from 'node:test';
import assert from 'node:assert';
import { logFileName, shortId } from '../src/artifacts';

test('shortId keeps the first uuid segment', () => {
    assert.strictEqual(shortId('4767ab5a-67a4-47b4-ab39-20f5dfc7aecb'), '4767ab5a');
});

test('logFileName sanitizes the label and appends the short id', () => {
    const name = logFileName({
        id: '4767ab5a-67a4-47b4-ab39-20f5dfc7aecb',
        label: 'Julia 1.12.6~x64:ubuntu-latest',
        output: '',
    });
    assert.strictEqual(name, 'Julia-1.12.6-x64-ubuntu-latest-4767ab5a.log');
});

test('logFileName is unique for the same label with different ids', () => {
    const a = logFileName({ id: 'aaaa1111-x', label: 'leg', output: '' });
    const b = logFileName({ id: 'bbbb2222-x', label: 'leg', output: '' });
    assert.notStrictEqual(a, b);
});

test('logFileName handles hostile labels', () => {
    assert.strictEqual(logFileName({ id: 'abcd1234-x', label: '::/\\<>|*?', output: '' }), 'process-abcd1234.log');
    assert.strictEqual(logFileName({ id: 'abcd1234-x', label: 'a b//c', output: '' }), 'a-b-c-abcd1234.log');
});

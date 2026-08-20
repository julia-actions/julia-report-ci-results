import test from 'node:test';
import assert from 'node:assert';
import {
    compressProfileList,
    formatDuration,
    hasAllowedFailure,
    hasBlockingFailure,
    isNonFailing,
    statusEmoji,
    worstStatus,
} from '../src/profiles';
import { TestitemProfile } from '../src/types';

function profile(status: string, duration: number | null = null, name = 'p'): TestitemProfile {
    return { profile_name: name, status, duration, messages: null, output: null };
}

test('compresses version~arch profile names per os', () => {
    const s = compressProfileList([
        'Julia 1.10.5~x64:ubuntu-latest',
        'Julia 1.10.5~x86:ubuntu-latest',
        'Julia 1.9.4~x64:ubuntu-latest',
        'Julia 1.10.5~x64:windows-latest',
    ]);
    assert.strictEqual(
        s,
        'ubuntu-latest (1.9.4\\~x64, 1.10.5\\~x64\\~x86), windows-latest (1.10.5\\~x64)'
    );
});

test('version sort is numeric, not lexicographic', () => {
    const s = compressProfileList(['Julia 1.10.0~x64:linux', 'Julia 1.9.0~x64:linux']);
    assert.match(s, /1\.9\.0.*1\.10\.0/);
});

test('compresses channel-style profile names per os', () => {
    const s = compressProfileList([
        'Julia 1.10:ubuntu-latest',
        'Julia lts:ubuntu-latest',
        'Julia release:macos-26',
    ]);
    assert.strictEqual(s, 'macos-26 (release), ubuntu-latest (1.10, lts)');
});

test('unmatched names pass through unique', () => {
    const s = compressProfileList(['weird profile', 'weird profile', 'another']);
    assert.strictEqual(s, 'weird profile, another');
});

test('mixed forms all render', () => {
    const s = compressProfileList(['Julia 1.10.5~x64:linux', 'Julia lts:linux', 'custom']);
    assert.strictEqual(s, 'linux (1.10.5\\~x64), linux (lts), custom');
});

test('worst status and non-failing classification', () => {
    assert.strictEqual(worstStatus([profile('passed'), profile('failed'), profile('timeout')]), 'timeout');
    assert.strictEqual(worstStatus([profile('passed'), profile('unknowable')]), 'unknowable');
    assert.strictEqual(worstStatus([]), 'skipped');
    assert.ok(isNonFailing([profile('passed'), profile('skipped')]));
    assert.ok(!isNonFailing([profile('passed'), profile('failed')]));
    assert.strictEqual(statusEmoji('skipped'), '⏭️');
    assert.strictEqual(statusEmoji('nonsense'), '❓');
});

test('duration formatting boundaries', () => {
    assert.strictEqual(formatDuration([profile('passed', null)]), '—');
    assert.strictEqual(formatDuration([profile('passed', 999)]), '999 ms');
    assert.strictEqual(formatDuration([profile('passed', 500), profile('passed', 500)]), '1.0 s');
    assert.strictEqual(formatDuration([profile('passed', 59_000)]), '59.0 s');
    assert.strictEqual(formatDuration([profile('passed', 90_000)]), '1.5 min');
});

test('failures on legs allowed to fail are separated from blocking ones', () => {
    const blocking = profile('failed');
    const allowed: TestitemProfile = { ...profile('failed', null, 'rc'), allowFailure: true };
    const passed = profile('passed');
    const skipped: TestitemProfile = { ...profile('skipped', null, 'rc'), allowFailure: true };

    assert.strictEqual(hasBlockingFailure([passed, allowed]), false);
    assert.strictEqual(hasAllowedFailure([passed, allowed]), true);

    assert.strictEqual(hasBlockingFailure([blocking, allowed]), true);
    assert.strictEqual(hasAllowedFailure([blocking, allowed]), true);

    // An unstamped profile is blocking, and a skip is not a failure either way.
    assert.strictEqual(hasBlockingFailure([blocking]), true);
    assert.strictEqual(hasBlockingFailure([passed, skipped]), false);
    assert.strictEqual(hasAllowedFailure([passed, skipped]), false);
});

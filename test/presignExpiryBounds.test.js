'use strict';

// The S3 object viewer's "Custom…" presigned-link form validates the requested
// lifetime in the browser, so an out-of-range value is refused with an
// explanation instead of being silently clamped by the server. That means the
// bounds are duplicated in JSX (which this backend-only suite cannot import), and
// a duplicated bound drifts: if the server floor moved to 30 s, the form would
// keep refusing perfectly valid values and nobody would notice. So assert the
// literals still agree with the authority.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const expiryUtils = require('../lib/expiryUtils');
const s3World = require('../lib/s3/s3World');

const VIEWER = path.join(
    __dirname,
    '..',
    'frontend',
    'src',
    'components',
    's3',
    'S3ObjectViewer.jsx'
);

function readConstant(source, name) {
    const match = new RegExp(`const ${name} = (\\d+)`).exec(source);
    assert.ok(match, `${name} should be declared in S3ObjectViewer.jsx`);
    return Number(match[1]);
}

test('the viewer\'s custom-expiry bounds match clampExpiresInSeconds', () => {
    const source = fs.readFileSync(VIEWER, 'utf8');

    assert.strictEqual(
        readConstant(source, 'MIN_EXPIRY_SECONDS'),
        expiryUtils.MIN_EXPIRES_IN_SECONDS
    );
    assert.strictEqual(
        readConstant(source, 'MAX_EXPIRY_SECONDS'),
        expiryUtils.MAX_EXPIRES_IN_SECONDS
    );
});

test('every preset lifetime the viewer offers survives clampExpiresInSeconds unchanged', () => {
    const source = fs.readFileSync(VIEWER, 'utf8');
    const block = /const EXPIRY_CHOICES = \[([\s\S]*?)\]/.exec(source);
    assert.ok(block, 'EXPIRY_CHOICES should be declared in S3ObjectViewer.jsx');

    const presets = Array.from(block[1].matchAll(/seconds: (\d+)/g)).map(m => Number(m[1]));
    assert.ok(presets.length >= 3, 'the presets should still be offered');

    for (const seconds of presets) {
        // A preset the server would clamp is a preset that lies to the user.
        assert.strictEqual(expiryUtils.clampExpiresInSeconds(seconds), seconds);
        // s3PresignView goes through s3World's own clamp, so check that one too.
        assert.strictEqual(s3World.clampExpiry(seconds, null, 0), seconds);
    }
});

test('the bounds the form enforces are exactly the bounds s3PresignView enforces', () => {
    const source = fs.readFileSync(VIEWER, 'utf8');
    const min = readConstant(source, 'MIN_EXPIRY_SECONDS');
    const max = readConstant(source, 'MAX_EXPIRY_SECONDS');

    // Inside the range: accepted verbatim, so the form should accept it too.
    assert.strictEqual(s3World.clampExpiry(min, null, 0), min);
    assert.strictEqual(s3World.clampExpiry(max, null, 0), max);
    // Outside: clamped, which is precisely what the form refuses to let happen
    // silently — a 20-hour request must not come back as a 12-hour link.
    assert.strictEqual(s3World.clampExpiry(max + 1, null, 0), max);
    assert.strictEqual(s3World.clampExpiry(min - 1, null, 0), min);
});

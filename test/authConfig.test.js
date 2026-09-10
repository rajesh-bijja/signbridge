"use strict";

// Guards the "no login, single local user" invariant. If someone reintroduces a
// per-request user or breaks the default-user stamping, these fail.

const test = require('node:test');
const assert = require('node:assert/strict');

const authConfig = require('../lib/authConfig');

test('resolveUserName: returns a non-empty lowercase identifier', () => {
    const name = authConfig.resolveUserName();
    assert.ok(name && name.length > 0, 'expected a resolved user name');
    assert.equal(name, name.toLowerCase(), 'resolved user name must be lowercase');
});

test('getDefaultUserSession: carries userName, displayName, emailAddress', () => {
    const session = authConfig.getDefaultUserSession();
    assert.ok(session.userName);
    assert.ok(session.displayName);
    assert.ok(session.emailAddress);
    assert.match(session.emailAddress, /@/);
});

test('applyDefaultUserToRequest: stamps the user across body, options, profile, settings', () => {
    const req = { body: { options: {}, profile: {}, settings: {} } };
    authConfig.applyDefaultUserToRequest(req);

    const expected = authConfig.getDefaultUserName();
    assert.equal(req.body.userName, expected);
    assert.equal(req.body.options.userName, expected);
    assert.equal(req.body.profile.userName, expected);
    assert.equal(req.body.settings.userName, expected);
});

test('applyDefaultUserToRequest: overrides any client-supplied userName (no spoofing)', () => {
    const req = { body: { userName: 'attacker', options: { userName: 'attacker' } } };
    authConfig.applyDefaultUserToRequest(req);

    const expected = authConfig.getDefaultUserName();
    assert.equal(req.body.userName, expected);
    assert.equal(req.body.options.userName, expected);
    assert.notEqual(req.body.userName, 'attacker');
});

test('applyDefaultUserToRequest: tolerates a missing/partial body', () => {
    // Must not throw on requests without a body or without sub-objects.
    assert.doesNotThrow(() => authConfig.applyDefaultUserToRequest({}));
    assert.doesNotThrow(() => authConfig.applyDefaultUserToRequest({ body: {} }));
});

test('ensureOptionsUserName: creates options when absent and stamps the user', () => {
    const created = authConfig.ensureOptionsUserName(undefined);
    assert.equal(created.userName, authConfig.getDefaultUserName());

    const existing = authConfig.ensureOptionsUserName({ foo: 'bar' });
    assert.equal(existing.userName, authConfig.getDefaultUserName());
    assert.equal(existing.foo, 'bar');
});

"use strict";

// Guards the rebrandable-config surface. appConfig reads config.properties at
// require time; these assert the shape/contract the app and frontend rely on,
// and that the route base is always a single leading-slash prefix.

const test = require('node:test');
const assert = require('node:assert/strict');

const appConfig = require('../lib/appConfig');

test('getRouteBase: is a single leading-slash prefix derived from routePrefix', () => {
    const base = appConfig.getRouteBase();
    assert.match(base, /^\/[^/]+$/, 'route base should look like "/signbridge"');
    assert.equal(base, '/' + appConfig.getRoutePrefix());
});

test('getDashboardPath: hangs off the route base', () => {
    assert.equal(appConfig.getDashboardPath(), appConfig.getRouteBase() + '/dashboard');
});

test('branding getters return non-empty strings', () => {
    for (const fn of ['getProjectName', 'getDisplayName', 'getTagline', 'getEngineName']) {
        const val = appConfig[fn]();
        assert.equal(typeof val, 'string', fn + ' should return a string');
        assert.ok(val.length > 0, fn + ' should be non-empty');
    }
});

test('getAuthModeLabels: exposes a label for exactly the supported auth modes', () => {
    // Asserted against the registry rather than a hardcoded list, so adding a
    // profile type without giving it a display label fails here.
    const authnModes = require('../lib/authnModes');
    const labels = appConfig.getAuthModeLabels();
    const keys = Object.keys(labels).sort();
    assert.deepEqual(keys, authnModes.ALL_MODES.slice().sort());
    for (const k of keys) {
        assert.ok(labels[k] && labels[k].length > 0, 'label for ' + k + ' should be non-empty');
    }
});

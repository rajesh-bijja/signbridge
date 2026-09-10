"use strict";

// Every SPA route is mounted under the app's route prefix (`/signbridge/...`,
// from `[app] routePrefix`), and App.jsx ends its route table with a catch-all
// that redirects to the dashboard. Together those two facts make a bare
// in-app link a silent bug: `<Link to="/settings">` compiles, renders, is
// clickable, matches no route, and quietly lands the user on the dashboard.
//
// That is exactly what four links did — the "Set up AI provider" button and the
// "Chat needs an AI provider" alert both sent the user *away* from the page
// that would have fixed the problem they were being told about. Nothing failed,
// no console error, and the only way to notice is to click it.
//
// So the rule is: an in-app navigation target is built with appPath(). This test
// reads the source to enforce it, because there is no runtime signal to catch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'frontend', 'src');

function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function collectSources(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectSources(full));
        } else if (/\.(jsx?|mjs)$/.test(entry.name)) {
            out.push({
                file: path.relative(SRC_DIR, full),
                code: stripComments(fs.readFileSync(full, 'utf8'))
            });
        }
    }
    return out;
}

// A router `to=` / an `href=` / a location assignment whose value is a literal
// absolute path. Route *definitions* use `path=`, so "/" and "*" there are
// untouched by this.
const LITERAL_TARGETS = [
    { what: 'to=', re: /\bto=(?:"(\/[^"]*)"|'(\/[^']*)'|\{\s*["'`](\/[^"'`]*)["'`]\s*\})/g },
    { what: 'href=', re: /\bhref=(?:"(\/[^"]*)"|'(\/[^']*)'|\{\s*["'`](\/[^"'`]*)["'`]\s*\})/g },
    { what: 'window.location', re: /window\.location(?:\.href)?\s*=\s*["'`](\/[^"'`]*)["'`]/g }
];

test('no in-app navigation target is a bare absolute path', () => {
    const offenders = [];
    for (const { file, code } of collectSources(SRC_DIR)) {
        for (const { what, re } of LITERAL_TARGETS) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(code)) !== null) {
                const target = m[1] || m[2] || m[3];
                offenders.push(file + ': ' + what + '"' + target + '"');
            }
        }
    }
    assert.deepEqual(
        offenders,
        [],
        'these navigate outside the route prefix and land on the dashboard; '
            + 'wrap them in appPath():\n  ' + offenders.join('\n  ')
    );
});

test('the AI-setup links point at Settings, where the AI settings are', () => {
    // The specific regression, pinned by name: these two are the app's answer to
    // "chat is not configured", so sending them anywhere but Settings makes the
    // message a dead end.
    const files = ['components/ChatPanel.jsx', 'components/llm/ModelPicker.jsx'];
    for (const rel of files) {
        const code = stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8'));
        assert.match(
            code,
            /appPath\(\s*['"]\/settings['"]\s*\)/,
            rel + ' should link to Settings through appPath()'
        );
        assert.match(code, /from ['"](?:\.\.\/)+appConfig['"]/, rel + ' should import appPath');
    }
});

test('appPath is what the route table itself uses, so the two cannot drift', () => {
    // If App.jsx ever mounted routes at bare paths instead, the rule above would
    // be backwards. Assert the direction rather than assuming it.
    const app = stripComments(fs.readFileSync(path.join(SRC_DIR, 'App.jsx'), 'utf8'));
    assert.match(app, /<Route\s+path=\{appPath\('\/settings'\)\}/, 'Settings route is prefixed');
    assert.match(app, /path="\*"/, 'the catch-all is what makes an unprefixed link silent');
});

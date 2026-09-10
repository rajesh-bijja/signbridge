"use strict";

// lib/netGuard.js — who can reach SignBridge, and what a browser may do with the
// origin once it has.
//
// SignBridge has no login and signs with every AWS profile on the machine, so the
// bind address is the whole of its access control. Every failure in this area is
// silent by construction: binding 0.0.0.0 serves the app perfectly, and so does
// answering for a Host header belonging to someone else's domain. There is no
// error, no log line and no broken page — which is exactly why these are pinned
// here, and why half of this file reads the sources rather than calling them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const netGuard = require('../lib/netGuard');

const repoRoot = path.resolve(__dirname, '..');
function read(rel) {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}
// A fake properties-reader: the real one needs a file on disk.
function props(values) {
    return { get: function (key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; } };
}

test('resolveBindHost defaults to loopback', function () {
    // The whole point. An accidental removal of the default, or a rename of the
    // config key, must not silently fall back to "all interfaces".
    assert.strictEqual(netGuard.resolveBindHost(props({}), {}), '127.0.0.1');
    assert.strictEqual(netGuard.resolveBindHost(null, null), '127.0.0.1');
    assert.strictEqual(netGuard.resolveBindHost(props({ 'server.bindHost': '' }), {}), '127.0.0.1');
    assert.strictEqual(netGuard.resolveBindHost(props({ 'server.bindHost': '   ' }), { BIND_HOST: '  ' }), '127.0.0.1');
});

test('resolveBindHost precedence is BIND_HOST, then config, then loopback', function () {
    // The env var wins because the container needs 0.0.0.0 and sets it there —
    // rather than the shipped config file carrying the loose value.
    assert.strictEqual(
        netGuard.resolveBindHost(props({ 'server.bindHost': '127.0.0.1' }), { BIND_HOST: '0.0.0.0' }),
        '0.0.0.0');
    assert.strictEqual(
        netGuard.resolveBindHost(props({ 'server.bindHost': '192.168.1.50' }), {}),
        '192.168.1.50');
    assert.strictEqual(
        netGuard.resolveBindHost(props({ 'server.bindHost': ' 127.0.0.1 ' }), {}),
        '127.0.0.1');
});

test('isLoopbackAddress covers all of 127/8 and the IPv6 loopback', function () {
    ['127.0.0.1', '127.1.2.3', '127.0.0.53', '127.255.255.255', 'localhost', 'LOCALHOST',
        '::1', '[::1]', '0:0:0:0:0:0:0:1']
        .forEach(function (h) {
            assert.strictEqual(netGuard.isLoopbackAddress(h), true, 'loopback: ' + h);
        });
    ['0.0.0.0', '', '10.0.0.1', '192.168.1.50', '128.0.0.1', '27.0.0.1', 'example.com',
        '127.0.0.1.evil.com', undefined, null, 12]
        .forEach(function (h) {
            assert.strictEqual(netGuard.isLoopbackAddress(h), false, 'not loopback: ' + h);
        });
});

test('the bind warning and the Host check agree on what loopback means', function () {
    // Two rules for one question is how 127.0.0.53 ended up "safe to bind" and
    // "not us" at the same time. isHostAllowed must defer to isLoopbackAddress.
    ['127.0.0.1', '127.0.0.53', 'localhost', '::1', '0.0.0.0', '192.168.1.50', 'example.com']
        .forEach(function (h) {
            assert.strictEqual(
                netGuard.isHostAllowed(h, {}),
                netGuard.isLoopbackAddress(h),
                'the two must agree about ' + h);
        });
    const fnStart = netGuard.isHostAllowed.toString();
    assert.match(fnStart, /isLoopbackAddress/,
        'isHostAllowed should call isLoopbackAddress rather than keep its own list');
});

test('hostNameOf strips the port and the IPv6 brackets', function () {
    assert.strictEqual(netGuard.hostNameOf('localhost:2443'), 'localhost');
    assert.strictEqual(netGuard.hostNameOf('localhost'), 'localhost');
    assert.strictEqual(netGuard.hostNameOf('127.0.0.1:2443'), '127.0.0.1');
    assert.strictEqual(netGuard.hostNameOf('[::1]:2443'), '::1');
    assert.strictEqual(netGuard.hostNameOf('[::1]'), '::1');
    assert.strictEqual(netGuard.hostNameOf('[fd00::1]:2443'), 'fd00::1');
    assert.strictEqual(netGuard.hostNameOf('  LocalHost:2443 '), 'localhost');
    assert.strictEqual(netGuard.hostNameOf(undefined), '');
    assert.strictEqual(netGuard.hostNameOf(null), '');

    // An unbracketed IPv6 literal has no port to strip. Splitting on the first
    // colon would give '', which isHostAllowed treats as a missing Host header —
    // so a client sending the loopback address this way would be refused.
    assert.strictEqual(netGuard.hostNameOf('::1'), '::1');
    assert.strictEqual(netGuard.hostNameOf('0:0:0:0:0:0:0:1'), '0:0:0:0:0:0:0:1');
});

test('isHostAllowed accepts the browser and the app talking to itself', function () {
    // These are the values that actually occur: the address bar, and SignBridge's
    // own loopback self-calls (chat -> its own API, MCP -> its own API).
    ['localhost:2443', 'localhost', '127.0.0.1:2443', '127.0.0.1', '[::1]:2443', '[::1]', '::1',
        '0:0:0:0:0:0:0:1', '127.0.0.53']
        .forEach(function (h) {
            assert.strictEqual(netGuard.isHostAllowed(h, {}), true, 'should answer for: ' + h);
        });
});

test('isHostAllowed refuses a name it was not configured for', function () {
    // The DNS-rebinding case: the attacker's page resolves evil.com to 127.0.0.1,
    // so the request arrives on loopback but carries their name in Host.
    ['evil.com', 'evil.com:2443', 'localhost.evil.com', 'signbridge.internal', '192.168.1.50:2443']
        .forEach(function (h) {
            assert.strictEqual(netGuard.isHostAllowed(h, {}), false, 'should refuse: ' + h);
        });
    // A missing Host cannot be assumed local — HTTP/1.1 requires one.
    assert.strictEqual(netGuard.isHostAllowed(undefined, {}), false);
    assert.strictEqual(netGuard.isHostAllowed('', {}), false);
    assert.strictEqual(netGuard.isHostAllowed(null, { allowedHosts: [] }), false);
});

test('isHostAllowed honours allowedHosts by name or name:port', function () {
    let allowed = netGuard.resolveAllowedHosts(props({
        'server.allowedHosts': 'signbridge.internal, 192.168.1.50:2443'
    }));
    assert.deepStrictEqual(allowed, ['signbridge.internal', '192.168.1.50:2443']);

    assert.strictEqual(netGuard.isHostAllowed('signbridge.internal', { allowedHosts: allowed }), true);
    // A bare name in the list matches whatever port it arrives on.
    assert.strictEqual(netGuard.isHostAllowed('signbridge.internal:2443', { allowedHosts: allowed }), true);
    assert.strictEqual(netGuard.isHostAllowed('SIGNBRIDGE.INTERNAL:2443', { allowedHosts: allowed }), true);
    assert.strictEqual(netGuard.isHostAllowed('192.168.1.50:2443', { allowedHosts: allowed }), true);
    // Listing it as host:port does not admit a different port.
    assert.strictEqual(netGuard.isHostAllowed('192.168.1.50:9999', { allowedHosts: allowed }), false);
    assert.strictEqual(netGuard.isHostAllowed('other.internal', { allowedHosts: allowed }), false);
    // Loopback keeps working alongside it.
    assert.strictEqual(netGuard.isHostAllowed('localhost:2443', { allowedHosts: allowed }), true);
});

test('isHostAllowed does not key off the bind address', function () {
    // It once took a bindHost and allowed everything when that was non-loopback.
    // docker-compose sets BIND_HOST=0.0.0.0, so that would have disabled the
    // rebinding check in the primary deployment — the one place it matters most.
    assert.strictEqual(netGuard.isHostAllowed('evil.com', { allowedHosts: [], bindHost: '0.0.0.0' }), false);
    const source = read('lib/netGuard.js');
    const fnStart = source.indexOf('function isHostAllowed(');
    const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart));
    assert.doesNotMatch(fnBody, /bindHost/,
        'isHostAllowed must not consult the bind address: BIND_HOST=0.0.0.0 in the container'
        + ' would then switch the Host check off wherever it is needed most.');
});

test('resolveAllowedHosts is empty when unset', function () {
    assert.deepStrictEqual(netGuard.resolveAllowedHosts(props({})), []);
    assert.deepStrictEqual(netGuard.resolveAllowedHosts(props({ 'server.allowedHosts': '' })), []);
    assert.deepStrictEqual(netGuard.resolveAllowedHosts(props({ 'server.allowedHosts': ' , , ' })), []);
    assert.deepStrictEqual(netGuard.resolveAllowedHosts(null), []);
});

test('securityHeaders keeps the four that protect a credential-holding origin', function () {
    const headers = netGuard.securityHeaders();

    // A presigned URL *is* a credential, and it appears in the address bar and in
    // links the app renders. Sending it in a Referer hands it to a third party.
    assert.strictEqual(headers['Referrer-Policy'], 'no-referrer');
    // Profile forms hold AWS secret keys and SSH private keys in the DOM.
    assert.strictEqual(headers['X-Frame-Options'], 'DENY');
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    // A JSON response must never be re-read as HTML.
    assert.strictEqual(headers['X-Content-Type-Options'], 'nosniff');
    assert.strictEqual(headers['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('the CSP admits no third-party script origin', function () {
    const csp = netGuard.CSP;
    const directives = {};
    csp.split(';').forEach(function (part) {
        let bits = part.trim().split(/\s+/);
        directives[bits[0]] = bits.slice(1);
    });

    assert.deepStrictEqual(directives['default-src'], ["'self'"]);
    assert.deepStrictEqual(directives['object-src'], ["'none'"]);
    assert.deepStrictEqual(directives['base-uri'], ["'self'"]);
    assert.deepStrictEqual(directives['form-action'], ["'self'"]);

    // 'unsafe-eval' and blob: are Monaco's workers and are documented in the
    // module. What must never appear is a host or a scheme that could serve
    // someone else's script into an origin holding AWS credentials.
    directives['script-src'].forEach(function (token) {
        assert.ok(["'self'", "'unsafe-eval'", 'blob:'].indexOf(token) !== -1,
            'unexpected script-src token: ' + token);
    });
    // Inline script is the one concession NOT made: it is what turns any HTML
    // injection into code execution on this origin.
    assert.ok(directives['script-src'].indexOf("'unsafe-inline'") === -1,
        "script-src must not allow 'unsafe-inline'");
});

// --- Source inspection: the guards must stay wired ----------------------------

test('server.js binds the resolved host rather than every interface', function () {
    const source = read('server.js');
    // `server.listen(port)` is the whole bug: it binds 0.0.0.0 and works fine.
    assert.match(source, /server\.listen\(\s*port\s*,\s*bindHost\s*\)/,
        'server.listen() must be given a host. Called with the port alone it binds'
        + ' 0.0.0.0, publishing an unauthenticated credential proxy to the network'
        + ' with nothing to indicate it.');
    assert.match(source, /netGuard\.resolveBindHost\(\s*props\s*,\s*process\.env\s*\)/);
    // And it must say something out loud when the address is not loopback, since
    // nothing else reveals it. The wording lives in netGuard so it can be tested;
    // server.js must pass the real port and the real container answer, because
    // those are the two inputs that decide which of the two messages is true.
    assert.match(source, /netGuard\.describeBindExposure\(\s*bindHost/,
        'a non-loopback bind must be reported, since nothing else reveals it');
    assert.match(source, /container:\s*netGuard\.isContainer\(\)/,
        'the container answer must be passed in — a container bound to 0.0.0.0 is'
        + ' expected, a laptop process bound to 0.0.0.0 is not, and one message'
        + ' cannot be right for both');
    assert.match(source, /log\[\s*exposure\.level\s*\]\(\s*exposure\.message\s*\)/,
        'and it must be logged at the level netGuard chose');
});

test('the bind message fits the environment it fires in', function () {
    // This message used to be a single WARN telling the reader to set
    // bindHost=127.0.0.1 — advice that would have made the container unreachable
    // through its own published port, printed on every single normal startup. A
    // warning that fires on the supported configuration and recommends a fix that
    // breaks it is worse than no warning at all.
    assert.strictEqual(netGuard.describeBindExposure('127.0.0.1', { port: 2443 }), null,
        'loopback is the default and needs no commentary');
    assert.strictEqual(netGuard.describeBindExposure('::1', { container: true }), null);

    const inContainer = netGuard.describeBindExposure('0.0.0.0', { port: 2443, container: true });
    assert.strictEqual(inContainer.level, 'info',
        'in a container 0.0.0.0 is mandatory, so it is not a warning');
    assert.match(inContainer.message, /127\.0\.0\.1:2443/,
        'it must name the host port mapping, which is what actually limits access there');
    assert.doesNotMatch(inContainer.message, /set \[server\] bindHost=127\.0\.0\.1/,
        'and must not give the advice that breaks the container');

    const onHost = netGuard.describeBindExposure('0.0.0.0', { port: 2443 });
    assert.strictEqual(onHost.level, 'warn');
    assert.match(onHost.message, /other machines on your network/,
        '"every host that can reach port 2443" was read as "every process on my own'
        + ' laptop", which is not a risk — name who can actually reach it');
    assert.match(onHost.message, /bindHost=127\.0\.0\.1/, 'here the advice is correct');

    // A startup log line is read to find out whether something is wrong, not to be
    // taught container networking. Both of these were a paragraph; a paragraph in a
    // log is skipped, which costs more than the detail it carried was worth.
    [inContainer, onHost].forEach(function (m) {
        assert.ok(m.message.length < 220, 'keep it to one line: ' + m.message);
        assert.ok(m.message.split('. ').length <= 3, 'at most two sentences: ' + m.message);
    });
});

test('isContainer probes both markers and never throws', function () {
    // Injected fs: the point is that a missing /proc (macOS, where SignBridge is
    // developed) must read as "not a container" rather than crash startup.
    const throwing = {
        existsSync: function () { throw new Error('nope'); },
        readFileSync: function () { throw new Error('nope'); }
    };
    assert.strictEqual(netGuard.isContainer(throwing), false);

    assert.strictEqual(netGuard.isContainer({
        existsSync: function (p) { return p === '/.dockerenv'; },
        readFileSync: function () { throw new Error('unused'); }
    }), true, '/.dockerenv is the cheap answer');

    assert.strictEqual(netGuard.isContainer({
        existsSync: function () { return false; },
        readFileSync: function () { return '0::/kubepods/besteffort/pod123/abc\n'; }
    }), true, 'and cgroup is the fallback for runtimes that omit /.dockerenv');

    assert.strictEqual(netGuard.isContainer({
        existsSync: function () { return false; },
        readFileSync: function () { return '0::/user.slice/user-501.slice\n'; }
    }), false);
});

test('server.js checks the Host header before any handler runs', function () {
    const source = read('server.js');
    assert.match(source, /netGuard\.isHostAllowed\(\s*req\.headers\.host/);
    assert.match(source, /status\(421\)/, 'a refused Host should answer 421 Misdirected Request');

    const guardAt = source.indexOf('netGuard.isHostAllowed');
    const routerAt = source.search(/app\.use\(\s*routeBase/);
    assert.notStrictEqual(routerAt, -1, 'the router should still be mounted with app.use(routeBase');
    assert.ok(guardAt !== -1 && guardAt < routerAt,
        'the Host check must be installed before the router, or the routes it protects'
        + ' answer first.');

    // The headers go on every response, from the same early middleware.
    assert.match(source, /netGuard\.securityHeaders\(\)/);
    const headersAt = source.indexOf('netGuard.securityHeaders()');
    assert.ok(headersAt < routerAt, 'security headers must be set before the router');
});

test('the S3 object proxy still overrides the app-wide CSP', function () {
    // That route serves untrusted object bytes from this credential-holding
    // origin, so its policy is far stricter and must win. res.setHeader replaces;
    // a switch to something that merges or appends would weaken it silently.
    const source = read('lib/s3/s3World.js');
    assert.match(
        source,
        /res\.setHeader\('Content-Security-Policy',\s*\n?\s*"default-src 'none'; sandbox; frame-ancestors 'none'"\)/,
        'the object proxy must keep setting its own stricter CSP via res.setHeader, which'
        + ' replaces the app-wide one.');
});

test('the shipped deployment publishes to loopback and binds all interfaces inside', function () {
    const compose = read('docker-compose.yml');
    // Both halves matter and they are easy to conflate: publish to 127.0.0.1 on
    // the HOST, bind 0.0.0.0 INSIDE the container (a container process bound to
    // its own loopback is not reachable through a published port at all).
    assert.match(compose, /\$\{BIND_ADDRESS:-127\.0\.0\.1\}:\$\{HTTPS_PORT:-2443\}:2443/,
        'compose must publish to 127.0.0.1 by default, not to 0.0.0.0 (a bare "2443:2443")');
    assert.match(compose, /BIND_HOST:\s*0\.0\.0\.0/);

    const launcher = read('launchSignBridge');
    assert.match(launcher, /BIND_ADDRESS="\$\{BIND_ADDRESS:-127\.0\.0\.1\}"/);
    assert.match(launcher, /--publish \$\{BIND_ADDRESS\}:\$\{HTTPS_PORT_EXT\}:\$\{HTTPS_PORT_INT\}/,
        'the launcher must publish to $BIND_ADDRESS; `docker run -p 2443:2443` binds 0.0.0.0');
    assert.match(launcher, /-e BIND_HOST=0\.0\.0\.0/);
});

test('the shipped deployment does not switch off TLS verification process-wide', function () {
    // NODE_TLS_REJECT_UNAUTHORIZED=0 was set in both the image and compose so the
    // app could reach its own self-signed endpoint. But it is process-global, so it
    // also stopped verifying certificates on every outbound call — STS, IAM, S3,
    // EKS, the LLM provider — which on a hostile network is a credential handover
    // that nothing logs and no test notices. The loopback callers scope it to
    // themselves with their own https.Agent, which is why removing it is safe.
    [['Dockerfile', read('Dockerfile')], ['docker-compose.yml', read('docker-compose.yml')]]
        .forEach(function (row) {
            const code = row[1].split('\n')
                .filter(function (line) { return !/^\s*#/.test(line); })
                .join('\n');
            assert.doesNotMatch(code, /NODE_TLS_REJECT_UNAUTHORIZED/,
                row[0] + ' must not set NODE_TLS_REJECT_UNAUTHORIZED. Give the one caller that'
                + ' needs it an https.Agent with rejectUnauthorized:false, or add a trust'
                + ' anchor with NODE_EXTRA_CA_CERTS as lib/chat/cursorAgent.js does.');
        });

    // And the loopback callers must keep doing it themselves, or removing the
    // global switch breaks chat and MCP instead of tightening them.
    ['mcp/server.js', 'mcp/mcpHttp.mjs', 'lib/chat/agent.js'].forEach(function (file) {
        assert.match(read(file), /new https\.Agent\(\{\s*rejectUnauthorized: false\s*\}\)/,
            file + ' calls SignBridge\'s own HTTPS API and must carry its own agent');
    });
});

test('config.properties.example documents both knobs', function () {
    // These are the two settings an operator has to find in order to expose the
    // app deliberately. Undocumented, the discoverable workaround is 0.0.0.0.
    const example = read('config.properties.example');
    assert.match(example, /^bindHost=127\.0\.0\.1$/m);
    assert.match(example, /^allowedHosts=$/m);
    assert.match(example, /BIND_HOST/, 'the env override should be named');
    assert.match(example, /rebinding/i, 'allowedHosts should say what it defends against');
});

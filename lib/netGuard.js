"use strict";

/**
 * netGuard.js
 *
 * Who can reach SignBridge, and what a browser is allowed to do with the origin
 * once it does.
 *
 * SignBridge has no login — deliberately, it is a local tool for one person — and
 * it holds live AWS credentials for every profile on the machine. So the network
 * surface *is* the authorization boundary, and there are three separate ways to
 * get it wrong:
 *
 *   1. `server.listen(port)` with no host binds 0.0.0.0. On a laptop on a café or
 *      office network, that publishes an unauthenticated API that can presign and
 *      invoke with the user's IAM and SSO credentials, browse S3 and run arbitrary
 *      code in Sandbox. Nothing visible changes, which is why it survived four
 *      reviews. `resolveBindHost` defaults to loopback.
 *
 *   2. Binding loopback is not sufficient on its own. Any web page can resolve a
 *      name it controls to 127.0.0.1 and then talk to this origin as same-origin —
 *      DNS rebinding. The defence is to check the `Host` header, because the
 *      attacker's page must send its own name there. `isHostAllowed` does that.
 *
 *   3. The credential-holding origin serves a SPA whose profile forms hold secret
 *      access keys and SSH private keys in the DOM. `securityHeaders` keeps that
 *      DOM from being framed, keeps URLs (presigned ones are credentials) out of
 *      `Referer`, and keeps a content type from being re-sniffed into something
 *      executable.
 *
 * All three decisions are pure functions of their inputs, so the tests need no
 * socket and no browser.
 *
 * On the CSP below: the strong directives are the ones doing the work —
 * `frame-ancestors`, `object-src 'none'`, `base-uri`, `form-action`, and a
 * `script-src` that admits no third-party origin. The `unsafe-inline` on styles
 * (Cloudscape and Bootstrap both inject them), the `unsafe-eval` and `blob:` on
 * scripts (Monaco's workers) and the `ws:`/`wss:` on `connect-src` (Socket.IO)
 * are concessions to what the app actually does. A policy tight enough to reject
 * one of those would break the UI in a way nothing reports, which is worse than a
 * policy that is honest about its limits: this origin serves no untrusted HTML —
 * `lib/s3/s3World.js` sets its own far stricter policy on the one route that
 * serves object bytes, and that one must keep overriding this.
 */

// The named loopback spellings. Compared against the output of hostNameOf(),
// which strips the port and the IPv6 brackets, so the form a browser actually
// sends ([::1]:2443) is already normalised to one of these.
const LOOPBACK_HOSTS = ['localhost', '::1', '0:0:0:0:0:0:0:1'];

// The plain-HTTP MCP listener's port when nothing says otherwise. One above the
// HTTPS port, so the pair is easy to remember and to publish.
const DEFAULT_MCP_HTTP_PORT = 2444;

/**
 * Is this a loopback address — any of 127.0.0.0/8, or the IPv6 loopback?
 *
 * The one rule, used for two separate questions: whether the address we bound is
 * safe (server.js logs a warning if not) and whether a Host header names us
 * (isHostAllowed). They were briefly two rules — an exact list here and a range
 * check there — which meant 127.0.0.53 counted as loopback for the warning and
 * not for the Host check, i.e. the app refused to answer on an address it had
 * just told the operator was fine.
 */
function isLoopbackAddress(host) {
    if (typeof host !== 'string') {
        return false;
    }
    let h = host.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) {
        h = h.slice(1, -1);
    }
    if (LOOPBACK_HOSTS.indexOf(h) !== -1) {
        return true;
    }
    return /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * The address to bind. Precedence: BIND_HOST in the environment, then
 * `[server] bindHost` in config.properties, then loopback.
 *
 * The container is the reason the env var comes first: inside it the process must
 * bind 0.0.0.0 to be reachable through the published port at all, and the
 * published port is what compose pins to 127.0.0.1 on the host. So the default is
 * safe for `npm start` and compose sets the env var — rather than the config file
 * shipping the loose value that the safe default exists to avoid.
 */
function resolveBindHost(props, env) {
    let e = env || {};
    if (e.BIND_HOST && String(e.BIND_HOST).trim()) {
        return String(e.BIND_HOST).trim();
    }
    let configured = props && typeof props.get === 'function' ? props.get('server.bindHost') : null;
    if (configured && String(configured).trim()) {
        return String(configured).trim();
    }
    return '127.0.0.1';
}

/**
 * The extra Host values an operator has declared acceptable.
 * `[server] allowedHosts` — comma-separated, host or host:port, case-insensitive.
 */
function resolveAllowedHosts(props) {
    let configured = props && typeof props.get === 'function' ? props.get('server.allowedHosts') : null;
    if (!configured) {
        return [];
    }
    return String(configured)
        .split(',')
        .map(function (h) { return h.trim().toLowerCase(); })
        .filter(function (h) { return h.length > 0; });
}

/**
 * The bare host name from a Host header: no port, no IPv6 brackets.
 *
 * Three shapes have to be told apart, and getting the third wrong is a security
 * bug rather than a cosmetic one:
 *   localhost:2443   -> localhost      (name and port)
 *   [::1]:2443       -> ::1            (bracketed literal, what browsers send)
 *   ::1              -> ::1            (bare literal — no port to strip)
 * Splitting the last one on its first colon yields the empty string, which
 * isHostAllowed reads as "no Host header at all" and refuses.
 */
function hostNameOf(hostHeader) {
    let h = String(hostHeader === null || hostHeader === undefined ? '' : hostHeader).trim().toLowerCase();
    if (h.startsWith('[')) {
        let close = h.indexOf(']');
        return close === -1 ? h.slice(1) : h.slice(1, close);
    }
    let colon = h.indexOf(':');
    if (colon === -1) {
        return h;
    }
    // A second colon with no brackets means an unbracketed IPv6 literal. RFC 7230
    // requires the brackets, so no browser sends this — but a hand-built client
    // or an SDK can, and SignBridge's own loopback self-calls go through the same
    // check.
    if (h.indexOf(':', colon + 1) !== -1) {
        return h;
    }
    return h.slice(0, colon);
}

/**
 * Is this request's Host header one we are willing to answer for?
 *
 * `opts.allowedHosts` — the names the operator declared, host or host:port.
 *
 * Loopback names, plus that list, and nothing else. Deliberately independent of
 * what the server bound: in the container the process must bind 0.0.0.0 to be
 * reachable through the published port, so keying the check on the bind address
 * would switch it off in exactly the deployment most people use. The browser
 * still asks for `localhost` there, because compose publishes the port to
 * 127.0.0.1 on the host.
 *
 * The cost is that someone who deliberately exposes the app and reaches it by LAN
 * address or DNS name gets a 421 until they list that name. That is the right
 * trade: the failure is immediate and the response says what to set, whereas the
 * alternative failure — a page on the internet resolving its own name to
 * 127.0.0.1 and then driving this API as same-origin — is silent and total.
 */
function isHostAllowed(hostHeader, opts) {
    let options = opts || {};
    let allowed = options.allowedHosts || [];
    let name = hostNameOf(hostHeader);
    let full = String(hostHeader === null || hostHeader === undefined ? '' : hostHeader).trim().toLowerCase();

    if (allowed.indexOf(full) !== -1 || allowed.indexOf(name) !== -1) {
        return true;
    }
    // A missing Host header cannot be assumed local: HTTP/1.1 requires one and
    // every browser sends it, so its absence means a hand-built client.
    if (!name) {
        return false;
    }
    return isLoopbackAddress(name);
}

/**
 * Are we running inside a container?
 *
 * Asked only to word the bind message, and it has to be asked because 0.0.0.0
 * means opposite things either side of the boundary: in a container it is
 * mandatory (nothing published would reach the process otherwise), on a laptop it
 * publishes to the network. The advice that fits one breaks the other.
 *
 * `fsLike` is injected so the test needs no container. Both probes are
 * best-effort: a false negative only costs a more cautious sentence.
 */
function isContainer(fsLike) {
    let f = fsLike || require('fs');
    try {
        if (f.existsSync('/.dockerenv')) {
            return true;
        }
    } catch (e) { /* fall through to the cgroup probe */ }
    try {
        return /docker|containerd|kubepods|podman|lxc/i.test(f.readFileSync('/proc/1/cgroup', 'utf8'));
    } catch (e) {
        return false;
    }
}

/**
 * What to say at startup about the address we bound: `null` when there is
 * nothing to say, otherwise `{ level, message }`.
 *
 * Two rules, and both were learned by getting them wrong.
 *
 * One line each. This started as a paragraph explaining container networking,
 * which is the wrong thing to put in a startup log: nobody reads a log to be
 * taught, they read it to find out whether something is wrong. State the
 * situation and the one knob that changes it.
 *
 * And the container case is INFO, not WARN. Under compose the bind is 0.0.0.0 by
 * necessity, so a warning there fires on every normal startup — and its advice,
 * "set bindHost=127.0.0.1", would have made the container unreachable through its
 * own published port. A warning that fires on the supported configuration and
 * recommends a fix that breaks it teaches the reader to skip warnings.
 */
function describeBindExposure(bindHost, opts) {
    let options = opts || {};
    let port = options.port || 2443;
    if (isLoopbackAddress(bindHost)) {
        return null;
    }
    if (options.container) {
        return {
            level: 'info',
            // Deliberately not stated as fact: this process cannot see the host
            // mapping, so it names the setting rather than claiming a value.
            message: 'bound to ' + bindHost + ' (normal in a container). Who can reach SignBridge is '
                + 'set by the host port mapping in docker-compose.yml — 127.0.0.1:' + port
                + ' keeps it to this machine only.'
        };
    }
    return {
        level: 'warn',
        message: 'bound to ' + bindHost + ', so other machines on your network can reach SignBridge, '
            + 'and it has no login — they would get your AWS profiles. Set [server] '
            + 'bindHost=127.0.0.1 for this machine only.'
    };
}

/**
 * The port for the plain-HTTP MCP listener. `[server] mcpHttpPort`, env override
 * MCP_HTTP_PORT; 0 (or any non-number) turns it off.
 */
function resolveMcpHttpPort(props, env) {
    let e = env || {};
    let raw = e.MCP_HTTP_PORT && String(e.MCP_HTTP_PORT).trim()
        ? String(e.MCP_HTTP_PORT).trim()
        : (props && typeof props.get === 'function' ? props.get('server.mcpHttpPort') : null);
    if (raw === null || raw === undefined || String(raw).trim() === '') {
        return DEFAULT_MCP_HTTP_PORT;
    }
    let n = parseInt(String(raw).trim(), 10);
    if (!isFinite(n) || n <= 0 || n > 65535) {
        return 0;
    }
    return n;
}

/**
 * Should the MCP endpoint also be served over plain HTTP, and where?
 * Returns `{ enabled, port, bindHost, url, level, message }`.
 *
 * Why a cleartext listener exists at all: SignBridge's TLS certificate is
 * self-signed, and an MCP client that connects with Node's `fetch` — Cursor, and
 * most others — rejects it and reports only `fetch failed`. There is no
 * per-server place in those clients to trust a certificate, and the one knob that
 * would work (NODE_TLS_REJECT_UNAUTHORIZED) is process-wide, so it would also
 * disable verification for everything else that client talks to. The Streamable
 * HTTP transport was therefore advertised and unusable.
 *
 * Cleartext is acceptable only because these bytes never leave the machine, so
 * that is exactly the condition checked: a loopback bind, or a container, where
 * the published port is what limits access. A non-loopback bind outside a
 * container is the one case it stays off — MCP tool results carry credentials, and
 * putting those on a network unencrypted is not the risk that operator opted into.
 */
function describeMcpHttpPlan(opts) {
    let options = opts || {};
    let port = options.port;
    let bindHost = options.bindHost || '127.0.0.1';
    let routeBase = options.routeBase || '';
    let url = 'http://localhost:' + port + routeBase + '/mcp';

    if (!port) {
        return {
            enabled: false,
            port: 0,
            bindHost: bindHost,
            url: null,
            level: 'info',
            message: 'MCP over plain HTTP is off ([server] mcpHttpPort=0). MCP clients that cannot '
                + 'trust a self-signed certificate should use the stdio transport instead.'
        };
    }
    if (!isLoopbackAddress(bindHost) && !options.container) {
        return {
            enabled: false,
            port: port,
            bindHost: bindHost,
            url: null,
            level: 'warn',
            message: 'MCP over plain HTTP is off because SignBridge is bound to ' + bindHost
                + ', which would put MCP traffic on your network unencrypted. Use the stdio '
                + 'transport, or set [server] bindHost=127.0.0.1.'
        };
    }
    return {
        enabled: true,
        port: port,
        bindHost: bindHost,
        url: url,
        level: 'info',
        message: 'MCP over HTTP at ' + url + ' (no TLS, this machine only — for MCP clients that '
            + 'reject the self-signed certificate). Set [server] mcpHttpPort=0 to turn it off.'
    };
}

const CSP = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    // XHR to our own API, and the Socket.IO upgrade.
    "connect-src 'self' ws: wss:",
    // The object viewer frames a PDF through a presigned URL on the S3 origin,
    // because the object proxy's own CSP forbids being framed at all.
    "frame-src 'self' https:",
    "frame-ancestors 'none'",
    "form-action 'self'"
].join('; ');

/**
 * The headers to set on every response this app serves.
 *
 * Returned as a plain object rather than applied here so a test can assert the
 * set without an Express app, and so the caller decides the order relative to
 * route handlers that legitimately override one (the S3 object proxy).
 */
function securityHeaders() {
    return {
        'Content-Security-Policy': CSP,
        // No sniffing: a JSON response must never be re-read as HTML.
        'X-Content-Type-Options': 'nosniff',
        // A presigned URL in a Referer header is a leaked credential. Send none.
        'Referrer-Policy': 'no-referrer',
        // Belt and braces with frame-ancestors, for anything that predates CSP2.
        'X-Frame-Options': 'DENY',
        'Cross-Origin-Opener-Policy': 'same-origin'
    };
}

module.exports = {
    LOOPBACK_HOSTS: LOOPBACK_HOSTS,
    DEFAULT_MCP_HTTP_PORT: DEFAULT_MCP_HTTP_PORT,
    CSP: CSP,
    resolveMcpHttpPort: resolveMcpHttpPort,
    describeMcpHttpPlan: describeMcpHttpPlan,
    isLoopbackAddress: isLoopbackAddress,
    isContainer: isContainer,
    describeBindExposure: describeBindExposure,
    resolveBindHost: resolveBindHost,
    resolveAllowedHosts: resolveAllowedHosts,
    hostNameOf: hostNameOf,
    isHostAllowed: isHostAllowed,
    securityHeaders: securityHeaders
};

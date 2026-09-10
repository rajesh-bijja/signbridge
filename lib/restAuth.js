/**
 * restAuth.js
 *
 * Generic REST authentication + invocation for SignBridge / SignBridge.
 *
 * Supports:
 *   - rest_basic_auth   : HTTP Basic auth (username/password)
 *   - rest_bearer_token : Bearer token, obtained either as a static pasted
 *                         token OR dynamically via a configurable OAuth2 token
 *                         endpoint (client_credentials or password grant).
 *   - generic           : unsigned pass-through request
 */
"use strict";

const { https } = require('follow-redirects');
const { http } = require('follow-redirects');
let profileUtils = require('./profileUtils');
let commonUtils = require('./commonUtils');
let authConfig = require('./authConfig');
let redact = require('./redact');
let url = require('url');
let TIMEOUT = 600000;
// jwt-decode v4 exports a named function (v3 had a default export).
const { jwtDecode } = require("jwt-decode");
let log = require('./logger').create('restAuth');

const FORM_URL_ENCODED_UTF8 = 'application/x-www-form-urlencoded;charset=UTF-8';
const FORM_URL_ENCODED_UTF8_2 = 'application/x-www-form-urlencoded; charset=UTF-8';
const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';
const FORM_URL_ENCODED = 'application/x-www-form-urlencoded';

// Cache OAuth2 token responses per profile so we don't re-fetch on every call.
let cachedTokenResponses = {};

try {
    if (process.env.TIMEOUT) {
        TIMEOUT = parseInt(process.env.TIMEOUT);
        log.debug('TIMEOUT specifed as ', TIMEOUT);
    } else {
        log.debug('TIMEOUT not specified defaulting to ', TIMEOUT);
    }
} catch(parseIntErr) {
    log.error('error in parsing and configuring the timeout: ', parseIntErr.message);
    TIMEOUT = 600000;
    log.debug('defaulting TIMEOUT to ', TIMEOUT);
}

function isFormUrlEncoded(headers) {
    if (!headers || !headers['content-type']) {
        return false;
    }
    let ct = headers['content-type'].toLowerCase();
    return ct === FORM_URL_ENCODED_UTF8.toLowerCase() ||
        ct === FORM_URL_ENCODED_UTF8_2.toLowerCase() ||
        ct === FORM_URL_ENCODED_UTF8_3.toLowerCase() ||
        ct === FORM_URL_ENCODED.toLowerCase();
}

function extractInputFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('request body not available'));
    }
    if(!req.body.options) {
        return cb(new Error('options not available in request payload'));
    }
    log.debug('generic payload provided : ', redact.forLog(req.body.options));
    let options = req.body.options;
    if(!options['userName']) {
        options['userName'] = authConfig.getDefaultUserName();
    }
    if(!options['endpoint']) {
        return cb(new Error('endpoint not provided in options payload'));
    }
    let result = commonUtils.resolveEndpoint(options['userName'], options['endpoint']);
    if (result.startsWith('ERROR:: ')) {
        return cb(new Error(result), options);
    }
    options['endpoint'] = result;
    let parsed = parseEndpointIntoOptions(options);
    if (parsed instanceof Error) {
        return cb(parsed);
    }
    if(options['body']) {
        if (isFormUrlEncoded(options['headers'])) {
            options['body'] = req.body.options.body;
        } else if (req.body.options.body instanceof Object) {
            options['body'] = JSON.stringify(req.body.options.body);
        }
    }
    cb(null, options);
}

function extractAuthSigningInputFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('extractAuthSigningInputFromRequest: request body not available'));
    }
    if(!req.body.options) {
        return cb(new Error('options not available in request payload'));
    }
    log.debug('rest payload provided : ', redact.forLog(req.body.options));
    let options = req.body.options;
    if(!options['userName']) {
        options['userName'] = authConfig.getDefaultUserName();
    }
    if(!options['endpoint']) {
        return cb(new Error('endpoint not provided in options payload'));
    }
    let result = commonUtils.resolveEndpoint(options['userName'], options['endpoint']);
    if (result.startsWith('ERROR:: ')) {
        return cb(new Error(result), options);
    }
    options['endpoint'] = result;
    let parsed = parseEndpointIntoOptions(options);
    if (parsed instanceof Error) {
        return cb(parsed);
    }
    if(!options['region']) {
        options.region = options.host.split('.')[1];
    }
    if(!options['method']) {
        return cb(new Error('http method not provided in request payload'));
    }
    let method = options['method'].toLowerCase();
    if (method === 'post' || method === 'put' || method === 'patch') {
        if (!options['headers'] || (!options['headers']['content-type'] && !options['headers']['Content-Type'])) {
            return cb(new Error('Content-Type not specified in the request payload'));
        }
    }
    if(options['body']) {
        if (isFormUrlEncoded(options['headers'])) {
            options['body'] = req.body.options.body;
        } else if (req.body.options.body instanceof Object) {
            options['body'] = JSON.stringify(req.body.options.body);
        }
    }
    if(!options['profileName']) {
        return cb(new Error('profileName not provided in request payload'));
    }
    return cb(null, options);
}

// Parse options.endpoint into protocol/host/port/path fields (mutates options).
function parseEndpointIntoOptions(options) {
    let reqUrl = url.parse(options['endpoint']);
    let protocol = reqUrl.protocol ? reqUrl.protocol.toLowerCase() : null;
    let port = reqUrl.port;
    if (!port) {
        if (protocol === 'https:') {
            port = 443;
        } else if (protocol === 'http:') {
            port = 80;
        } else {
            return new Error('Invalid protocol: [' + protocol + '] specified in request payload');
        }
    }
    options.protocol = protocol;
    options.host = reqUrl.hostname;
    options.port = port;
    options.path = reqUrl.path;
    options.pathname = reqUrl.pathname || '/';
    options.query = reqUrl.query || '';
    options.timeout = TIMEOUT;
    return options;
}

function logAndReturn(options, responseStatusCode, responseHeaders, data, res) {
    options = authConfig.ensureOptionsUserName(options);
    profileUtils.createHistory(options['userName'], options, responseStatusCode, responseHeaders, data, (createHistoryErr) => {
        if (createHistoryErr) {
            log.error('error in creating the history in [', options['authnMode'],  ']. error is : ', createHistoryErr);
            return res.status(400).json({'message': createHistoryErr.message});
        }
        return res.status(200).json({
            statusCode: responseStatusCode,
            headers: responseHeaders,
            response: data
        });
    });
}

// ---- Basic Auth ------------------------------------------------------------

function generateAuthResponseAndInvokeRestBasicAuth(req, res) {
    try {
        extractAuthSigningInputFromRequest(req, (err, options) => {
            if(err) {
                return logAndReturn(options, err.statusCode || 400, {}, {'message': err.message}, res);
            }
            profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
                if (searchErr) {
                    return logAndReturn(options, searchErr.statusCode || 400, {}, {'message': searchErr.message}, res);
                }
                if(!options['authnMode']) {
                    return logAndReturn(options, 400, {}, {'message': 'authnMode not provided in the payload. Can not invoke the url'}, res);
                }
                options['authnMode'] = options['authnMode'].toLowerCase();
                if (options['authnMode'] !== 'rest_basic_auth') {
                    return logAndReturn(options, 400, {}, {'message': 'invalid authnMode provided: ' + options['authnMode']}, res);
                }
                let basicAuthString = profile.basicAuthUsername + ":" + profile.basicAuthPassword;
                let base64BasicAuth = Buffer.from(basicAuthString, "utf8").toString("base64");
                options['headers'] = options['headers'] || {};
                options['headers']['Authorization'] = 'Basic ' + base64BasicAuth;
                invokeRestApi(options, (invokeErr, responseStatusCode, responseHeaders, data) => {
                    if (invokeErr) {
                        responseStatusCode = invokeErr.statusCode || 400;
                        responseHeaders = invokeErr.headers || {};
                        data = {'message': invokeErr.message};
                    }
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                });
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in generateAuthResponseAndInvokeRestBasicAuth: ', catchErr);
        logAndReturn({}, catchErr.statusCode || 400, {}, {'message': catchErr.message}, res);
    }
}

// ---- Generic (unsigned) ----------------------------------------------------

function generateAuthResponseAndInvokeGeneric(req, res) {
    try {
        extractInputFromRequest(req, (err, options) => {
            if(err) {
                return logAndReturn(options, err.statusCode || 400, {}, {'message': err.message}, res);
            }
            invokeRestApi(options, (invokeErr, responseStatusCode, responseHeaders, data) => {
                if (invokeErr) {
                    responseStatusCode = invokeErr.statusCode || 400;
                    responseHeaders = invokeErr.headers || {};
                    data = {'message': invokeErr.message};
                }
                return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in generateAuthResponseAndInvokeGeneric: ', catchErr);
        logAndReturn({}, catchErr.statusCode || 400, {}, {'message': catchErr.message}, res);
    }
}

// ---- Shared REST invocation ------------------------------------------------

function invokeRestApi(origOptions, cb) {
    let headers = origOptions['headers'] || {};
    let method = origOptions['method'];
    let protocol = origOptions['protocol'];
    delete headers['host'];
    headers['Accept'] = headers['Accept'] || 'application/json';
    if(origOptions['body'] != null && origOptions['body'].length != 0) {
        headers['Content-Length'] = origOptions['body'].length;
    }
    let options = {
        'method': method.toUpperCase(),
        'protocol': protocol,
        'hostname': origOptions['host'],
        'port': origOptions['port'],
        'path': origOptions['path'],
        'headers': headers,
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };
    let httpOrHttps;
    if (protocol === 'https:') {
        httpOrHttps = https;
    } else if (protocol === 'http:') {
        httpOrHttps = http;
    } else {
        return cb(new Error('Invalid protocol: [' + protocol + '] specified. Can not invoke endpoint.'));
    }

    let req = httpOrHttps.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
            if (!responseBody) {
                let err2 = new Error('REST ' + method + ' api response is empty.');
                err2.statusCode = res.statusCode;
                err2.headers = res.headers;
                return cb(err2);
            }
            log.debug('REST ' + method + ' api invocation response status: ', res.statusCode);
            if (res.statusCode == 200 || res.statusCode == 201) {
                try {
                    return cb(null, res.statusCode, res.headers, JSON.parse(responseBody));
                } catch(parseErr) {
                    return cb(null, res.statusCode, res.headers, responseBody);
                }
            }
            let err2 = new Error('Error in REST ' + method + ' api invocation: ' + res.statusCode + responseBody);
            err2.statusCode = res.statusCode;
            err2.headers = res.headers;
            return cb(err2);
        });
        res.on("error", (error) => {
            log.error('error response received in REST ' + method + ' api invocation call : ', error);
            return cb(error);
        });
    });

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to invoke REST ' + method + ' api : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] + options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.debug(message);
        return cb(new Error(message));
    });

    if (origOptions['body']) {
        req.write(origOptions['body']);
    }
    req.end();
}

// ---- Bearer token ----------------------------------------------------------

// Build the token-request body from the profile's customizable OAuth2 fields.
// bearerTokenFields is an array of { key, value } pairs the user configured
// (e.g. grant_type, client_id, client_secret, scope, audience, username,
// password, connection, ...). Sent as application/x-www-form-urlencoded.
function buildTokenRequestBody(profile) {
    let fields = Array.isArray(profile.bearerTokenFields) ? profile.bearerTokenFields : [];
    let params = [];
    fields.forEach((f) => {
        if (f && f.key) {
            params.push(encodeURIComponent(f.key) + '=' + encodeURIComponent(f.value != null ? f.value : ''));
        }
    });
    return params.join('&');
}

// Extract the token the user chose (access_token or id_token, default access_token).
function extractChosenToken(profile, data) {
    let field = profile.bearerTokenResponseField || 'access_token';
    if (data && data[field]) {
        return data[field];
    }
    // fall back to whichever is present
    if (data && data.access_token) return data.access_token;
    if (data && data.id_token) return data.id_token;
    return null;
}

// True when the profile opts into silent token regeneration on expiry.
function isAutoRenewEnabled(profile) {
    return profile && (profile.bearerAutoRenewOnExpiry === true || profile.bearerAutoRenewOnExpiry === 'true');
}

// Which OAuth2 grant the profile uses, inferred from its grant_type field.
function inferGrantType(profile) {
    let fields = Array.isArray(profile.bearerTokenFields) ? profile.bearerTokenFields : [];
    let gt = fields.find((f) => f && f.key === 'grant_type');
    return gt ? String(gt.value || '').toLowerCase() : '';
}

// Given the grant type and the tokens actually returned, decide which token to
// use as the bearer (or report why none is usable). Rules:
//   - client_credentials (and default): must have access_token, else error.
//   - password: prefer id_token; fall back to access_token; error only if both absent.
// Returns { field } on success or { error } describing the problem.
function recommendTokenField(grantType, availableTokens) {
    let tokens = availableTokens || [];
    if (grantType === 'password') {
        if (tokens.indexOf('id_token') !== -1) return { field: 'id_token' };
        if (tokens.indexOf('access_token') !== -1) return { field: 'access_token' };
        return { error: 'The token endpoint did not return an id_token or access_token for the password grant.' };
    }
    if (tokens.indexOf('access_token') !== -1) return { field: 'access_token' };
    return { error: 'The token endpoint did not return an access_token for the client_credentials grant.' };
}

function tokenExpired(profileName) {
    let cached = cachedTokenResponses[profileName];
    if (!cached || !cached.data) {
        return true;
    }
    let chosen = cached.chosenToken;
    if (!chosen) {
        return true;
    }
    // If it's a JWT, honor its exp; otherwise re-fetch to be safe.
    try {
        let parsed = jwtDecode(chosen);
        if (parsed && parsed.exp) {
            let checkTime = new Date().getTime() + (15 * 1000);
            return (parsed.exp * 1000) < checkTime;
        }
    } catch (e) {
        // not a JWT — fall through
    }
    // Non-JWT token: use expires_in if provided, else treat as expired.
    if (cached.data.expires_in && cached.fetchedAt) {
        let expiresAt = cached.fetchedAt + (cached.data.expires_in * 1000) - (15 * 1000);
        return new Date().getTime() >= expiresAt;
    }
    return true;
}

// Fetch an OAuth2 token from the profile's configured token endpoint.
// opts (optional): { errorOnExpiry } — when true, a missing/expired cached token
// yields an error instead of silently re-fetching (used at invoke time for
// profiles that did NOT opt into auto-renew).
function fetchOAuth2Token(profile, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    opts = opts || {};
    if (!profile.bearerTokenEndpoint) {
        return cb(new Error('bearerTokenEndpoint is not configured for this profile.'));
    }
    if (!tokenExpired(profile.profileName)) {
        let cached = cachedTokenResponses[profile.profileName];
        return cb(null, cached.statusCode, cached.headers, cached.data, cached.chosenToken);
    }
    // The cached token is missing or expired. Unless the caller allows a silent
    // re-fetch, surface a clear error so the user can regenerate it deliberately.
    if (opts.errorOnExpiry) {
        let expiredErr = new Error(
            'The bearer token for profile "' + profile.profileName + '" has expired or has not been fetched yet. ' +
            'Enable "Automatically renew the token on expiry" on the profile, or run Test Connection to regenerate it.'
        );
        expiredErr.statusCode = 401;
        return cb(expiredErr);
    }

    let payload = buildTokenRequestBody(profile);
    let reqUrl = url.parse(profile.bearerTokenEndpoint);
    let protocol = reqUrl.protocol ? reqUrl.protocol.toLowerCase() : 'https:';
    let port = reqUrl.port || (protocol === 'http:' ? 80 : 443);
    let httpOrHttps = protocol === 'http:' ? http : https;

    let headers = {
        'Content-Type': FORM_URL_ENCODED,
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
    };
    let options = {
        'method': 'POST',
        'protocol': protocol,
        'hostname': reqUrl.hostname,
        'port': port,
        'path': reqUrl.path,
        'headers': headers,
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };

    let req = httpOrHttps.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => {
            if (!responseBody) {
                let err2 = new Error('OAuth2 token endpoint response is empty.');
                err2.statusCode = res.statusCode;
                err2.headers = res.headers;
                return cb(err2);
            }
            if (res.statusCode == 200 || res.statusCode == 201) {
                let data;
                try {
                    data = JSON.parse(responseBody);
                } catch(parseErr) {
                    return cb(parseErr);
                }
                let chosenToken = extractChosenToken(profile, data);
                if (!chosenToken) {
                    let field = profile.bearerTokenResponseField || 'access_token';
                    return cb(new Error('Token endpoint response did not contain the selected token field "' + field + '".'));
                }
                cachedTokenResponses[profile.profileName] = {
                    data: data,
                    headers: res.headers,
                    statusCode: res.statusCode,
                    chosenToken: chosenToken,
                    fetchedAt: new Date().getTime()
                };
                return cb(null, res.statusCode, res.headers, data, chosenToken);
            }
            let err2 = new Error('Error fetching OAuth2 token: ' + res.statusCode + ' ' + responseBody);
            err2.statusCode = res.statusCode;
            err2.headers = res.headers;
            return cb(err2);
        });
        res.on("error", (error) => cb(error));
    });

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() { req.abort(); });
    });
    req.on('error', function(err) {
        let message = 'Error occurred while fetching OAuth2 token from ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] + options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.debug(message);
        return cb(new Error(message));
    });
    req.write(payload);
    req.end();
}

// Resolve a bearer token for a profile (static or OAuth2) and hand it back.
// opts (optional): { errorOnExpiry } — forwarded to fetchOAuth2Token. Callers
// that resolve a token for an actual invocation pass errorOnExpiry=true UNLESS
// the profile opted into auto-renew, so an expired token becomes a clear error
// rather than a surprise refetch.
function resolveBearerToken(profile, opts, cb) {
    if (typeof opts === 'function') {
        cb = opts;
        opts = {};
    }
    opts = opts || {};
    let mode = (profile.bearerTokenMode || 'static').toLowerCase();
    if (mode === 'static') {
        if (!profile.bearerStaticToken) {
            return cb(new Error('No static bearer token configured for this profile.'));
        }
        return cb(null, profile.bearerStaticToken);
    }
    // oauth2 — auto-renew profiles always allow a silent refetch on expiry.
    let errorOnExpiry = opts.errorOnExpiry && !isAutoRenewEnabled(profile);
    fetchOAuth2Token(profile, { errorOnExpiry: errorOnExpiry }, (err, statusCode, headers, data, chosenToken) => {
        if (err) {
            return cb(err);
        }
        return cb(null, chosenToken);
    });
}

function generateAuthResponseAndInvokeRestBearerToken(req, res) {
    try {
        extractAuthSigningInputFromRequest(req, (inputErr, options) => {
            if(inputErr) {
                return logAndReturn(options, inputErr.statusCode || 400, {}, {'message': inputErr.message}, res);
            }
            profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
                if(searchErr) {
                    return logAndReturn(options, searchErr.statusCode || 400, {}, {'message': searchErr.message}, res);
                }
                if(!options['authnMode']) {
                    return logAndReturn(options, 400, {}, {'message': 'authnMode not provided in the payload. Can not invoke the url'}, res);
                }
                options['authnMode'] = options['authnMode'].toLowerCase();
                if (options['authnMode'] !== 'rest_bearer_token') {
                    return logAndReturn(options, 400, {}, {'message': 'invalid authnMode provided: ' + options['authnMode']}, res);
                }
                // At invoke time, an expired token is an error UNLESS the profile
                // opted into auto-renew (resolveBearerToken then refetches silently).
                resolveBearerToken(profile, { errorOnExpiry: true }, (tokenErr, token) => {
                    if (tokenErr) {
                        return logAndReturn(options, tokenErr.statusCode || 400, tokenErr.headers || {}, {'message': tokenErr.message}, res);
                    }
                    options['headers'] = options['headers'] || {};
                    options['headers']['Authorization'] = 'Bearer ' + token;
                    invokeRestApi(options, (invokeErr, responseStatusCode, responseHeaders, data) => {
                        if (invokeErr) {
                            responseStatusCode = invokeErr.statusCode || 400;
                            responseHeaders = invokeErr.headers || {};
                            data = {'message': invokeErr.message};
                        }
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    });
                });
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in generateAuthResponseAndInvokeRestBearerToken: ', catchErr);
        logAndReturn({}, catchErr.statusCode || 400, {}, {'message': catchErr.message}, res);
    }
}

// Test the bearer-token config for a profile WITHOUT invoking the target API.
// Used by the UI before saving. Returns success or the root-cause error.
function testBearerTokenConnection(req, res) {
    try {
        let options = (req.body && req.body.options) || {};
        if (!options['userName']) {
            options['userName'] = authConfig.getDefaultUserName();
        }
        if (!options['profileName']) {
            return res.status(400).json({'message': 'profileName not provided in request payload'});
        }
        // Allow testing against an unsaved profile passed inline (pre-save check).
        let inlineProfile = options['profile'];
        let handleProfile = (profile) => {
            let mode = (profile.bearerTokenMode || 'static').toLowerCase();
            if (mode === 'static') {
                if (!profile.bearerStaticToken) {
                    return res.status(200).json({ statusCode: 400, response: { success: false, message: 'No static bearer token configured.' } });
                }
                return res.status(200).json({ statusCode: 200, response: { success: true, message: 'Static bearer token is present.' } });
            }
            // Force a fresh fetch for the test.
            delete cachedTokenResponses[profile.profileName];
            fetchOAuth2Token(profile, (tokenErr, statusCode, headers, data, chosenToken) => {
                if (tokenErr) {
                    return res.status(200).json({
                        statusCode: tokenErr.statusCode || 400,
                        response: { success: false, message: 'Connection failed: ' + tokenErr.message }
                    });
                }
                let availableTokens = Object.keys(data).filter((k) => k === 'access_token' || k === 'id_token');
                let grantType = inferGrantType(profile);
                let recommendation = recommendTokenField(grantType, availableTokens);
                // We do not know which tokens the endpoint returns until now, so the
                // UI reveals "Token to use" only after this test. Enforce the grant
                // rules: client_credentials needs access_token; password prefers
                // id_token (else access_token). If the required token is absent, the
                // test is an error even though the HTTP call itself succeeded.
                if (recommendation.error) {
                    return res.status(200).json({
                        statusCode: 400,
                        response: {
                            success: false,
                            message: recommendation.error,
                            availableTokens: availableTokens,
                            tokenResponsePreview: Object.keys(data)
                        }
                    });
                }
                return res.status(200).json({
                    statusCode: 200,
                    response: {
                        success: true,
                        message: 'Connection successful. Using "' + recommendation.field + '" as the bearer token.',
                        grantType: grantType || 'client_credentials',
                        recommendedTokenField: recommendation.field,
                        availableTokens: availableTokens,
                        tokenResponsePreview: Object.keys(data)
                    }
                });
            });
        };
        if (inlineProfile && inlineProfile.profileName) {
            return handleProfile(inlineProfile);
        }
        profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
            if(searchErr) {
                return res.status(200).json({ statusCode: searchErr.statusCode || 400, response: { success: false, message: searchErr.message } });
            }
            handleProfile(profile);
        });
    } catch (catchErr) {
        log.error('caught unexpected error in testBearerTokenConnection: ', catchErr);
        return res.status(500).json({'message': catchErr.message});
    }
}

// Resolve and return the bearer token so the UI can copy it to clipboard.
function copyBearerToken(req, res) {
    try {
        let options = (req.body && req.body.options) || {};
        if (!options['userName']) {
            options['userName'] = authConfig.getDefaultUserName();
        }
        if (!options['profileName']) {
            return res.status(400).json({'message': 'profileName not provided in request payload'});
        }
        profileUtils.searchProfile(options['userName'], options['profileName'], (searchErr, profile) => {
            if(searchErr) {
                return res.status(200).json({ statusCode: searchErr.statusCode || 400, response: { message: searchErr.message } });
            }
            resolveBearerToken(profile, (tokenErr, token) => {
                if (tokenErr) {
                    return res.status(200).json({ statusCode: tokenErr.statusCode || 400, response: { message: 'Failed to obtain bearer token: ' + tokenErr.message } });
                }
                return res.status(200).json({ statusCode: 200, response: { token: token } });
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in copyBearerToken: ', catchErr);
        return res.status(500).json({'message': catchErr.message});
    }
}

module.exports = {
    generateAuthResponseAndInvokeRestBasicAuth: generateAuthResponseAndInvokeRestBasicAuth,
    generateAuthResponseAndInvokeRestBearerToken: generateAuthResponseAndInvokeRestBearerToken,
    testBearerTokenConnection: testBearerTokenConnection,
    copyBearerToken: copyBearerToken,
    generateAuthResponseAndInvokeGeneric: generateAuthResponseAndInvokeGeneric,
    // exposed for chat/programmatic use
    resolveBearerToken: resolveBearerToken
};

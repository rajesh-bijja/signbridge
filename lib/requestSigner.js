
/**
 * requestSigner.js
 *
 * Part of SignBridge. Licensed under the MIT License.
 * Created on 07/20/23.
 */
"use strict";

let https = require('https');
let profileUtils = require('./profileUtils');
let commonUtils = require('./commonUtils');
let ssoPost = require('./ssoPost');
let ssoS3Post = require('./ssoS3Post');
let ssoGet = require('./ssoGet');
let ssoS3Get = require('./ssoS3Get');
let iamPost = require('./iamPost');
let iamS3Post = require('./iamS3Post');
let iamGet = require('./iamGet');
let iamS3Get = require('./iamS3Get');
let ssoPresigned = require('./ssoPresigned');
let ssoS3Presigned = require('./ssoS3Presigned');
let iamPresigned = require('./iamPresigned');
let iamS3Presigned = require('./iamS3Presigned');
let ssoUtils = require('./ssoUtils');
let credentialProvider = require('./credentialProvider');
let authConfig = require('./authConfig');
let expiryUtils = require('./expiryUtils');
let redact = require('./redact');
let url = require('url');
let log = require('./logger').create('requestSigner');
let TIMEOUT = 600000;

const FORM_URL_ENCODED_UTF8 = 'application/x-www-form-urlencoded;charset=UTF-8';
const FORM_URL_ENCODED_UTF8_2 = 'application/x-www-form-urlencoded; charset=UTF-8';
const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';
const FORM_URL_ENCODED = 'application/x-www-form-urlencoded';

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

function extractAuthSigningInputFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('extractAuthSigningInputFromRequest: request body not available'));
    } else {
        if(!req.body.options) {
            return cb(new Error('authInput object not provided in request payload'));
        }
        log.debug('payload provided : ', redact.forLog(req.body.options));
        let options = req.body.options;
        if(!options['userName']) {
            options['userName'] = authConfig.getDefaultUserName();
        }

        if(options['endpoint']) {
            let result = commonUtils.resolveEndpoint(options['userName'], options['endpoint']);
            if (result.startsWith('ERROR:: ')) {
                return cb(new Error(result), options);
            } else {
                options['endpoint'] = result;
            }
            log.debug('endpoint provided. Ignoring other protocol/host/port/path if specified in the payload');
            let reqUrl = url.parse(options['endpoint']);
            let protocol = reqUrl.protocol.toLowerCase();
            let hostname = reqUrl.hostname;
            let path = reqUrl.path;
            let pathname = reqUrl.pathname || '/';
            let query = reqUrl.query || '';
            let port = reqUrl.port;
            if (!port) {
                if (protocol === 'https:') {
                    port = 443;
                } else if (protocol === 'http:') {
                    port = 80;
                } else {
                    let msg = 'Invalid protocol: [' + protocol + '] specified in request payload'
                    return cb(new Error(msg));
                }
            }
            options.protocol = protocol;
            options.host = hostname;
            options.port = port;
            options.path = path;
            options.pathname = pathname;
            options.query = query;
            options.timeout = TIMEOUT;
        } else {
            return cb(new Error('endpoint not provided in options payload'));
        }
        if(!options['region']) {
            // parse region name from the host.
            options.region = options.host.split('.')[1];
        }
        if(!options['method']) {
            return cb(new Error('http method not provided in request payload'));
        }
        let method = options['method'].toLowerCase();
        if(options['headers']) {
            log.debug('headers provided. Retaining for signing ...');
            let original = options['headers'];
            let tempHeaders = {};
            for (let eachKey in original) {
                tempHeaders[eachKey.toLowerCase()] = original[eachKey];
            }
            options['headers'] = tempHeaders;
        }
        if (method === 'post' || method === 'put' || method === 'patch') {
            if (!options['headers'] || !options['headers']['content-type']) {
                log.debug('Content-Type not specified in the request payload');
                //return cb(new Error('Content-Type not specified in the request payload'));
            }
        }
        if(options['body']) {
            log.debug('initial payload length is: ' + req.body.options.body.length);
            if (options['headers'] && options['headers']['content-type'] &&
                (options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8.toLowerCase() ||
                    options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8_2.toLowerCase() ||
                    options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8_3.toLowerCase() ||
                    options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED.toLowerCase())) {
                options['body'] = req.body.options.body;
            } else if (options['headers']['content-type'].toLowerCase() === 'application/json' ||
                options['headers']['content-type'].toLowerCase().includes('json')) {
                if (req.body.options.body instanceof Object) {
                    options['body'] = JSON.stringify(req.body.options.body);
                }
                //options['body'] = JSON.stringify(req.body.options.body);
            } else {
                /*
                if (req.body.options.body instanceof Object) {
                    options['body'] = JSON.stringify(req.body.options.body);
                }
                */
                //options['body'] = req.body.options.body;
            }
            log.debug('body provided. Retaining for signing ', options['body']);
        }
        if(!options['profileName']) {
            return cb(new Error('profileName not provided in request payload'));
        }
        // Customizable presigned-URL lifetime. Callers (UI, chat, MCP) pass
        // expiresInSeconds; translate it into the X-Amz-Expires header the
        // presigners sign. AWS SigV4 allows 1s..12h; clamp to a sane 60s..43200s.
        // For SSO profiles the presigner further caps this to the session
        // credential's real remaining life.
        let clampedExpiry = expiryUtils.clampExpiresInSeconds(options['expiresInSeconds']);
        if (clampedExpiry != null) {
            options['headers'] = options['headers'] || {};
            options['headers']['x-amz-expires'] = clampedExpiry;
        }
        return cb(null, options);
    }
}

function logAndReturn(options, responseStatusCode, responseHeaders, data, res) {
    options = authConfig.ensureOptionsUserName(options);
    profileUtils.createHistory(options['userName'], options, responseStatusCode, responseHeaders, data, (createHistoryErr) => {
        if (createHistoryErr) {
            log.error('error in creating the history in [', options['authnMode'],  ']. error is : ', createHistoryErr);
            return res.status(400).json({'message': createHistoryErr.message});
        } else {


            return res.status(200).json(
                {
                    statusCode: responseStatusCode,
                    headers: responseHeaders,
                    response: data
                });


            //res.setHeader('Access-Control-Allow-Origin', '*');
            //res.redirect(responseHeaders['verificationUriComplete']);
        }
    });
}

function generateAuthResponse(req, res) {
    try {
        extractAuthSigningInputFromRequest(req, (err, options) => {
            if(err) {
                let responseStatusCode = err.statusCode || 400;
                let responseHeaders = {};
                let data = {'message': err.message};
                return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
            }
            options['isUrlPresigningRequest'] = true;
            profileUtils.searchProfile(options['userName'], options['profileName'], (err, profile) => {
                if (err) {
                    let responseStatusCode = err.statusCode || 400;
                    let responseHeaders = {};
                    let data = {'message': err.message};
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                }
                // No authnMode? credentialProvider.resolveAuthnMode picks the
                // profile's first AWS mechanism (sso_user/iam_user still win for any
                // profile that predates EC2/IRSA) and reports a precise error when
                // the profile offers none.
                let host = options['host'];
                let hostParts = host.split('.');
                let serviceName = '';
                let region = 'us-east-1';
                if (hostParts.length == 4) {
                    if (hostParts[1].toLowerCase() === 's3') {
                        serviceName = hostParts[1].toLowerCase();
                    } else {
                        serviceName = hostParts[0].toLowerCase();
                        region = hostParts[1].toLowerCase();
                    }
                } else if (hostParts.length == 3) {
                    serviceName = hostParts[0].toLowerCase();
                } else if (hostParts.length == 5 && hostParts[1].toLowerCase() === 's3') {
                    serviceName = hostParts[1].toLowerCase();
                    region = hostParts[2].toLowerCase();
                } else {
                    let message = 'hostname provided: [' + host + ']' + '. ' +
                        'Supported hostname format are: [[service-code].[region-code].amazonaws.com] or ' +
                        '[[bucket].s3.[region-code].amazonaws.com] or [[service-code].amazonaws.com] for S3';
                    let responseStatusCode = 400;
                    let responseHeaders = {};
                    let data = {'message': message};
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                }
                if (options['authnMode']) {
                    options['authnMode'] = options['authnMode'].toLowerCase();
                }
                // Presigned URLs are query-string (SigV4) auth, which AWS supports
                // for any HTTP method — not just GET. For body-bearing methods
                // (POST/PUT/PATCH/DELETE) the presigners sign UNSIGNED-PAYLOAD, so
                // the signature stays valid regardless of the body the caller
                // ultimately sends with the URL (e.g. `curl -d ...`, or an S3
                // presigned PUT upload).
                credentialProvider.resolveAwsCredentials(profile, options['authnMode'], (credErr, resolved) => {
                    if (credErr) {
                        let responseStatusCode = credErr.statusCode || 401;
                        let responseHeaders = {};
                        // An SSO device-authorization link (possibly from an IRSA
                        // profile's base profile) must survive to the client so the
                        // Authorize button can be offered.
                        responseHeaders['verificationUriComplete'] = credErr.verificationUriComplete;
                        let data = {'message': credErr.message};
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    }
                    options['authnMode'] = resolved.authnMode;
                    let finish = (awsApiErr, responseStatusCode, responseHeaders, data) => {
                        if (awsApiErr) {
                            responseStatusCode = awsApiErr.statusCode || 400;
                            responseHeaders = {}
                            data = {'message': awsApiErr.message};
                        }
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    };
                    // Route on the credential's *shape*, not on the mode that
                    // produced it. SSO, EC2 instance profiles and IRSA all yield an
                    // STS triple with a session token, which the sso* presigners
                    // already sign (X-Amz-Security-Token) and already cap to the
                    // token's remaining life. Only long-lived IAM user keys lack a
                    // token and need the iam* presigners. That is why EC2 and IRSA
                    // needed no new signer.
                    if (credentialProvider.hasSessionToken(resolved.credentials)) {
                        if (serviceName === 's3') {
                            ssoS3Presigned.callS3SsoPresigned(options, resolved.credentials, finish);
                        } else {
                            ssoPresigned.callSsoPresigned(options, resolved.credentials, finish);
                        }
                    } else {
                        if (serviceName === 's3') {
                            iamS3Presigned.callIamS3Presigned(options, resolved.credentials, finish);
                        } else {
                            iamPresigned.callIamPresigned(options, resolved.credentials, finish);
                        }
                    }
                });
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in generateAuthResponse: ', catchErr);
        let responseStatusCode = catchErr.statusCode || 400;
        let responseHeaders = {};
        let data = {'message': catchErr.message};
        let options = {}
        logAndReturn(options, responseStatusCode, responseHeaders, data, res);
    }
}

function generateAuthResponseAndInvoke(req, res) {
    try {
        extractAuthSigningInputFromRequest(req, (err, options) => {
            if(err) {
                let responseStatusCode = err.statusCode || 400;
                let responseHeaders = {};
                let data = {'message': err.message};
                return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
            }
            profileUtils.searchProfile(options['userName'], options['profileName'], (err, profile) => {
                if (err) {
                    let responseStatusCode = err.statusCode || 400;
                    let responseHeaders = {};
                    let data = {'message': err.message};
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                }
                // See the note in generateAuthResponse: credentialProvider does the
                // defaulting and the validation.
                if (options['authnMode']) {
                    options['authnMode'] = options['authnMode'].toLowerCase();
                }
                let host = options['host'];
                let hostParts = host.split('.');
                let serviceName = '';
                let region = 'us-east-1';
                if (hostParts.length == 4) {
                    serviceName = hostParts[0].toLowerCase();
                    region = hostParts[1].toLowerCase();
                } else if (hostParts.length == 3) {
                    serviceName = hostParts[0].toLowerCase();
                } else if (hostParts.length == 5 && hostParts[1].toLowerCase() === 's3') {
                    serviceName = hostParts[1].toLowerCase();
                    region = hostParts[2].toLowerCase();
                } else {
                    let message = 'hostname provided: [' + host + ']' + '. ' +
                        'Supported hostname format are: [[service-code].[region-code].amazonaws.com] or ' +
                        '[[bucket].s3.[region-code].amazonaws.com] or [[service-code].amazonaws.com] for S3';
                    let responseStatusCode = 400;
                    let responseHeaders = {};
                    let data = {'message': message};
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                }
                credentialProvider.resolveAwsCredentials(profile, options['authnMode'], (credErr, resolved) => {
                    if (credErr) {
                        let responseStatusCode = credErr.statusCode || 401;
                        let responseHeaders = {};
                        responseHeaders['verificationUriComplete'] = credErr.verificationUriComplete;
                        let data = {'message': credErr.message};
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    }
                    options['authnMode'] = resolved.authnMode;
                    let credentials = resolved.credentials;
                    let finish = (awsApiErr, responseStatusCode, responseHeaders, data) => {
                        if (awsApiErr) {
                            responseStatusCode = awsApiErr.statusCode || 400;
                            responseHeaders = {}
                            data = {'message': awsApiErr.message};
                        }
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    };
                    let method = options['method'].toLowerCase();
                    let isBodyMethod = (method === 'post' || method === 'put' || method === 'patch' || method === 'delete');
                    if (!isBodyMethod && method !== 'get') {
                        let responseStatusCode = 400;
                        let responseHeaders = {};
                        let data = {'message': 'Unsupported method: ' + options['method']};
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res);
                    }
                    // Two independent questions — is this S3, and does the credential
                    // carry a session token — pick one of four signers. Routing on
                    // the token rather than on the mode name is what let EC2 and IRSA
                    // reuse the sso* signers unchanged: all three mint an STS triple.
                    let isS3 = (serviceName === 's3');
                    let temporary = credentialProvider.hasSessionToken(credentials);
                    if (temporary && isS3) {
                        if (isBodyMethod) {
                            ssoS3Post.callSsoS3Post(options, credentials, finish);
                        } else {
                            ssoS3Get.callSsoS3Get(options, credentials, finish);
                        }
                    } else if (temporary) {
                        if (isBodyMethod) {
                            ssoPost.callSsoPost(options, credentials, finish);
                        } else {
                            ssoGet.callSsoGet(options, credentials, finish);
                        }
                    } else if (isS3) {
                        if (isBodyMethod) {
                            iamS3Post.callIamS3Post(options, credentials, finish);
                        } else {
                            iamS3Get.callIamS3Get(options, credentials, finish);
                        }
                    } else {
                        if (isBodyMethod) {
                            iamPost.callIamPost(options, credentials, finish);
                        } else {
                            iamGet.callIamGet(options, credentials, finish);
                        }
                    }
                });
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in generateAuthResponseAndInvoke: ', catchErr);
        let responseStatusCode = catchErr.statusCode || 400;
        let responseHeaders = {};
        let data = {'message': catchErr.message};
        let options = {}
        logAndReturn(options, responseStatusCode, responseHeaders, data, res);
    }
}


module.exports = {
    generateAuthResponse: generateAuthResponse,
    generateAuthResponseAndInvoke: generateAuthResponseAndInvoke,
};


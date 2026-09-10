const { https } = require('follow-redirects')
let profileUtils = require('./profileUtils')
let expiryUtils = require('./expiryUtils')
let redact = require('./redact')
let log = require('./logger').create('ssoUtils');
let TIMEOUT = 600000;

try {
    if (process.env.TIMEOUT) {
        TIMEOUT = parseInt(process.env.TIMEOUT);
        log.debug('TIMEOUT specified as ', TIMEOUT);
    } else {
        log.debug('TIMEOUT not specified defaulting to ', TIMEOUT);
    }
} catch(parseIntErr) {
    log.error('error in parsing and configuring the timeout: ', parseIntErr.message);
    TIMEOUT = 600000;
    log.debug('defaulting TIMEOUT to ', TIMEOUT);
}

/**
 * The message shown when an SSO device authorization has not been approved yet.
 *
 * Plain text on purpose. Every consumer — the React UI, the chat agent, MCP
 * clients — renders this as text, so the HTML this used to carry (a leftover from
 * the removed Oracle JET UI, which injected it as markup) appeared as literal
 * `<html><body>` tags in the error panel. The clickable link comes from
 * `verificationUriComplete` on the error object, which every UI consumer reads
 * separately; the URL is repeated in the text so text-only clients still get it.
 *
 * Pure and exported so it can be tested without an SSO round trip.
 */
function formatAuthorizationPendingMessage(description, verificationUriComplete) {
    let lead = String(description || 'Authorization is still pending').trim().replace(/\.$/, '');
    return lead + '. Approve this SSO session at ' + verificationUriComplete +
        ', then come back and retry your operation.';
}

function registerClient(profileReadObj, credsObj, cb) {
    _registerClient(profileReadObj, (registerClientErr, registerClientResp) => {
        if (registerClientErr) {
            return cb(registerClientErr)
        }
        // RegisterClient returns a client secret. Redacted, because the whole point of
        // logging this is confirming the call shape, not the credential in it.
        log.debug('registerClient response is: ', redact.forLog(registerClientResp));
        credsObj.publicClientCredentials = registerClientResp;
        profileUtils.updatePublicClientCreds(profileReadObj.ssoRegion, credsObj, (updateErr, credsUpdateObj) => {
            if (updateErr){
                return cb(new Error('Error in updating the creds file with the registered client details: ' + updateErr.message));
            }
            return cb(null, credsUpdateObj);
        });
    });
}

function _registerClient(profileReadObj, cb) {
    let options = {
        'method': 'POST',
        'protocol': 'https:',
        'hostname': profileReadObj.oidcHostname,
        'port': 443,
        'path': profileReadObj.oidcRegisterClientPath,
        'headers': {
            'Content-Type': 'application/json'
        },
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };

    let req = https.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => {
            responseBody += chunk;
        });

        res.on("end", () => {
            if (responseBody) {
                try {
                    let responseJson = JSON.parse(responseBody);
                    return cb(null, responseJson);
                } catch (err) {
                    log.error('error occurred in extracting the details from the generate client response: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('generate client response is empty.'))
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('error response received in generate client call: ', JSON.parse(error));
            } else {
                log.error('error response received in generate client call : ', error);
            }
            return cb(error);
        });
    });

    let postData = JSON.stringify({
        "clientName": "signbridge",
        "clientType": "PUBLIC"
    });

    req.write(postData);

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to execute the generate client request : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to execute the generate client request : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

function _generateDeviceAndUserCode(profileReadObj, credsObj, cb) {
    let options = {
        'method': 'POST',
        'protocol': 'https:',
        'hostname': profileReadObj.oidcHostname,
        'port': 443,
        'path': profileReadObj.oidcDeviceAuthorizationPath,
        'headers': {
            'Content-Type': 'application/json'
        },
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };

    let req = https.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => {
            responseBody += chunk;
        });

        res.on("end", () => {
            if (responseBody) {
                try {
                    let responseJson = JSON.parse(responseBody)
                    return cb(null, responseJson);
                } catch (err) {
                    log.error('error occurred in extracting the device code and user code details from the response: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('device code and user code response is empty.'))
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('error response received in device and user code call: ', JSON.parse(error));
            } else {
                log.error('error response received in device and user code call : ', error);
            }
            return cb(error);
        });
    });

    let postData = JSON.stringify({
        "clientId": credsObj.publicClientCredentials.clientId,
        "clientSecret": credsObj.publicClientCredentials.clientSecret,
        "startUrl": profileReadObj.awsSsoStartUrl
    });

    req.write(postData);

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to execute the generate user/device code request : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to execute the generate user/device code request : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

function _generateDeviceAndUserCodeAndUpdateProfile(profileReadObj, credsObj, cb) {
    _generateDeviceAndUserCode(profileReadObj, credsObj, (accessTokenErr, deviceCodeResp) => {
        if (accessTokenErr) {
            return cb(accessTokenErr)
        }
        // Carries the device code, which is exchanged for an access token — i.e. a
        // bearer credential, not just an identifier.
        log.debug('_generateDeviceAndUserCode response is :', redact.forLog(deviceCodeResp));
        credsObj.deviceAndUserCodeDetails = deviceCodeResp
        credsObj.deviceAndUserCodeDetails.expiresInMilliseconds =
            new Date().getTime() + (credsObj.deviceAndUserCodeDetails.expiresIn * 1000)
        profileUtils.updatePublicClientCreds(profileReadObj.ssoRegion, credsObj, (updateErr, credsUpdateObj) => {
            if (updateErr) {
                return cb(new Error('Error in updating the creds file with device and user code details: ' + updateErr.message));
            }
            return cb(null, credsUpdateObj);
        });
    });
}

function generateDeviceAndUserCode(profileReadObj, credsObj, cb) {
    let checkTime = new Date().getTime()  + (15 * 1000);
    // ensure the token is atleast 15 seconds greater than the current time
    if (credsObj.publicClientCredentials && credsObj.publicClientCredentials.clientId &&
        credsObj.publicClientCredentials.clientSecret &&
        credsObj.publicClientCredentials.clientSecretExpiresAt >= checkTime) {
        _generateDeviceAndUserCodeAndUpdateProfile(profileReadObj, credsObj, cb);
    } else {
        registerClient(profileReadObj, credsObj, (registerClientErr, credsObjResp) => {
            if (registerClientErr) {
                return cb(registerClientErr)
            }
            _generateDeviceAndUserCodeAndUpdateProfile(profileReadObj, credsObjResp, cb);
        });
    }
}

function _invokeSts(profileReadObj, credsObj, cb) {
    let roleCredentialsHostname = profileReadObj.roleCredentialsHostname
    let roleCredentialsPath = profileReadObj.roleCredentialsPath
    let accessToken = credsObj.accessTokenDetails.accessToken
    let options = {
        'method': 'GET',
        'protocol': 'https:',
        'hostname': roleCredentialsHostname,
        'port': 443,
        'path': roleCredentialsPath,
        'headers': {
            'x-amz-sso_bearer_token': accessToken
        },
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };

    let req = https.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => {
            responseBody += chunk;
        });

        res.on("end", () => {
            if (responseBody) {
                try {
                    // The success body IS the credential: secretAccessKey + sessionToken. Both
                    // lines are redacted — the raw one first, since redacting only the
                    // parsed copy would print the plaintext on the line above.
                    log.debug('invoke sts response status: ', res.statusCode, ' and responseBody: ', redact.forLog(responseBody));
                    let responseJson = JSON.parse(responseBody)
                    log.debug('parsed invoke sts response status: ', res.statusCode, ' and responseBody: ', redact.forLog(responseJson));
                    return cb(null, responseJson);
                } catch (err) {
                    log.error('error occurred in extracting the temporary security credentials from the response: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('temporary security credentials response is empty: [' + res.statusCode + ']'));
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('[' + res.statusCode + '] error response received in create temporary security credentials call: ', JSON.parse(error));
            } else {
                log.error('[' + res.statusCode + '] error response received in create temporary security credentials call : ', error);
            }
            return cb(error);
        });
    });

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to execute the create temporary security credentials request : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to execute the create temporary security credentials request : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

function _invokeStsAndUpdateProfile(profileReadObj, credsObj, cb) {
    _invokeSts(profileReadObj, credsObj, (invokeStsErr, invokeStsResp) => {
        if (invokeStsErr) {
            log.error('error in invoke sts: ', invokeStsErr);
            return cb(invokeStsErr);
        }
        log.debug('before updating the credentials: ', profileUtils.redactProfileForLog(profileReadObj));
        profileReadObj.roleCredentials = invokeStsResp.roleCredentials;
        profileReadObj.roleCredentials.accessTokenDetails = credsObj.accessTokenDetails;
        // Now carries roleCredentials, so the profile redactor is doing real work here
        // rather than being defensive.
        log.debug('before final update: ', profileUtils.redactProfileForLog(profileReadObj));
        profileUtils.updateProfile(profileReadObj, (updateErr, profileUpdateObj) => {
            if (updateErr) {
                return cb(new Error('Error in updating the profile with role credentials details: ' + updateErr.message));
            }
            return cb(null, profileUpdateObj);
        });
    });
}

function createTemporarySecurityCredentials(profileReadObj, cb) {
    let checkTime = new Date().getTime()  + (15 * 1000);
    // ensure the token is atleast 15 seconds greater than the current time
    profileUtils.getPublicClientCreds(profileReadObj.ssoRegion, (err, credsObj) => {
        if (err) {
            return cb(err);
        } else {
            if (credsObj.accessTokenDetails && credsObj.accessTokenDetails.accessToken &&
                credsObj.accessTokenDetails.expiresInMilliseconds &&
                credsObj.accessTokenDetails.expiresInMilliseconds >= checkTime) {
                log.debug('access token details are available so proceeding to invoke sts api.');
                _invokeStsAndUpdateProfile(profileReadObj, credsObj, cb);
            } else {
                generateAccessTokenUsingDeviceCode(profileReadObj, credsObj, (accessTokenErr, credsObjResp) => {
                    if (accessTokenErr) {
                        log.error('access token generation failed: ', accessTokenErr);
                        return cb(accessTokenErr);
                    } else {
                        //profileReadObj = profileObjResp;
                        log.debug('credsObjResp before invoking sts is: ', redact.forLog(credsObjResp));
                        _invokeStsAndUpdateProfile(profileReadObj, credsObjResp, cb);
                    }
                });
            }
        }
    });
}

function _generateAccessTokenUsingDeviceCode(profileReadObj, credsObj, cb) {
    let options = {
        'method': 'POST',
        'protocol': 'https:',
        'hostname': profileReadObj.oidcHostname,
        'port': 443,
        'path': profileReadObj.oidcAccessTokenPath,
        'headers': {
            'Content-Type': 'application/json'
        },
        'maxRedirects': 20,
        'timeout': TIMEOUT
    };

    let req = https.request(options, (res) => {
        let responseBody = '';
        res.on("data", (chunk) => {
            responseBody += chunk;
        });

        res.on("end", () => {
            if (responseBody) {
                try {
                    // CreateToken returns the SSO access token and refresh token. The refresh
                    // token is the longest-lived credential in this whole flow, so this is
                    // the most damaging of the lines that used to print in full.
                    log.debug('access token response body is: ', redact.forLog(responseBody), ' status: ', res.statusCode);
                    let responseJson = JSON.parse(responseBody)
                    log.debug('parsed access token response body is: ', redact.forLog(responseJson), ' status: ', res.statusCode);
                    if (res.statusCode == 200 || res.statusCode == 201) {
                        log.debug('success response from access token generation');
                        //profileReadObj.deviceAndUserCodeDetails.verificationStatus = 'authorization_complete';
                        return cb(null, responseJson);
                    } else if (res.statusCode == 400 && responseJson.error.toLowerCase() === 'authorization_pending') {
                        //let errMsg = responseJson.error_description + ' . Invoke this url to approve device code. ' +
                        //credsObj.deviceAndUserCodeDetails.verificationUriComplete + ' ';
                        let errMsg = formatAuthorizationPendingMessage(
                            responseJson.error_description,
                            credsObj.deviceAndUserCodeDetails.verificationUriComplete)
                        let userCodeErr = new Error(errMsg)
                        userCodeErr.statusCode = 401;
                        userCodeErr.verificationUriComplete = credsObj.deviceAndUserCodeDetails.verificationUriComplete;
                        log.error('401 error in access token generation')
                        return cb(userCodeErr);
                    } else {
                        let errMsg = 'generic error in access token generation: ' + res.statusCode + responseBody
                        log.error(errMsg);
                        return cb(new Error(errMsg));
                    }
                } catch (err) {
                    log.error('error occurred in extracting the access token details from the response: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('device code and user code response is empty.'))
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('error response received in device and user code call: ', JSON.parse(error));
            } else {
                log.error('error response received in device and user code call : ', error);
            }
            return cb(error);
        });
    });

    let postData = JSON.stringify({
        "grantType": 'urn:ietf:params:oauth:grant-type:device_code',
        "clientId": credsObj.publicClientCredentials.clientId,
        "clientSecret": credsObj.publicClientCredentials.clientSecret,
        "deviceCode": credsObj.deviceAndUserCodeDetails.deviceCode
    });

    req.write(postData);

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to generate access token using user/device code : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to execute the generate access token using user/device code : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

function _generateAccessTokenUsingDeviceCodeAndUpdateProfile(profileReadObj, credsObj, cb) {
    _generateAccessTokenUsingDeviceCode(profileReadObj, credsObj, (accessTokenErr, accessTokenResp) => {
        if (accessTokenErr) {
            return cb(accessTokenErr);
        }
        credsObj.accessTokenDetails = accessTokenResp;
        credsObj.accessTokenDetails.expiresInMilliseconds =
            new Date().getTime() + (credsObj.accessTokenDetails.expiresIn * 1000);
        profileUtils.updatePublicClientCreds(profileReadObj.ssoRegion, credsObj, (updateErr, credsUpdateObj) => {
            if (updateErr) {
                return cb(new Error('Error in updating the creds file with access token details: ' + updateErr.message));
            }
            return cb(null, credsUpdateObj);
        });
    });
}

function generateAccessTokenUsingDeviceCode(profileReadObj, credsObj, cb) {
    let checkTime = new Date().getTime()  + (15 * 1000);
    // ensure the token is atleast 15 seconds greater than the current time
    if (credsObj.deviceAndUserCodeDetails && credsObj.deviceAndUserCodeDetails.deviceCode &&
        credsObj.deviceAndUserCodeDetails.expiresInMilliseconds &&
        credsObj.deviceAndUserCodeDetails.expiresInMilliseconds >= checkTime) {
        _generateAccessTokenUsingDeviceCodeAndUpdateProfile(profileReadObj, credsObj, cb);
    } else {
        generateDeviceAndUserCode(profileReadObj, credsObj, (deviceCodeErr, credsObjResp) => {
            if (deviceCodeErr) {
                return cb(deviceCodeErr);
            }
            _generateAccessTokenUsingDeviceCodeAndUpdateProfile(profileReadObj, credsObjResp, cb);
        });
    }

}

function getRoleCredentialsForUser(req, res) {
    if(!req.body) {
        return res.status(400).json({'message': 'request payload not available.'});
    }
    if(!req.body.options) {
        return res.status(400).json({'message': 'options not provided in request payload'});
    }
    log.debug('payload provided for getRoleCredentialsForUser: ', redact.forLog(req.body));
    let options = req.body.options;
    if(!options['userName']) {
        return res.status(400).json({'message': 'userName not specified in the request payload options'});
    }
    if(!options['profileName']) {
        return res.status(400).json({'message': 'profileName not specified in the request payload options'});
    }
    let profileName = options['profileName']
    profileUtils.searchProfile(options['userName'], profileName, (profileReadErr, profileReadObj) => {
        if (profileReadErr) {
            return res.status(400).json({'message': profileReadErr.message});
        }
        log.debug('profile obtained from search: ', profileUtils.redactProfileForLog(profileReadObj));
        getSecurityToken(profileReadObj, (credErr, roleCredentials) => {
            if (credErr) {
                return res.status(credErr.statusCode || 401).json({'message': credErr.message});
            }
            return res.status(200).json(roleCredentials);
        });
    });
}

// Refresh SSO role credentials when they have less than this much life left.
// A tiny buffer (e.g. 15s) let nearly-dead credentials be reused, producing
// presigned URLs that fail almost immediately with "AuthFailure". Five minutes
// ensures a freshly-generated URL is signed with credentials that still have
// usable lifetime. Overridable via SSO_CREDENTIAL_REFRESH_BUFFER_MS.
let CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000;
try {
    if (process.env.SSO_CREDENTIAL_REFRESH_BUFFER_MS) {
        CREDENTIAL_REFRESH_BUFFER_MS = parseInt(process.env.SSO_CREDENTIAL_REFRESH_BUFFER_MS);
    }
} catch (bufferParseErr) {
    CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000;
}

function getSecurityToken(profileReadObj, cb) {
    // Treat credentials that expire within the refresh buffer as already stale so
    // they get re-minted before we sign, instead of signing a URL that will fail.
    if (expiryUtils.isSsoCredentialFresh(profileReadObj.roleCredentials, new Date().getTime(), CREDENTIAL_REFRESH_BUFFER_MS)) {
        log.debug('role credentials NOT expired.. returning it')
        return cb(null, profileReadObj.roleCredentials);
    }
    log.debug('role credentials are not available or expired, proceeding to create....')
    createTemporarySecurityCredentials(profileReadObj, (credErr, profileUpdateObj) => {
        if (credErr) {
            // When re-minting fails, the SSO session almost always needs to be
            // re-authorized. If the flow already produced a device-authorization
            // link (authorization_pending, statusCode 401), pass it through
            // untouched — the caller renders that clickable link. Otherwise wrap
            // the raw error in a clear, actionable message so the UI/chat doesn't
            // just show a cryptic failure.
            if (credErr.verificationUriComplete) {
                return cb(credErr);
            }
            let profileName = profileReadObj.profileName || profileReadObj.name || 'this profile';
            let ssoErr = new Error(
                'Your AWS SSO session for "' + profileName + '" has expired or could not be refreshed, ' +
                'so a presigned URL cannot be generated. Re-authorize the session by running ' +
                '`aws sso login --profile ' + profileName + '` on the host (or re-approve the ' +
                'authorization link when prompted), then retry. (' + (credErr.message || 'unknown error') + ')'
            );
            ssoErr.statusCode = credErr.statusCode || 401;
            ssoErr.ssoSessionExpired = true;
            return cb(ssoErr);
        }
        log.debug('after creating updated profile is: ', profileUtils.redactProfileForLog(profileUpdateObj));
        return cb(null, profileUpdateObj.roleCredentials);
    });

}

module.exports = {
    getRoleCredentialsForUser: getRoleCredentialsForUser,
    getSecurityToken: getSecurityToken,
    formatAuthorizationPendingMessage: formatAuthorizationPendingMessage
}
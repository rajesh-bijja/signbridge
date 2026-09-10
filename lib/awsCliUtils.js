
let os = require('os');
let profileUtils = require('./profileUtils')
const fs = require('fs');
let crypto = require('crypto')
const { spawn } = require('child_process');
let ssoUtils = require('./ssoUtils');
let coreUtils = require('./coreUtils');
let authnModes = require('./authnModes');
let credentialProvider = require('./credentialProvider');
let redact = require('./redact');
let log = require('./logger').create('awsCliUtils');

// get the data from the command execution
function invokeAwsCommand(subProcessCommand, cb) {
    //const subProcessCommand = spawn('aws', ['sso', 'login', '--profile', 'preprod-poweruser']);
    let output = '';

    subProcessCommand.stdout.on("data", data => {
        log.debug(`stdout: ${data}`);
        output += data;
    });

    subProcessCommand.stderr.on("data", data => {
        log.debug(`stderr: ${data}`);
        output += data;
    });
    subProcessCommand.on('error', (error) => {
        log.error(`error: ${error.message}`);
        output += error;
    });
    subProcessCommand.on("close", code => {
        log.debug(`child process exited with code ${code} and the output found is: ${output}`);
        //output = output.replace('\n', '\\n');
        let result = {
            'exitStatus': code,
            'output': output
        }
        return cb(null, result);
    });
}

function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function run() {
    await delay(5000);
}

/*
const subProcessCommand = spawn('aws', ['ec2', 'describe-instances',  '--filters',
    "Name=instance-state-name,Values=running", "Name=tag:Name,Values=omnisearch-api-service*",
    '--profile', 'preprod-poweruser']);
*/


function invokeCommand(req, res) {
    if(!req.body) {
        return res.status(400).json({'message': 'request payload not available.'});
    }
    if(!req.body.options) {
        return res.status(400).json({'message': 'options not provided in request payload'});
    }
    log.debug('payload provided for invokeCommand: ', redact.forLog(req.body));
    let options = req.body.options;
    if(!options['userName']) {
        return res.status(400).json({'message': 'userName not specified in the request payload options'});
    }
    if(!options['profileName']) {
        return res.status(400).json({'message': 'profileName not specified in the request payload options'});
    }
    if(!options['authnMode']) {
        return res.status(400).json({'message': 'authnMode not specified in the request payload options'});
    }
    if(!options['commandPayload']) {
        return res.status(400).json({'message': 'command payload to be executed not specified in the request payload options'});
    }
    let commandPayload = options['commandPayload'];
    log.debug('provided commandPayload: ', commandPayload);
    if (commandPayload.trim().length == 0) {
        return res.status(400).json({'message': 'invalid command payload specified.'});
    }

    if (options['authnMode'] === 'sso_user') {
        coreUtils.getOrCreateScriptsDir(options['userName'], (scriptDirErr, scriptsDir) => {
            if (scriptDirErr) {
                return res.status(400).json({'message': scriptDirErr.message});
            }
            let scriptFile = scriptsDir + '/' + new Date().getTime();
            fs.writeFileSync(scriptFile, commandPayload);
            fs.chmodSync(scriptFile, 0o755);


            let profileName = options['profileName'];
            profileUtils.searchProfile(options['userName'], profileName, (profileReadErr, profileReadObj) => {
                if (profileReadErr) {
                    return res.status(400).json({'message': profileReadErr.message});
                }
                log.debug('profile obtained from search: ', profileUtils.redactProfileForLog(profileReadObj));
                ssoUtils.getSecurityToken(profileReadObj, (credErr, roleCredentials) => {
                    if (credErr) {
                        let responseStatusCode = 401;
                        let responseHeaders = {};
                        let data = credErr.message;
                        return logAndReturn(options, responseStatusCode, responseHeaders, data, res, true);
                        //return res.status(credErr.statusCode || responseStatusCode).json({'message': credErr.message});
                    }
                    let region = profileReadObj.ssoRegion;
                    let accessToken = roleCredentials.accessTokenDetails.accessToken;
                    let expiresAt = new Date(roleCredentials.accessTokenDetails.expiresInMilliseconds).toISOString();
                    let startUrl = profileReadObj.awsSsoStartUrl;
                    let hash = crypto.createHash('sha1');
                    //const hash = createHash('sha1');
                    let fileName = hash.update(startUrl, 'utf-8').digest('hex') + '.json';
                    let credentialsDir = '~/.aws/sso/cache/';
                    credentialsDir = credentialsDir.replace('~', os.homedir);
                    let credentialsFilePath = credentialsDir + fileName;
                    let accessTokenCredsObj = '{"startUrl": "' + startUrl + '", "region": "' + region +
                        '", "accessToken": "' + accessToken + '", "expiresAt": "' + expiresAt + '"}';
                    fs.writeFile(credentialsFilePath, accessTokenCredsObj, writeErr => {
                        if (writeErr) {
                            let responseStatusCode = 400;
                            let responseHeaders = {};
                            let data = writeErr.message;
                            return logAndReturn(options, responseStatusCode, responseHeaders, data, res, true);
                            //return res.status(400).json({'message': writeErr.message});
                        } else {
                            const subProcessCommand = spawn(scriptFile);
                            log.debug('invoking scriptFile: ', scriptFile)
                            invokeAwsCommand(subProcessCommand, (invokeErr, result) => {
                                let responseStatusCode;
                                let responseHeaders = {};
                                let data;
                                if (invokeErr) {
                                    responseStatusCode = invokeErr.statusCode || 400;
                                    data = invokeErr.message;
                                } else if (result.exitStatus == 0 ){
                                    responseStatusCode = 200;
                                    data = result.output;
                                    log.debug('total result of the script: ', result);
                                } else {
                                    responseStatusCode = 400;
                                    data = result.output;
                                }
                                return logAndReturn(options, responseStatusCode, responseHeaders, data, res, false);
                            });
                        }
                    });

                });
            });
        });
    } else if (authnModes.isAwsAuthnMode(options['authnMode'])) {
        // iam_user / ec2_instance / irsa.
        //
        // The sso_user path above works by writing an SSO access token into
        // ~/.aws/sso/cache so that `aws --profile <name>` resolves it. There is no
        // equivalent cache entry for an EC2 instance profile or an IRSA role, so
        // these modes hand the credentials to the CLI the other supported way:
        // the standard environment variables, on the spawned process's own env.
        //
        // Two consequences worth knowing, both surfaced to the user:
        //   - The command must NOT pass `--profile`; a named profile makes the CLI
        //     ignore the environment and look in ~/.aws/config instead.
        //   - Secrets are passed via env, never on the command line, so they do
        //     not appear in the process table (same rule as Sandbox mode).
        runCommandWithEnvCredentials(options, commandPayload, res);
    } else {
        return res.status(400).json({'message': 'cli execution needs an AWS profile. Supported mechanisms: ' +
            authnModes.AWS_MODES.join(', ') + '.'});
    }

}

/**
 * Run the command with credentials injected as environment variables. Used for
 * every AWS mode except sso_user (which has its own token-cache path above).
 */
function runCommandWithEnvCredentials(options, commandPayload, res) {
    credentialProvider.resolveByProfileName(options['userName'], options['profileName'], options['authnMode'],
        (credErr, resolved) => {
            if (credErr) {
                let responseHeaders = {};
                if (credErr.verificationUriComplete) {
                    responseHeaders['verificationUriComplete'] = credErr.verificationUriComplete;
                }
                return logAndReturn(options, credErr.statusCode || 401, responseHeaders, credErr.message, res, true);
            }
            coreUtils.getOrCreateScriptsDir(options['userName'], (scriptDirErr, scriptsDir) => {
                if (scriptDirErr) {
                    return res.status(400).json({'message': scriptDirErr.message});
                }
                let scriptFile = scriptsDir + '/' + new Date().getTime();
                fs.writeFileSync(scriptFile, commandPayload);
                fs.chmodSync(scriptFile, 0o755);

                let childEnv = Object.assign({}, process.env);
                childEnv['AWS_ACCESS_KEY_ID'] = resolved.credentials.accessKeyId;
                childEnv['AWS_SECRET_ACCESS_KEY'] = resolved.credentials.secretAccessKey;
                if (resolved.credentials.sessionToken) {
                    childEnv['AWS_SESSION_TOKEN'] = resolved.credentials.sessionToken;
                } else {
                    // A stale token from an earlier run would be signed alongside
                    // long-lived keys and rejected.
                    delete childEnv['AWS_SESSION_TOKEN'];
                }
                childEnv['AWS_REGION'] = resolved.region;
                childEnv['AWS_DEFAULT_REGION'] = resolved.region;
                // An inherited AWS_PROFILE would override the environment credentials.
                delete childEnv['AWS_PROFILE'];
                childEnv['AWS_PAGER'] = '';

                const subProcessCommand = spawn(scriptFile, { env: childEnv });
                log.debug('invoking scriptFile with environment credentials (' + resolved.authnMode + '): ', scriptFile);
                invokeAwsCommand(subProcessCommand, (invokeErr, result) => {
                    let responseStatusCode;
                    let responseHeaders = {};
                    let data;
                    if (invokeErr) {
                        responseStatusCode = invokeErr.statusCode || 400;
                        data = invokeErr.message;
                    } else if (result.exitStatus == 0) {
                        responseStatusCode = 200;
                        data = result.output;
                    } else {
                        responseStatusCode = 400;
                        data = result.output;
                    }
                    return logAndReturn(options, responseStatusCode, responseHeaders, data, res, false);
                });
            });
        });
}

function logAndReturn(options, responseStatusCode, responseHeaders, data, res, isJson) {
    options['method'] = 'Cli';
    options['invocationMode'] = 'Cli';
    profileUtils.createHistory(options['userName'], options, responseStatusCode, responseHeaders, data, (createHistoryErr) => {
        if (createHistoryErr) {
            log.error('error in creating the history in [', options['authnMode'],  ']. error is : ', createHistoryErr);
        }
        if (isJson) {
            return res.status(responseStatusCode).json({'message': data});
        } else {
            return res.status(responseStatusCode).send(data);
        }
    });
}

module.exports = {
    invokeCommand: invokeCommand
}

/* global __dirname */

/**
 * profileUtils.js
 *
 * Part of SignBridge. Licensed under the MIT License.
 * Created on 07/20/23.
 */
"use strict";

let fs = require('fs');
let path = require('path');
let recursive = require("recursive-readdir");
let jsonfile = require('jsonfile');
jsonfile.spaces = 2;
let coreUtils = require('./coreUtils');
let awsConfigWriter = require('./awsConfigWriter');
let authnModes = require('./authnModes');
let redact = require('./redact');
let log = require('./logger').create('profileUtils');
const { randomUUID: uuidv4 } = require('crypto');

const UTF8 = 'utf8';
const PROFILE_EXT = '.json';

let constants = {
    EXECUTION_DETAILS_FILE_NAME: 'executionDetailsFileName',
    EXECUTED_DATE: 'executedDate',
    EXECUTED_DATE_READABLE: 'executedDateReadable',
    REQUEST_STATUS: 'requestStatus',
    CREATED: 'created',
    CREATED_READABLE: 'createdReadable',
    LAST_MODIFIED: 'lastModified',
    LAST_MODIFIED_READABLE: 'lastModifiedReadable',
    VERSION: 'version',
    AUTHN_MODE: 'authnMode',
    METHOD: 'method',
    VERSION_VALUE: '1.0',
    HISTORY_ID: 'historyId',
    FAVORITE_ID: 'favoriteId',
    PROFILENAME: 'profileName',
    REQUESTLABEL: 'requestLabel',
    USERNAME: 'userName'
};

// Fields on a profile that are secrets. A profile is stored on disk in full
// (that is the point of a profile), but it must never reach a log — and these
// handlers log their payloads liberally, which used to mean every create,
// update and profile listing printed IAM secret access keys to the server log.
// An EC2 profile adds an SSH private key and password to that set, so the
// redaction is now shared by every profile log line.
const SECRET_PROFILE_FIELDS = [
    'awsSecretAccessKey',
    'restPassword',
    'bearerToken',
    'bearerClientSecret',
    'bearerPassword',
    'ec2SshPrivateKey',
    'ec2SshPrivateKeyPassphrase',
    'ec2SshPassword'
];

// Shallow copy with the secrets masked, plus the nested credential caches
// dropped wholesale (they hold minted session credentials).
//
// The named-field pass runs first because its output is more readable than a
// generic one ('[credentials omitted]' says why the object is gone), and
// `redact.forLog` runs over the result as the backstop: a profile field added
// later that happens to hold a token is then redacted by its *name* without
// anyone having to remember this list. The two are deliberately layered rather
// than one replacing the other — this list is the documented intent, and the
// substring rule is what catches the field nobody thought about.
function redactProfileForLog(profile) {
    if (!profile || typeof profile !== 'object') {
        return profile;
    }
    if (Array.isArray(profile)) {
        return profile.map(redactProfileForLog);
    }
    let safe = Object.assign({}, profile);
    SECRET_PROFILE_FIELDS.forEach((field) => {
        if (safe[field]) {
            safe[field] = '********';
        }
    });
    ['roleCredentials', 'ec2RoleCredentials', 'irsaRoleCredentials'].forEach((field) => {
        if (safe[field]) {
            safe[field] = '[credentials omitted]';
        }
    });
    return redact.forLog(safe);
}

function searchProfile(loginUserName, profileName, cb) {
    try {
    let profileDir = profileName;
    let fileName = profileName + PROFILE_EXT;
    coreUtils.getOrCreateProfilesDir(loginUserName, profileDir, (err, profilesAbsoluteDir) => {
        if (err) {
            return cb(err);
        } else {
            let profileFile = path.resolve(profilesAbsoluteDir + "/" + fileName);
            log.debug('searchProfile: profileFile in search: ', profileFile);
            if (!fs.existsSync(profileFile)) {
                let error = new Error('profile: ' + profileName + ' not exists.');
                error.statusCode = 404;
                return cb(error);
            }
            let stats = fs.statSync(profileFile);
            if (!stats.isFile()) {
                let error = new Error('profile: ' + profileName + ' not exists');
                error.statusCode = 404;
                return cb(error);
            }
            jsonfile.readFile(profileFile, UTF8, (readErr, profileReadObj) => {
                if (readErr) {
                    readErr.statusCode = 400;
                    log.error('Error in reading the profile : ', profileName, readErr,);
                    return cb(readErr);
                } else {
                    return cb(err, profileReadObj);
                }
            });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in searchProfile: ', catchErr);
        cb(catchErr);
    }
}

function populateHistoryDetails(req, res) {
    try {
        let inputObj = req.body;
        if(!inputObj) {
            let message = 'populateHistory: payload not provided in request';
            return res.status(400).json({'message': message});
        }
        let loginUserName = inputObj[constants.USERNAME];
        if (!loginUserName) {
            let message = 'populateHistory: ' + constants.USERNAME + ' not provided in request payload.';
            return res.status(400).json({'message': message});
        }
        coreUtils.searchOrCreateBasicHistoryArtifacts(loginUserName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
            if (err) {
                res.status(400).json({'message': err.message});
            } else {
                let inputRequestLabel = inputObj[constants.REQUESTLABEL];
                log.debug('inputRequestLabel is ', inputRequestLabel);
                if (inputRequestLabel) {
                    let searchByLabelOutput = historyMetadataOutputObj.filter((eachRequestHistory) => {
                        let eachRequestLabel = eachRequestHistory[constants.REQUESTLABEL] || 'Not Specified';
                        inputRequestLabel = inputRequestLabel.toLowerCase();
                        eachRequestLabel = eachRequestLabel.toLowerCase();
                        return inputRequestLabel === eachRequestLabel || inputRequestLabel.includes(eachRequestLabel) || eachRequestLabel.includes(inputRequestLabel);
                    });
                    res.status(201).json(searchByLabelOutput.reverse());
                } else {
                    res.status(201).json(historyMetadataOutputObj.reverse());
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in populateHistory: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function addHistoryToFavorites(req, res) {
    try {
        let inputObj = req.body;
        if(!inputObj) {
            let message = 'addHistoryToFavorites: payload not provided in request';
            return res.status(400).json({'message': message});
        }
        let loginUserName = inputObj[constants.USERNAME];
        if (!loginUserName) {
            let message = 'addHistoryToFavorites: ' + constants.USERNAME + ' not provided in request payload.';
            return res.status(400).json({'message': message});
        }
        let historyId = inputObj[constants.HISTORY_ID];
        if(!historyId) {
            let message = 'addHistoryToFavorites: historyId not provided in payload';
            return res.status(400).json({'message': message});
        }
        coreUtils.searchOrCreateBasicHistoryArtifacts(loginUserName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
            if (err) {
                return res.status(400).json({'message': err.message});
            } else {
                let searchByHistoryIdOutput = historyMetadataOutputObj.filter((eachRequestHistory) => {
                    let eachRequestHistoryName = eachRequestHistory[constants.EXECUTION_DETAILS_FILE_NAME];
                    return (historyId + '.json') === eachRequestHistoryName;
                });
                if (searchByHistoryIdOutput.length == 0) {
                    return res.status(400).json({'message': 'History not found for the given id: ' + historyId + '. Can not add to favorites.'});
                }
                if (searchByHistoryIdOutput.length > 1) {
                    return res.status(400).json({'message': 'More than one History found for the given id: ' + historyId + '. Can not add to favorites.'});
                }
                let historyFromMetadata = searchByHistoryIdOutput[0];
                coreUtils.addToFavoritesAndUpdateMetadata(historyId, historyFromMetadata, historyAbsoluteDir, loginUserName, (err) => {
                    if (err) {
                        return res.status(400).json({'message': err.message});
                    } else {
                        res.status(201).json({'message': 'success'});
                    }
                });
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in populateHistory: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function populateFavoriteDetails(req, res) {
    try {
        let inputObj = req.body;
        if(!inputObj) {
            let message = 'populateFavoriteDetails: payload not provided in request';
            return res.status(400).json({'message': message});
        }
        let loginUserName = inputObj[constants.USERNAME];
        if (!loginUserName) {
            let message = 'populateFavoriteDetails: ' + constants.USERNAME + ' not provided in request payload.';
            return res.status(400).json({'message': message});
        }
        coreUtils.searchOrCreateBasicFavoriteArtifacts(loginUserName, (err, favoritesMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile) => {
            if (err) {
                res.status(400).json({'message': err.message});
            } else {
                let inputRequestLabel = inputObj[constants.REQUESTLABEL];
                log.debug('inputRequestLabel is ', inputRequestLabel);
                if (inputRequestLabel) {
                    let searchByLabelOutput = favoritesMetadataOutputObj.filter((eachRequestHistory) => {
                        let eachRequestLabel = eachRequestHistory[constants.REQUESTLABEL] || 'Not Specified';
                        inputRequestLabel = inputRequestLabel.toLowerCase();
                        eachRequestLabel = eachRequestLabel.toLowerCase();
                        return inputRequestLabel === eachRequestLabel || inputRequestLabel.includes(eachRequestLabel) || eachRequestLabel.includes(inputRequestLabel);
                    });
                    res.status(201).json(searchByLabelOutput.reverse());
                } else {
                    res.status(201).json(favoritesMetadataOutputObj.reverse());
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in populateFavoriteDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function populateSettingsDetails(req, res) {
    try {
        let inputObj = req.body;
        if(!inputObj) {
            let message = 'populateSettingsDetails: payload not provided in request';
            return res.status(400).json({'message': message});
        }
        let loginUserName = inputObj[constants.USERNAME];
        if (!loginUserName) {
            let message = 'populateSettingsDetails: ' + constants.USERNAME + ' not provided in request payload.';
            return res.status(400).json({'message': message});
        }
        coreUtils.searchOrCreateBasicSettingsArtifacts(loginUserName, (err, settingsMetadataOutputObj, settingsAbsoluteDir, settingsMetadataFile) => {
            if (err) {
                res.status(400).json({'message': err.message});
            } else {
                res.status(201).json(settingsMetadataOutputObj);
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in populateSettingsDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function extractSettingsInputFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('extractSettingsInputFromRequest: request body not available'));
    } else {
        if(!req.body.settings) {
            return cb(new Error('settings object not provided in request payload'));
        }
        log.debug('settings payload provided : ', redact.forLog(req.body.settings));
        let settingsInputObj = req.body.settings;
        let loginUserName;
        if(!req.body[constants.USERNAME]) {
            return cb(new Error(constants.USERNAME + ' not provided in request payload.'));
        }
        loginUserName = req.body[constants.USERNAME];
        return cb(null, settingsInputObj, loginUserName);
    }
}

function updateSettingsDetails(req, res) {
    try {
        extractSettingsInputFromRequest(req, (err, settingsInputObj, loginUserName) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                log.debug('updateSettingsDetails: after processing input, settings is: ', settingsInputObj);
                coreUtils.searchOrCreateBasicSettingsArtifacts(loginUserName, (err, settingsReadObj, settingsAbsoluteDir, settingsMetadataFile) => {
                    if (err) {
                        log.error('Error in updating settings: ', err);
                        res.status(400).json({'message': err.message});
                    } else {
                        let settingsOutputObj = Object.assign(settingsReadObj, settingsInputObj);

                        if (settingsOutputObj['tinyUrlIntegration']['isEnabled'] &&
                            (settingsOutputObj['tinyUrlIntegration']['token'] == null || settingsOutputObj['tinyUrlIntegration']['token'].length == 0)) {
                            return res.status(400).json({'message': 'tiny url token not provided in request payload'});
                        } else {
                            jsonfile.writeFile(settingsMetadataFile, settingsOutputObj, { spaces: 2 }, (writeErr) => {
                                if (writeErr) {
                                    log.error('error in updating the settings : ', writeErr);
                                    res.status(400).json({'message': writeErr.message});
                                } else {
                                    res.status(201).json(settingsOutputObj);
                                }
                            });
                        }
                    }
                });
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in updateProfileDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function createHistory(loginUserName, completeRequestData, responseStatusCode, responseHeaders, responseData, cb) {
    coreUtils.searchOrCreateBasicHistoryArtifacts(loginUserName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
        if (err) {
            cb(err);
        } else {
            let eachHistoryMetadataObj = {};
            let addTime = new Date();
            eachHistoryMetadataObj[constants.METHOD] = completeRequestData[constants.METHOD];
            eachHistoryMetadataObj[constants.PROFILENAME] = completeRequestData[constants.PROFILENAME];
            eachHistoryMetadataObj[constants.AUTHN_MODE] = completeRequestData[constants.AUTHN_MODE];
            eachHistoryMetadataObj[constants.EXECUTED_DATE] = addTime;
            eachHistoryMetadataObj[constants.EXECUTED_DATE_READABLE] = addTime.toString();
            if (responseStatusCode >= 400) {
                eachHistoryMetadataObj[constants.REQUEST_STATUS] = 'Failed';
            } else {
                eachHistoryMetadataObj[constants.REQUEST_STATUS] = 'Complete';
            }
            eachHistoryMetadataObj[constants.REQUESTLABEL] = 'Not Specified';
            let executionDetailsFileName = uuidv4().toUpperCase().replace(/-/g, '') + PROFILE_EXT;
            let executionDetailsAbsoluteFileName = path.resolve( historyAbsoluteDir + '/' + executionDetailsFileName);
            eachHistoryMetadataObj[constants.EXECUTION_DETAILS_FILE_NAME] = executionDetailsFileName;
            historyMetadataOutputObj.push(eachHistoryMetadataObj);
            coreUtils.updateHistoryMetadata(loginUserName, historyMetadataOutputObj, historyMetadataFile, (updateHistoryMetadataErr) => {
                if (updateHistoryMetadataErr) {
                    cb(updateHistoryMetadataErr);
                } else {
                    coreUtils.createHistoryDetailsForTheGivenRequest(executionDetailsAbsoluteFileName, completeRequestData, responseStatusCode, responseHeaders, responseData, (historyDetailsErr) => {
                        if (historyDetailsErr) {
                            cb(historyDetailsErr);
                        } else {
                            cb(null);
                        }
                    });
                }
            });
        }
    });
}

function createProfile(profileInputObj, cb) {
    try {
    let profileDir = profileInputObj[constants.PROFILENAME];
    let fileName = profileInputObj[constants.PROFILENAME] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    coreUtils.getOrCreateProfilesDir(loginUserName, profileDir, (err, profilesAbsoluteDir) => {
        if (err) {
            return cb(err);
        } else {
            let profileFile = path.resolve(profilesAbsoluteDir + "/" + fileName);
            log.debug('profileFile in create: ', profileFile);
            if (fs.existsSync(profileFile)) {
                let stats = fs.statSync(profileFile);
                if (stats.isFile()) {
                    let error = new Error('profile: ' + profileInputObj[constants.PROFILENAME] + ' already exists.');
                    return cb(error);
                }
            }
            let profileOutputObj = profileInputObj;
            let addTime = new Date();
            profileOutputObj[constants.VERSION] = constants.VERSION_VALUE;
            profileOutputObj[constants.CREATED] = addTime;
            profileOutputObj[constants.CREATED_READABLE] = addTime.toString();
            profileOutputObj[constants.LAST_MODIFIED] = addTime;
            profileOutputObj[constants.LAST_MODIFIED_READABLE] = addTime.toString();

            if (!profileOutputObj['region']) {
                profileOutputObj['region'] = profileOutputObj['ssoRegion']
            }
            if (!profileOutputObj['region']) {
                //let err1 = new Error('region not specified in the payload');
                //err1.statusCode = 400;
                //return cb(err1);
                profileOutputObj['region'] = 'us-east-1';
            }
            // One definition, shared with updateProfile — see lib/authnModes.js.
            profileOutputObj['supportedAuthnMechanisms'] =
                authnModes.deriveSupportedAuthnMechanisms(profileOutputObj);
            // OIDC / SSO portal endpoints only make sense for SSO profiles. For
            // IAM/REST/Bearer/Generic profiles ssoRegion is undefined, and stamping
            // these unconditionally produced bogus values like
            // 'oidc.undefined.amazonaws.com' and 'account_id=undefined'.
            let ssoRegion = profileOutputObj['ssoRegion'];
            if (profileOutputObj['awsSsoUserEnabled'] && ssoRegion) {
                profileOutputObj['oidcHostname'] = 'oidc.' + ssoRegion + '.amazonaws.com';
                profileOutputObj['oidcRegisterClientPath'] = '/client/register';
                profileOutputObj['oidcDeviceAuthorizationPath'] = '/device_authorization';
                profileOutputObj['oidcAccessTokenPath'] = '/token';
                profileOutputObj['roleCredentialsHostname'] = 'portal.sso.' + ssoRegion + '.amazonaws.com';
                profileOutputObj['roleCredentialsPath'] = '/federation/credentials?account_id=' + profileOutputObj['awsSsoAccountId'] + '&role_name=' + profileOutputObj['awsSsoRoleName'];
            }

            jsonfile.writeFile(profileFile, profileOutputObj, { spaces: 2 }, (writeErr) => {
                if (writeErr) {
                    log.error('error in creating the profile : ', profileInputObj[constants.PROFILENAME], ' : ', writeErr);
                    return cb(writeErr);
                } else {
                    return cb(null, profileOutputObj);
                }
            });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in createProfile: ', catchErr);
        cb(catchErr);
    }
}

function getPublicClientCreds(region, cb) {
    let credsFile = coreUtils.getPublicClientCreds(region);
    if (!fs.existsSync(credsFile)) {
        let credsInputObj = {}
        jsonfile.writeFile(credsFile, credsInputObj, { spaces: 2 }, (writeErr) => {
            if (writeErr) {
                log.error('error in creating the creds file : ', credsFile, ' : ', writeErr);
                return cb(writeErr);
            } else {
                return cb(null, credsInputObj);
            }
        });
    } else {
        let stats = fs.statSync(credsFile);
        if (!stats.isFile()) {
            let error = new Error('creds file: ' + credsFile + ' not exists to return.');
            return cb(error);
        }
        jsonfile.readFile(credsFile, UTF8, (readErr, credsReadObj) => {
            if (readErr) {
                log.error('Error in reading the creds file : ', credsFile, ' : ', readErr);
                return cb(readErr);
            } else {
                cb(null, credsReadObj);
            }
        });
    }
}

function updatePublicClientCreds(region, credsInputObj, cb) {
    let credsFile = coreUtils.getPublicClientCreds(region);
    if (fs.existsSync(credsFile)) {
        let stats = fs.statSync(credsFile);
        if (!stats.isFile()) {
            let error = new Error(credsFile + ' is not a file to modify.');
            return cb(error);
        }
        jsonfile.readFile(credsFile, UTF8, (readErr, credsReadObj) => {
            if (readErr) {
                log.error('Error in reading the creds file : ', credsFile, ' : ', readErr);
                return cb(readErr);
            } else {
                let credsOutputObj = Object.assign(credsReadObj, credsInputObj);
                jsonfile.writeFile(credsFile, credsOutputObj, { spaces: 2 }, (writeErr) => {
                    if (writeErr) {
                        log.error('error in updating the creds file : ', credsFile, ' : ', writeErr);
                        return cb(writeErr);
                    } else {
                        return cb(null, credsOutputObj);
                    }
                });
            }
        });
    } else {
        let error = new Error('creds file: ' + credsFile + ' not exists to modify.');
        return cb(error);
    }
}

function updateProfile(profileInputObj, cb) {
    try {
    let profileDir = profileInputObj[constants.PROFILENAME];
    let fileName = profileInputObj[constants.PROFILENAME] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    coreUtils.getOrCreateProfilesDir(loginUserName, profileDir, (err, profilesAbsoluteDir) => {
        if (err) {
            return cb(err);
        } else {
            let profileFile = path.resolve(profilesAbsoluteDir + "/" + fileName);
            log.debug('updateProfile: profileFile in search: ', profileFile);
            if (!fs.existsSync(profileFile)) {
                let stats = fs.statSync(profileFile);
                if (!stats.isFile()) {
                    let error = new Error('profile: ' + profileInputObj[constants.PROFILENAME] + ' not exists to modify.');
                    return cb(error);
                }
            }
            jsonfile.readFile(profileFile, UTF8, (readErr, profileReadObj) => {
                if (readErr) {
                    log.error('Error in reading the profile : ', profileInputObj[constants.PROFILENAME], ' : ', readErr);
                    return cb(readErr);
                } else {
                    //let profileOutputObj = profileInputObj;
                    //let tmp = profileInputObj.roleCredentials;
                    //Object.assign(profileOutputObj, profileReadObj);

                    let profileOutputObj = Object.assign(profileReadObj, profileInputObj);

                    //profileOutputObj.roleCredentials = tmp.roleCredentials;
                    if (!profileOutputObj['region']) {
                        profileOutputObj['region'] = profileOutputObj['ssoRegion']
                    }
                    if (!profileOutputObj['region']) {
                        let err1 = new Error('region not available in the payload');
                        err1.statusCode = 400;
                        return cb(err1);
                    }

                    //profileOutputObj[constants.VERSION] = profileReadObj[constants.VERSION];
                    //profileOutputObj[constants.CREATED] = profileReadObj[constants.CREATED];
                    //profileOutputObj[constants.CREATED_READABLE] = profileReadObj[constants.CREATED_READABLE];

                    // Same derivation as createProfile (lib/authnModes.js). This
                    // block used to omit genericEnabled, so updating a Generic
                    // profile silently dropped 'generic' from its mechanisms.
                    profileOutputObj['supportedAuthnMechanisms'] =
                        authnModes.deriveSupportedAuthnMechanisms(profileOutputObj);
                    let modifyTime = new Date();
                    profileOutputObj[constants.LAST_MODIFIED] = modifyTime;
                    profileOutputObj[constants.LAST_MODIFIED_READABLE] = modifyTime.toString();
                    jsonfile.writeFile(profileFile, profileOutputObj, { spaces: 2 }, (writeErr) => {
                        if (writeErr) {
                            log.error('error in updating the profile : ', profileInputObj[constants.PROFILENAME], ' : ', writeErr);
                            return cb(writeErr);
                        } else {
                            return cb(null, profileOutputObj);
                        }
                    });
                }
            });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in updateProfile: ', catchErr);
        cb(catchErr);
    }
}

function deleteProfile(profileInputObj, cb) {
    let profileDir = profileInputObj[constants.PROFILENAME];
    let fileName = profileInputObj[constants.PROFILENAME] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    coreUtils.getOrCreateProfilesDir(loginUserName, profileDir, (err, profilesAbsoluteDir) => {
        if (err) {
            return cb(err);
        } else {
            let profileFile = path.resolve(profilesAbsoluteDir + "/" + fileName);
            log.debug('profileFile in delete: ', profileFile);
            fs.stat(profileFile, function (err, stats) {
                if (err) {
                    err.statusCode = 404;
                    return cb(err);
                }
                fs.unlink(profileFile,function(unlinkerr){
                    if(unlinkerr) {
                        unlinkerr.statusCode = 404;
                        return cb(unlinkerr);
                    }
                    log.debug('file : ', profileFile, ' deleted successfully');
                    try {
                        deleteDir(profilesAbsoluteDir);
                    } catch (err) {
                        log.error(`Error while deleting: ${profilesAbsoluteDir}. Error: ${err}`);
                    }
                    cb(null);
                });
            });
        }
    });
}
function deleteDir(profilesAbsoluteDir) {
    if( fs.existsSync(profilesAbsoluteDir) ) {
        fs.readdirSync(profilesAbsoluteDir).forEach(function(file,index){
            let curPath = profilesAbsoluteDir + "/" + file;
            if(fs.lstatSync(curPath).isDirectory()) { // recursive
                deleteDir(curPath);
            } else { // delete each file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(profilesAbsoluteDir);
        log.debug(`${profilesAbsoluteDir} is deleted!`);
    }
}

function ignoreFunc(file, stats) {
    return (stats.isDirectory() && path.basename(file) == "test") || (!(stats.isDirectory()) && file.substr(-1*(PROFILE_EXT.length)) !== PROFILE_EXT);
}

function getProfilesListInDir(loginUserName, cb) {
    coreUtils.getUserConfiguredProfilesBaseDir(loginUserName, (err, profilesAbsoluteDir) => {
        if (err) {
            cb(err);
        } else {
            log.debug('profilesAbsoluteDir: ', profilesAbsoluteDir);

            recursive(profilesAbsoluteDir, ["*.html", "*.txt", "*.readme", "*.test", ignoreFunc],function (err, files) {
                if (err) {
                    return cb(err);
                }
                cb(null, files);
            });
        }
    });
}

function readAllProfiles(filesList) {
    log.debug('readAllProfiles filelist : ', filesList);
    let profiles = [];
    let count = 0;
    for (count = 0; count < filesList.length; count ++) {
        let absoluteFile = filesList[count];
        try {
            let profile = jsonfile.readFileSync(absoluteFile, UTF8);
            profiles.push(profile);
        } catch (err) {
            log.error('error in reading the profile: ', absoluteFile, ' error: ', err);
        }
    }
    log.debug('all profiles complete details : ', redactProfileForLog(profiles));
    return profiles;
}

function populateProfilesDetails(req, res) {
    try {
    let inputObj = req.body;
    if(!inputObj) {
        let message = 'populateProfilesDetails: payload not provided in request';
        return res.status(400).json({'message': message});
    }
    let loginUserName = inputObj[constants.USERNAME];
    log.debug(inputObj);
    log.debug('loginUserName is ' + loginUserName);
    if (!loginUserName) {
        let message = 'populateProfilesDetails: ' + constants.USERNAME + ' not provided in payload.';
        return res.status(400).json({'message': message});
    }
    let loadProfilesDaemon = require('./loadProfilesDaemon');
    loadProfilesDaemon.loadHomeProfiles((syncErr) => {
        if (syncErr) {
            log.warn('populateProfilesDetails: AWS profile sync warning: ', syncErr.message || syncErr);
        }
        getProfilesListInDir(loginUserName, (err, filesList) => {
            if (err) {
                res.status(400).json({'message': err.message});
            } else {
                log.debug('files list : ', filesList);
                let profiles = readAllProfiles(filesList);
                res.status(201).json(profiles);
            }
        });
    }, loginUserName);
    } catch (catchErr) {
        log.error('caught unexpected error in populateProfilesDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function extractProfileInputFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('extractProfileInputFromRequest: request body not available'));
    } else {
        if(!req.body.profile) {
            return cb(new Error('profile object not provided in request payload'));
        }
        log.debug('payload : ', redactProfileForLog(req.body.profile));
        let profileInputObj = req.body.profile;
        if(!profileInputObj[constants.USERNAME]) {
            return cb(new Error(constants.USERNAME + ' not provided in payload'));
        }
        if(!profileInputObj[constants.PROFILENAME]) {
            return cb(new Error(constants.PROFILENAME + ' not provided in request payload'));
        }
        return cb(null, profileInputObj);
    }
}

// After a create/update, reconcile the profile with ~/.aws/config so the two
// stores stay in step. Only AWS IAM User / AWS SSO User profiles are touched;
// the writer no-ops for any other profile type.
//   - syncToAwsConfig=true  -> mirror the profile into ~/.aws/config (+ IAM keys
//                              into ~/.aws/credentials) so it is usable outside
//                              SignBridge (e.g. AWS CLI).
//   - syncToAwsConfig=false, on UPDATE -> the user turned sync off; remove the
//                              profile from ~/.aws/config (+ credentials) but
//                              KEEP it in our runtime artifacts. Not done on
//                              create (nothing was ever mirrored to remove).
// Neither a sync nor an unsync-removal failure fails the request — the profile
// is already saved in artifacts — the problem is surfaced via awsSyncWarning.
function respondWithOptionalAwsSync(res, statusCode, profileOutputObj, isUpdate) {
    let wantsSync = profileOutputObj && (profileOutputObj.syncToAwsConfig === true || profileOutputObj.syncToAwsConfig === 'true');
    // Only IAM-user and SSO profiles are representable in ~/.aws/config; EC2 and
    // IRSA profiles resolve credentials through SignBridge machinery (SSH to an
    // instance, a Kubernetes service-account token) that the AWS CLI cannot run.
    let isAwsProfile = authnModes.profileHasAwsConfigSyncableMode(profileOutputObj);
    if (!isAwsProfile) {
        return res.status(statusCode).json(profileOutputObj);
    }
    if (wantsSync) {
        awsConfigWriter.syncProfileToAwsConfig(profileOutputObj, (syncErr) => {
            if (syncErr) {
                profileOutputObj.awsSyncWarning = 'Profile saved, but syncing to ~/.aws/config failed: ' + syncErr.message;
            }
            res.status(statusCode).json(profileOutputObj);
        });
    } else if (isUpdate) {
        awsConfigWriter.removeProfileFromAwsConfig(profileOutputObj, (removeErr) => {
            if (removeErr) {
                profileOutputObj.awsSyncWarning = 'Profile saved, but removing it from ~/.aws/config failed: ' + removeErr.message;
            }
            res.status(statusCode).json(profileOutputObj);
        });
    } else {
        res.status(statusCode).json(profileOutputObj);
    }
}

function addProfileDetails(req, res) {
    try {
    extractProfileInputFromRequest(req, (err, profileInputObj) => {
        if(err) {
            res.status(400).json({'message': err.message});
        } else {
            log.debug('addProfileDetails: after processing input: ', redactProfileForLog(profileInputObj));
            createProfile(profileInputObj, (err, profileOutputObj) => {
                if(err) {
                    log.error('Error in creating profile. Please try later : ', err);
                    res.status(400).json({'message': err.message});
                } else {
                    respondWithOptionalAwsSync(res, 201, profileOutputObj, false);
                }
          });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in addProfileDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function checkProfileExists(req, res) {
    try {
        if(!req.body) {
            let message = 'checkProfileExists: request body not available';
            return res.status(400).json({'message': message});
        }
        if(!req.body.profile) {
            let message = 'checkProfileExists: profile object not provided in request payload';
            return res.status(400).json({'message': message});
        }
        log.debug('checkProfileExists payload : ', redactProfileForLog(req.body.profile));
        let profileInputObj = req.body.profile;
        let profileName = profileInputObj[constants.PROFILENAME];
        if(!profileName) {
            let message = 'checkProfileExists: ' + constants.PROFILENAME + ' not provided in request payload';
            return res.status(400).json({'message': message});
        }
        let authnMode = profileInputObj[constants.AUTHN_MODE];
        if(!authnMode) {
            let message = 'checkProfileExists: ' + constants.AUTHN_MODE + ' not provided in request payload';
            return res.status(400).json({'message': message});
        }
        let loginUserName = profileInputObj[constants.USERNAME];
        if(!loginUserName) {
            let message = 'checkProfileExists: ' + constants.USERNAME + ' not provided in request payload';
            return res.status(400).json({'message': message});
        }
        searchProfile(loginUserName, profileName, (err, profileOutputObj) => {
            if(err) {
                let statusCode = err.statusCode || 400;
                log.error('Error in searching the profile : ', err);
                res.status(statusCode).json({'message': err.message});
            } else {
                let supportedAuthnMechanisms = profileOutputObj.supportedAuthnMechanisms;
                let responseMsg = '';
                if (!supportedAuthnMechanisms || supportedAuthnMechanisms.length === 0) {
                    responseMsg = 'profile: ' + profileName + ' exists but authentication mechanism are not defined in it ';
                    res.status(400).json({'message': responseMsg});
                } else if (supportedAuthnMechanisms.includes(authnMode)) {
                    responseMsg = 'profile: ' + profileName + ' exists with the authentication mechanism: ' + authnMode;
                    res.status(200).json({'message': responseMsg});
                } else {
                    responseMsg = 'profile: ' + profileName + ' exists but does not have authentication mechanism: ' + authnMode;
                    res.status(400).json({'message': responseMsg});
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in checkProfileExists: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function searchProfilesDetails(req, res) {
    try {
    if(!req.body) {
        let message = 'searchProfilesDetails: request body not available';
        return res.status(400).json({'message': message});
    }
    if(!req.body.profile) {
        let message = 'searchProfilesDetails: profile object not provided in request payload';
        return res.status(400).json({'message': message});
    }
    log.debug('searchProfilesDetails payload : ', redactProfileForLog(req.body.profile));
    let profileInputObj = req.body.profile;
    let profileName = profileInputObj[constants.PROFILENAME];
    if(!profileName) {
        let message = 'searchProfilesDetails: ' + constants.PROFILENAME + ' not provided in request payload';
        return res.status(400).json({'message': message});
    }
    let loginUserName = profileInputObj[constants.USERNAME];
    if(!loginUserName) {
        let message = 'searchProfilesDetails: ' + constants.USERNAME + ' not provided in request payload';
        return res.status(400).json({'message': message});
    }
    searchProfile(loginUserName, profileName, (err, profileOutputObj) => {
        if(err) {
            let statusCode = err.statusCode || 400;
            log.error('Error in searching profile. Please try later : ', err);
            res.status(statusCode).json({'message': err.message});
        } else {
            res.status(200).json(profileOutputObj);
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in searchProfilesDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}


function updateProfileDetails(req, res) {
    try {
    extractProfileInputFromRequest(req, (err, profileInputObj) => {
        if(err) {
            res.status(400).json({'message': err.message});
        } else {
            log.debug('updateProfileDetails: after processing input: ', redactProfileForLog(profileInputObj));
            updateProfile(profileInputObj, (err, profileOutputObj) => {
                if(err) {
                    log.error('Error in updating profile. Please try later : ', err);
                    res.status(400).json({'message': err.message});
                } else {
                    respondWithOptionalAwsSync(res, 201, profileOutputObj, true);
                }
            });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in updateProfileDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}


function deleteProfileDetails(req, res) {
    try {
    extractProfileInputFromRequest(req, (err, profileInputObj) => {
        if(err) {
            res.status(400).json({'message': err.message});
        } else {
            log.debug('deleteProfileDetails: after processing input: ', redactProfileForLog(profileInputObj));
            deleteProfile(profileInputObj, (err, profileOutputObj) => {
                if(err) {
                    let statusCode = 400;
                    if (err.statusCode) {
                        statusCode = err.statusCode;
                    }
                    log.error('Error in deleting profile. Please try later : ', err);
                    res.status(statusCode).json({'message': err.message});
                } else {
                    // Keep the two stores consistent: if this synced AWS profile
                    // was mirrored into ~/.aws/config, remove it there too — else
                    // the startup/populate re-import would resurrect it.
                    let wasSynced = profileInputObj.syncToAwsConfig === true || profileInputObj.syncToAwsConfig === 'true';
                    let isAwsProfile = authnModes.profileHasAwsConfigSyncableMode(profileInputObj);
                    if (wasSynced && isAwsProfile) {
                        awsConfigWriter.removeProfileFromAwsConfig(profileInputObj, (removeErr) => {
                            if (removeErr) {
                                // Artifact delete already succeeded; report the
                                // partial result rather than a hard failure.
                                return res.status(200).json({
                                    'message': 'Profile deleted, but removing it from ~/.aws/config failed: ' + removeErr.message
                                });
                            }
                            res.status(204).end();
                        });
                    } else {
                        res.status(204).end();
                    }
                }
            });
        }
    });
    } catch (catchErr) {
        log.error('caught unexpected error in deleteProfileDetails: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

module.exports = {
    populateProfilesDetails: populateProfilesDetails,
    searchProfilesDetails: searchProfilesDetails,
    checkProfileExists: checkProfileExists,
    searchProfile: searchProfile,
    addProfileDetails: addProfileDetails,
    updateProfileDetails: updateProfileDetails,
    deleteProfileDetails: deleteProfileDetails,
    createProfile: createProfile,
    updateProfile: updateProfile,
    createHistory: createHistory,
    populateHistoryDetails: populateHistoryDetails,
    populateFavoriteDetails: populateFavoriteDetails,
    addHistoryToFavorites: addHistoryToFavorites,
    populateSettingsDetails: populateSettingsDetails,
    updateSettingsDetails: updateSettingsDetails,
    getPublicClientCreds: getPublicClientCreds,
    updatePublicClientCreds: updatePublicClientCreds,
    redactProfileForLog: redactProfileForLog,
    constants: constants
};

"use strict";

let fs = require('fs');
let os = require('os');
let path = require('path');
let profileUtils = null;
let propertiesReader = require('properties-reader');
let authConfig = require('./authConfig');

let paths = require('./paths');
let log = require('./logger').create('loadProfilesDaemon');
let propsFileName = 'config.properties';
let props = propertiesReader(__dirname + '/../' + propsFileName);
let profilesDirName = props.get('server.profilesDirName') || 'profiles';

const MOUNTED_AWS_DIR = '/var/www/.aws';
const MOUNTED_AWS_CONFIG = MOUNTED_AWS_DIR + '/config';
const MOUNTED_AWS_CREDENTIALS = MOUNTED_AWS_DIR + '/credentials';
const AWS_HOME_CONFIG = '~/.aws/config';
const AWS_HOME_CREDENTIALS = '~/.aws/credentials';

function resolveEffectiveUser(loginUserName) {
    return loginUserName || process.env.USER_NAME || authConfig.getDefaultUserName();
}


function readFileContent(path) {
    try {
        let awsConfigContent = fs.readFileSync(path, 'utf-8').split("\n");
        return awsConfigContent;
    } catch (err) {
        log.error('Error in reading the content of the file: ', path, ' : ', err.message);
        return null;
    }
}

function readAwsConfig() {
    let configFile = AWS_HOME_CONFIG;
    try {
        configFile = configFile.replace('~', os.homedir);
        configFile = path.resolve(configFile);
        let stats = fs.statSync(configFile);
        if (stats.isDirectory()) {
            let error = new Error(configFile + ' is a directory but not a file.');
            error.statusCode = 404;
            throw error;
        } else if (!stats.isFile()) {
            let error = new Error(configFile + ' not exists');
            error.statusCode = 404;
            throw error;
        } else {
            log.debug(configFile, ' is available.');
            return configFile;
        }
    } catch (err) {
        log.debug('Error in finding the home profile: ', configFile, ' : ', err.message);
        log.debug(configFile, ' does not seem to exist. Probably running as a docker service. Trying to read the config profile from: ', MOUNTED_AWS_CONFIG);
        try {
            configFile = MOUNTED_AWS_CONFIG;
            let stats = fs.statSync(configFile);
            if (stats.isDirectory()) {
                let error = new Error(configFile + ' is a directory but not a file.');
                error.statusCode = 404;
                throw error;
            } else if (!stats.isFile()) {
                let error = new Error(configFile + ' not exists');
                error.statusCode = 404;
                throw error;
            } else {
                return configFile;
            }
        } catch (e) {
            // `e`, not `err`: this catch is the *mounted* path failing, and logging
            // the outer `err` reported the home-directory miss twice while the
            // reason the fallback failed was never printed at all.
            log.warn('no AWS config found at ', AWS_HOME_CONFIG, ' (', err.message,
                ') nor at ', MOUNTED_AWS_CONFIG, ' (', e.message, ') — no profiles will be imported');
            return null;
        }
    }
}

function readAwsCredentials() {
    let credentialsFile = AWS_HOME_CREDENTIALS;
    try {
        credentialsFile = credentialsFile.replace('~', os.homedir);
        credentialsFile = path.resolve(credentialsFile);
        let stats = fs.statSync(credentialsFile);
        if (stats.isDirectory()) {
            let error = new Error(credentialsFile + ' is a directory but not a file.');
            error.statusCode = 404;
            throw error;
        } else if (!stats.isFile()) {
            let error = new Error(credentialsFile + ' not exists');
            error.statusCode = 404;
            throw error;
        } else {
            log.debug(credentialsFile, ' is available.');
            return credentialsFile;
        }
    } catch (err) {
        log.debug('Error in finding the credentials in the home: ', credentialsFile, ' : ', err.message);
        log.debug(credentialsFile, ' does not seem to exist. Probably running as a docker service. Trying to read the credentials from: ', MOUNTED_AWS_CREDENTIALS);
        try {
            credentialsFile = MOUNTED_AWS_CREDENTIALS;
            let stats = fs.statSync(credentialsFile);
            if (stats.isDirectory()) {
                let error = new Error(credentialsFile + ' is a directory but not a file.');
                error.statusCode = 404;
                throw error;
            } else if (!stats.isFile()) {
                let error = new Error(credentialsFile + ' not exists');
                error.statusCode = 404;
                throw error;
            } else {
                return credentialsFile;
            }
        } catch (e) {
            // Same as readAwsConfig above: report the failure that actually
            // happened here, not the outer one.
            log.warn('no AWS credentials found at ', AWS_HOME_CREDENTIALS, ' (', err.message,
                ') nor at ', MOUNTED_AWS_CREDENTIALS, ' (', e.message, ')');
            return null;
        }
    }
}

function createEachProfileObjectFromFile(configProps, profileName) {
    log.debug('reading the profile: ', profileName , ' ...');

    let keyName;
    let supportedAuthnMechanisms = [];
    if (isSsoProfile(configProps, profileName)) {
        supportedAuthnMechanisms.push('sso_user')
        keyName = profileName + '.sso_start_url';
        let awsSsoStartUrl = configProps.get(keyName) || configProps.get('profile ' + keyName);
        keyName = profileName + '.sso_region';
        let ssoRegion = configProps.get(keyName) || configProps.get('profile ' + keyName);
        if (!ssoRegion || ssoRegion.length == 0) {
            ssoRegion = 'us-east-1';
        }
        keyName = profileName + '.sso_account_id';
        let awsSsoAccountId = configProps.get(keyName) || configProps.get('profile ' + keyName);
        keyName = profileName + '.sso_role_name';
        let awsSsoRoleName = configProps.get(keyName) || configProps.get('profile ' + keyName);
        keyName = profileName + '.region';
        let region = configProps.get(keyName) || configProps.get('profile ' + keyName) || ssoRegion;
        let oidcHostname = 'oidc.' + ssoRegion + '.amazonaws.com';
        let oidcRegisterClientPath = '/client/register';
        let oidcDeviceAuthorizationPath = '/device_authorization';
        let oidcAccessTokenPath = '/token';
        let roleCredentialsHostname = 'portal.sso.' + ssoRegion + '.amazonaws.com';
        let roleCredentialsPath = '/federation/credentials?account_id=' + awsSsoAccountId + '&role_name=' + awsSsoRoleName;

        return {
            'profileName': profileName,
            'awsSsoUserEnabled': true,
            'supportedAuthnMechanisms': supportedAuthnMechanisms,
            'region': region,
            'ssoRegion': ssoRegion,
            'awsSsoStartUrl': awsSsoStartUrl,
            'awsSsoAccountId': awsSsoAccountId,
            'awsSsoRoleName': awsSsoRoleName,
            'oidcHostname': oidcHostname,
            'oidcRegisterClientPath': oidcRegisterClientPath,
            'oidcDeviceAuthorizationPath': oidcDeviceAuthorizationPath,
            'oidcAccessTokenPath': oidcAccessTokenPath,
            'roleCredentialsHostname': roleCredentialsHostname,
            'roleCredentialsPath': roleCredentialsPath,
        };
    } else {
        supportedAuthnMechanisms.push('iam_user')
        keyName = profileName + '.region';
        let region = configProps.get(keyName) || configProps.get('profile ' + keyName);
        let credProps = propertiesReader(readAwsCredentials());
        keyName = profileName + '.aws_access_key_id';
        let awsAccessKeyId = credProps.get(keyName) || credProps.get('profile ' + keyName);
        keyName = profileName + '.aws_secret_access_key';
        let awsSecretAccessKey = credProps.get(keyName) || credProps.get('profile ' + keyName);
        return {
            'profileName': profileName,
            'awsIamUserEnabled': true,
            'supportedAuthnMechanisms': supportedAuthnMechanisms,
            'region': region,
            'awsAccessKeyId': awsAccessKeyId,
            'awsSecretAccessKey': awsSecretAccessKey
        };
    }

}

function isSsoProfile(configProps, profileName) {
    let keyName = profileName + '.sso_start_url';
    let awsSsoStartUrl = configProps.get(keyName) || configProps.get('profile ' + keyName);
    if (awsSsoStartUrl) {
        return true;
    } else {
        return false;
    }
}


function getProfileFilePath(profileName, loginUserName) {
    let effectiveUser = resolveEffectiveUser(loginUserName);
    if (!effectiveUser) {
        return null;
    }
    return path.join(
        paths.getUserDir(effectiveUser), profilesDirName, profileName, profileName + '.json'
    );
}

// Read an already-created profile's JSON, or null if it can't be read. Used to
// decide whether the user has already made an explicit "Sync to AWS Config"
// choice (key present) vs. a legacy profile that predates the flag (key absent).
function readExistingProfile(profileName, loginUserName) {
    try {
        let profileFile = getProfileFilePath(profileName, loginUserName);
        if (!profileFile || !fs.existsSync(profileFile)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(profileFile, 'utf-8'));
    } catch (e) {
        return null;
    }
}

function isProfileAlreadyCreated(profileName, loginUserName) {
    try {
        let profileFile = getProfileFilePath(profileName, loginUserName);
        if (!profileFile) {
            return false;
        }
        let stats = fs.statSync(profileFile);
        if (stats.isDirectory()) {
            let error = new Error(profileFile + ' is a directory but not a file.');
            log.warn(error)
            return false;
        } else if (!stats.isFile()) {
            let error = new Error(profileFile + ' is not a file.');
            log.warn(error)
            return false;
        } else {
            log.debug('profile: ', profileName, ' already created.');
            return true;
        }
    } catch (e) {
        log.error(e.message);
        return false;
    }
}

function createProfilePayload(profileObjectFromList, parsedProfileName, loginUserName) {
    let profile = {};
    profile.profileName = parsedProfileName;
    profile.region = profileObjectFromList['region'];
    profile.userName = resolveEffectiveUser(loginUserName);
    profile.supportedAuthnMechanisms = profileObjectFromList['supportedAuthnMechanisms'];
    // Profiles discovered in ~/.aws/config are, by definition, already in sync
    // with the AWS config, so "Sync to AWS Config" is enabled by default for
    // them. For profiles that already exist in our artifacts this default is
    // dropped before updateProfile (see loadHomeProfiles) so a user who turned
    // sync OFF is not overridden on the next reload.
    profile.syncToAwsConfig = true;
    if (profile.supportedAuthnMechanisms.includes('sso_user')) {
        profile.ssoRegion = profileObjectFromList['ssoRegion'];
        profile.awsSsoStartUrl = profileObjectFromList['awsSsoStartUrl'];
        profile.awsSsoAccountId = profileObjectFromList['awsSsoAccountId'];
        profile.awsSsoRoleName = profileObjectFromList['awsSsoRoleName'];
        profile.awsSsoUserEnabled = profileObjectFromList['awsSsoUserEnabled'];
        profile.oidcHostname = profileObjectFromList['oidcHostname'];
        profile.oidcRegisterClientPath = profileObjectFromList['oidcRegisterClientPath'];
        profile.oidcDeviceAuthorizationPath = profileObjectFromList['oidcDeviceAuthorizationPath'];
        profile.oidcAccessTokenPath = profileObjectFromList['oidcAccessTokenPath'];
        profile.roleCredentialsHostname = profileObjectFromList['roleCredentialsHostname'];
        profile.roleCredentialsPath = profileObjectFromList['roleCredentialsPath'];
    }
    if (profile.supportedAuthnMechanisms.includes('iam_user')) {
        profile.awsAccessKeyId = profileObjectFromList['awsAccessKeyId'];
        profile.awsSecretAccessKey = profileObjectFromList['awsSecretAccessKey'];
        profile.awsIamUserEnabled = profileObjectFromList['awsIamUserEnabled'];
    }
    return profile;
}

function getProfileUtils() {
    if (!profileUtils) {
        profileUtils = require('./profileUtils');
    }
    return profileUtils;
}

function loadHomeProfiles(callback, loginUserName) {
    try {
        let effectiveUser = resolveEffectiveUser(loginUserName);
        if (!effectiveUser) {
            return callback(new Error('user login not provided for AWS profile sync'));
        }
        let awsConfigFile = readAwsConfig();
        if (awsConfigFile) {
            let awsConfigContent = readFileContent(awsConfigFile);
            let profilesArray = [];
            for (let eachIndex in awsConfigContent) {
                let eachLine = awsConfigContent[eachIndex];
                if (eachLine === ';' || eachLine === '#' || eachLine === '\n' || eachLine.trim() === '') {
                    continue;
                } else if (eachLine.startsWith('[') && eachLine.endsWith(']')) {
                    let name = eachLine.substring(1, eachLine.length -1);
                    if (name.startsWith('profile ')) {
                        name = name.substring(8);
                    }
                    profilesArray.push(name)
                } else {
                    continue;
                }
            }
            log.debug('List of profiles available in AWS config: ', profilesArray);
            if (profilesArray.length === 0) {
                let msg = awsConfigFile +  ' does not have any profiles defined in it. Nothing to load !';
                log.debug(msg)
                return callback(null);
            } else {
                let configProps = propertiesReader(awsConfigFile);
                let listOfProfiles = {};
                for (let eachProfileIndex in profilesArray) {
                    let eachProfileName = profilesArray[eachProfileIndex];
                    let eachProfileObject = createEachProfileObjectFromFile(configProps, eachProfileName);
                    listOfProfiles[eachProfileName] = eachProfileObject;
                }
                let parsedProfileNamesLength = profilesArray.length;
                for (let parsedProfileNameIndex in profilesArray) {
                    let parsedProfileName = profilesArray[parsedProfileNameIndex];
                    let profileObjectFromList = listOfProfiles[parsedProfileName];
                    let eachProfilePayload = createProfilePayload(profileObjectFromList, parsedProfileName, effectiveUser);
                    let isExists = isProfileAlreadyCreated(parsedProfileName, effectiveUser);
                    log.debug('isProfileAlreadyCreated: ', parsedProfileName, ' ? ', isExists);
                    if (isExists) {
                        // Preserve a user's explicit sync choice on reload, but
                        // backfill the default for profiles that predate the flag.
                        // updateProfile merges the payload onto the stored
                        // profile: if the stored profile already has the key, the
                        // user chose it — omit it so we don't clobber. If the key
                        // is absent (legacy profile), keep the default true so
                        // profiles loaded from ~/.aws/config get sync enabled.
                        let existing = readExistingProfile(parsedProfileName, effectiveUser);
                        if (existing && Object.prototype.hasOwnProperty.call(existing, 'syncToAwsConfig')) {
                            delete eachProfilePayload.syncToAwsConfig;
                        }
                        getProfileUtils().updateProfile(eachProfilePayload, (err, profileOutputObj) => {
                            if(err) {
                                log.error('Error in updating profile : ', err.message);
                                if (parsedProfileNameIndex == parsedProfileNamesLength -1) {
                                    callback(err);
                                }
                            } else {
                                log.debug('profile ', parsedProfileName , ' updated successfully ...');
                                if (parsedProfileNameIndex == parsedProfileNamesLength -1) {
                                    callback(null);
                                }
                            }
                        });
                    } else {
                        getProfileUtils().createProfile(eachProfilePayload, (err, profileOutputObj) => {
                            if(err) {
                                log.error('Error in creating profile : ', err.message);
                                if (parsedProfileNameIndex == parsedProfileNamesLength -1) {
                                    callback(err);
                                }
                            } else {
                                log.debug('profile ', parsedProfileName , ' created successfully ...');
                                if (parsedProfileNameIndex == parsedProfileNamesLength -1) {
                                    callback(null);
                                }
                            }
                        });
                    }
                };
            }
        } else {
            let msg = 'profile does not exist! Not loading the profile ...';
            log.debug(msg);
            return callback(null);
        }

    } catch (e) {
        callback(e.message);
    }
}


module.exports = {
    loadHomeProfiles: loadHomeProfiles
};

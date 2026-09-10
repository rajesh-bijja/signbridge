/* global __dirname */

/**
 * coreUtils.js
 *
 * Part of SignBridge. Licensed under the MIT License.
 * Created on 07/20/23.
 */
"use strict";

let fs = require('fs');
let path = require('path');
let jsonfile = require('jsonfile');
jsonfile.spaces = 2;
const { randomUUID: uuidv4 } = require('crypto');
let propertiesReader = require('properties-reader');
const recursive = require("recursive-readdir");
let propsFileName = 'config.properties';
let props = propertiesReader(__dirname + '/../' + propsFileName);
let authConfig = require('./authConfig');
let appConfig = require('./appConfig');
let redact = require('./redact');
let paths = require('./paths');
let pathSafety = require('./pathSafety');
let log = require('./logger').create('coreUtils');
let profilesDirName = props.get('server.profilesDirName') || 'profiles';
let publicClientCredsFileName = props.get('server.publicClientCredsFileName') || 'public_client_creds.json';
let historyDirName = props.get('server.historyDirName') || 'history';
let favoritesDirName = props.get('server.favoritesDirName') || 'favorites';
let collectionsDirName = props.get('server.collectionsDirName') || 'collections';
let settingsDirName = props.get('server.settingsDirName') || 'settings';
let settingsFileName = props.get('server.settingsFileName') || 'settings.json';
let scriptsDirName = props.get('server.scriptsDirName') || 'scripts';
let clientsCount = 0;
const PROFILE_EXT = '.json';

const HISTORY_METADATA_JSON_FILE = 'metadata.json';
const FAVORITE_METADATA_JSON_FILE = 'metadata.json';
const COLLECTIONS_METADATA_JSON_FILE = 'metadata.json';
const UTF8 = 'utf8';

let constants = {
    NAME: 'name',
    EXECUTION_DETAILS_FILE_NAME: 'executionDetailsFileName',
    HISTORY: 'history',
    HISTORY_ID: 'historyId',
    FAVORITE_ID: 'favoriteId',
    COLLECTION_NAME: 'collectionName',
    COLLECTION_PAYLOAD: 'collectionPayload',
    IMPORTED_COLLECTION_NAME: 'importedCollectionName',
    PROJECT_NAME: appConfig.getProjectName(),
    REQUESTLABEL: 'requestLabel',
    'USERNAME': 'userName'
};

let serverSideUserNameToHistoryMap = {};
let usersConnectedToSignBridge = {};
// userName -> Set of socket ids, so the server can push chat streaming events to
// every live socket belonging to a given user.
let userNameToSocketIds = {};
// socket id -> socket, for looking up socket objects when emitting.
let socketsById = {};
let origSocket;

// Emit an event to all live sockets of a given user. Used by the chat agent to
// stream tokens / tool-call status. Safe no-op if the user has no socket.
function emitToUser(userName, eventName, payload) {
    let ids = userNameToSocketIds[userName];
    if (!ids) {
        return;
    }
    for (let id of ids) {
        let s = socketsById[id];
        if (s) {
            try {
                s.emit(eventName, payload);
            } catch (e) {
                log.error('emitToUser failed for socket ', id, ': ', e.message);
            }
        }
    }
}

function socketEventMgmt(socket) {
    log.debug('new user connected : ', socket.handshake.headers['user-agent']);
    origSocket = socket;
    socketsById[socket.id] = socket;
    let iamSignBridgeUserEvent = 'event_i_am_' + constants.PROJECT_NAME + '_user';
    socket.on(iamSignBridgeUserEvent, function(data) {
        clientsCount++;
        log.debug('server received ', iamSignBridgeUserEvent, ' msg from : ', data, ' at: [', new Date().toString(), '] from the browser/device: ', socket.handshake.headers['user-agent']);
        let userName = data.userName;
        usersConnectedToSignBridge[socket.id] = userName;
        if (!userNameToSocketIds[userName]) {
            userNameToSocketIds[userName] = new Set();
        }
        userNameToSocketIds[userName].add(socket.id);
        log.debug('\n############## Total user(s) connected to SignBridge: ', usersConnectedToSignBridge, '\n');
        searchOrCreateBasicHistoryArtifacts(userName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
            if(err) {
                log.debug('history details not yet available for the user: ' + userName +  + ' err: ' + err.message);
                return;
            }
            serverSideUserNameToHistoryMap[userName] = historyMetadataOutputObj;
            let historyObj = historyMetadataOutputObj;
            if (!historyObj || historyObj.length === 0) {
                log.debug('history not available for the user : ' + userName + ' . Can not emit update event.');
            } else {
                let updateUserHistoryEvent = 'event_update_' + userName + '_userhistory_map';
                let data = {};
                data[constants.HISTORY] = historyObj;
                socket.emit(updateUserHistoryEvent, data);
            }
        });
    });

    socket.on('event_get_history_id_log', function(data) {
        log.debug('server received event_get_history_id_log msg : ', data);
        let historyId = data.historyId;
        let userName = data.userName;
        let displayJobProgressEvent = 'event_display_request_details_' + userName;
        getHistoryDetailsById(userName, historyId, (err, result) => {
            if (err) {
                log.error('error in finding request details by id for [: ', historyId, '] error is: ',  err);
                socket.emit(displayJobProgressEvent, {
                    data: 'Error in finding the details for the request',
                    historyId: historyId,
                    userName: userName,
                    status: 'Unknown'
                });
            } else {
                try {
                    let status;
                    if (result.response.responseStatusCode >= 400) {
                        status = 'Failed';
                    } else {
                        status = 'Complete';
                    }
                    socket.emit(displayJobProgressEvent, {
                        data: result,
                        historyId: historyId,
                        userName: userName,
                        status: status
                    });
                } catch (err) {
                    log.error('error in emitting the data : ', err);
                }
            }
        });
    });


    socket.on('event_get_favorite_id_log', function(data) {
        log.debug('server received event_get_favorite_id_log msg : ', data);
        let favoriteId = data.favoriteId;
        let userName = data.userName;
        let displayJobProgressEvent = 'event_display_favorite_details_' + userName;
        getFavoriteDetailsById(userName, favoriteId, (err, result) => {
            if (err) {
                log.error('error in finding request details by id for [: ', favoriteId, '] error is: ',  err);
                socket.emit(displayJobProgressEvent, {
                    data: 'Error in finding the details for the favorite',
                    favoriteId: favoriteId,
                    userName: userName,
                    status: 'Unknown'
                });
            } else {
                try {
                    let status;
                    if (result.response.responseStatusCode >= 400) {
                        status = 'Failed';
                    } else {
                        status = 'Complete';
                    }
                    socket.emit(displayJobProgressEvent, {
                        data: result,
                        favoriteId: favoriteId,
                        userName: userName,
                        status: status
                    });
                } catch (err) {
                    log.error('error in emitting the favorite data : ', err);
                }
            }
        });
    });

    socket.on('event_get_collection_id_log', function(data) {
        log.debug('server received event_get_collection_id_log msg : ', data);
        let collectionId = data.collectionId;
        let userName = data.userName;
        let displayJobProgressEvent = 'event_display_collection_details_' + userName;
        getCollectionDetailsById(userName, collectionId, (err, result) => {
            if (err) {
                log.error('error in finding collection details by id for [', collectionId, '] error is: ',  err);
                socket.emit(displayJobProgressEvent, {
                    data: 'Error in finding the details for the collection: ' + err.message,
                    collectionId: collectionId,
                    userName: userName,
                    status: 'error'
                });
            } else {
                try {
                    socket.emit(displayJobProgressEvent, {
                        data: result,
                        collectionId: collectionId,
                        userName: userName,
                        status: 'success'
                    });
                } catch (err) {
                    log.error('error in emitting the data : ', err);
                }
            }
        });
    });

    socket.on('disconnect', function(){
        let userName = usersConnectedToSignBridge[socket.id];
        clientsCount--;
        log.debug('user ', (!userName ? '' : userName), ' refreshed/closed browser session: [ ', socket.handshake.headers['user-agent'], ' ]');
        delete usersConnectedToSignBridge[socket.id];
        delete socketsById[socket.id];
        if (userName && userNameToSocketIds[userName]) {
            userNameToSocketIds[userName].delete(socket.id);
            if (userNameToSocketIds[userName].size === 0) {
                delete userNameToSocketIds[userName];
            }
        }
        log.debug('\n############## Total user(s) connected to SignBridge: ', usersConnectedToSignBridge, '\n');
    });
}

function createHistoryDetailsForTheGivenRequest(executionDetailsAbsoluteFileName, completeRequestData, responseStatusCode, responseHeaders, responseData, cb) {
    let completeObject = {};
    let request = {};
    let response = {};
    request.endpoint = completeRequestData.endpoint;
    request.method = completeRequestData.method;
    request.profileName = completeRequestData.profileName;
    request.authnMode = completeRequestData.authnMode;
    if (completeRequestData.headers) {
        request.headers = completeRequestData.headers;
    }
    if (completeRequestData.invocationMode) {
        request.invocationMode = completeRequestData.invocationMode;
        request.commandPayload = completeRequestData.commandPayload;
    }
    request.isUrlPresigningRequest = completeRequestData.isUrlPresigningRequest || false;
    if (completeRequestData.body) {
        try {
            request.body = JSON.parse(completeRequestData.body);
        } catch (error1) {
            log.debug('error in parsing the body, retaining the original body provided.');
            request.body = completeRequestData.body;
        }
    }
    completeObject.request = request;
    response.responseStatusCode = responseStatusCode;
    response.responseHeaders = responseHeaders;
    response.responseData = responseData;
    completeObject.response = response;
    jsonfile.writeFile(executionDetailsAbsoluteFileName, completeObject, function (err) {
        if(err) {
            return cb(err);
        } else {
            log.debug('execution file created successfully ...');
            cb(null);
        }
    });
}

function extractDetailsFromRequestById(req, cb) {
    if(!req.body) {
        return cb(new Error('extractDetailsFromRequestById: request body not available'));
    } else {
        if(!req.body.profile) {
            return cb(new Error('profile object not provided in request payload'));
        }
        log.debug('payload : ', redact.forLog(req.body.profile));
        let profileInputObj = req.body.profile;
        if(!profileInputObj[constants.USERNAME]) {
            return cb(new Error(constants.USERNAME + ' not provided in request payload.'));
        }
        if(!profileInputObj[constants.HISTORY_ID]) {
            return cb(new Error(constants.HISTORY_ID + ' not provided in request payload'));
        }
        return cb(null, profileInputObj);
    }
}

function extractFavoriteDetailsFromRequestById(req, cb) {
    if(!req.body) {
        return cb(new Error('extractDetailsFromRequestById: request body not available'));
    } else {
        if(!req.body.profile) {
            return cb(new Error('profile object not provided in request payload'));
        }
        log.debug('payload : ', redact.forLog(req.body.profile));
        let profileInputObj = req.body.profile;
        if(!profileInputObj[constants.USERNAME]) {
            return cb(new Error(constants.USERNAME + ' not provided in request payload'));
        }
        if(!profileInputObj[constants.FAVORITE_ID]) {
            return cb(new Error(constants.FAVORITE_ID + ' not provided in request payload'));
        }
        return cb(null, profileInputObj);
    }
}

function extractCollectionDetailsFromRequest(req, cb) {
    if(!req.body) {
        return cb(new Error('request body not available in payload'));
    } else {
        log.debug('payload : ', redact.forLog(req.body));
        let inputPayload = req.body;
        if(!inputPayload[constants.USERNAME]) {
            return cb(new Error(constants.USERNAME + ' not provided in request payload'));
        }
        if(!inputPayload[constants.COLLECTION_NAME]) {
            return cb(new Error(constants.COLLECTION_NAME + ' not provided in request payload'));
        }
        if(!inputPayload[constants.COLLECTION_PAYLOAD]) {
            return cb(new Error(constants.COLLECTION_PAYLOAD + ' not provided in request payload'));
        }
        return cb(null, inputPayload);
    }
}

function deleteHistoryFileById(profileInputObj, cb) {
    let historyIdSegmentErr = pathSafety.assertSafeSegment(profileInputObj[constants.HISTORY_ID], constants.HISTORY_ID);
    if (historyIdSegmentErr) {
        return cb(historyIdSegmentErr);
    }
    let fileName = profileInputObj[constants.HISTORY_ID] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    searchOrCreateBasicHistoryArtifacts(loginUserName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
        if (err) {
            log.debug('history details not yet available for the user: ' + loginUserName + +' err: ' + err.message);
            err.statusCode = 400;
            return cb(err);
        } else {
            let historyIdFile = path.resolve(historyAbsoluteDir + "/" + fileName);
            log.debug('historyIdFile in delete: ', historyIdFile);
            fs.stat(historyIdFile, function (err, stats) {
                if (err) {
                    err.statusCode = 404;
                    return cb(err);
                }
                fs.unlink(historyIdFile,function(unlinkerr){
                    if(unlinkerr) {
                        unlinkerr.statusCode = 404;
                        return cb(unlinkerr);
                    } else {
                        log.debug('history file : ', historyIdFile, ' deleted successfully');
                        for (let i = 0; i < historyMetadataOutputObj.length; i++) {
                            let eachHistoryEntryMetadata = historyMetadataOutputObj[i];
                            if (eachHistoryEntryMetadata && eachHistoryEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME]
                                && eachHistoryEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME].toLowerCase() === fileName.toLowerCase()) {
                                historyMetadataOutputObj.splice(i, 1);
                            }
                        }
                        updateHistoryMetadata(loginUserName, historyMetadataOutputObj, historyMetadataFile, (err) => {
                            if (err) {
                                cb(err);
                            } else {
                                cb(null);
                            }
                        })

                    }
                });
            });
        }
    });
}


function deleteFavoriteFileById(profileInputObj, cb) {
    let favoriteIdSegmentErr = pathSafety.assertSafeSegment(profileInputObj[constants.FAVORITE_ID], constants.FAVORITE_ID);
    if (favoriteIdSegmentErr) {
        return cb(favoriteIdSegmentErr);
    }
    let fileName = profileInputObj[constants.FAVORITE_ID] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    searchOrCreateBasicFavoriteArtifacts(loginUserName, (err, favoritesMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile) => {
        if (err) {
            log.debug('favorites details not yet available for the user: ' + loginUserName + +' err: ' + err.message);
            err.statusCode = 400;
            return cb(err);
        } else {
            let favoriteIdFile = path.resolve(favoritesAbsoluteDir + "/" + fileName);
            log.debug('favoriteIdFile in delete: ', favoriteIdFile);
            fs.stat(favoriteIdFile, function (err, stats) {
                if (err) {
                    err.statusCode = 404;
                    return cb(err);
                }
                fs.unlink(favoriteIdFile,function(unlinkerr){
                    if(unlinkerr) {
                        unlinkerr.statusCode = 404;
                        return cb(unlinkerr);
                    } else {
                        log.debug('favorite file : ', favoriteIdFile, ' deleted successfully');
                        for (let i = 0; i < favoritesMetadataOutputObj.length; i++) {
                            let eachFavoriteEntryMetadata = favoritesMetadataOutputObj[i];
                            if (eachFavoriteEntryMetadata && eachFavoriteEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME]
                                && eachFavoriteEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME].toLowerCase() === fileName.toLowerCase()) {
                                favoritesMetadataOutputObj.splice(i, 1);
                                break;
                            }
                        }
                        updateFavoritesMetadata(loginUserName, favoritesMetadataOutputObj, favoritesMetadataFile, (err) => {
                            if (err) {
                                cb(err);
                            } else {
                                cb(null);
                            }
                        })

                    }
                });
            });
        }
    });
}


function addToFavoritesAndUpdateMetadata(historyId, historyFromMetadata, historyAbsoluteDir, loginUserName, cb) {
    let historyIdSegmentErr = pathSafety.assertSafeSegment(historyId, 'historyId');
    if (historyIdSegmentErr) {
        return cb(historyIdSegmentErr);
    }
    let fileName = historyId + PROFILE_EXT;
    let favoriteId = historyId;
    searchOrCreateBasicFavoriteArtifacts(loginUserName, (err, favoritesMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile) => {
        if (err) {
            log.debug('favorites details not yet available for the user: ' + loginUserName + +' err: ' + err.message);
            err.statusCode = 400;
            return cb(err);
        } else {
            let favoriteIdFile = path.resolve(favoritesAbsoluteDir + "/" + fileName);
            let historyIdFile = path.resolve(historyAbsoluteDir + "/" + fileName);
            let searchByFavoriteIdOutput = favoritesMetadataOutputObj.filter((eachFavoriteMetadata) => {
                let eachRequestFavoriteFileName = eachFavoriteMetadata[constants.EXECUTION_DETAILS_FILE_NAME];
                return (favoriteId + '.json') === eachRequestFavoriteFileName;
            });
            if (searchByFavoriteIdOutput.length == 1) {
                log.debug('historyId: ', historyId, ' is already added to the favorites metadata.');
                fs.copyFileSync(historyIdFile, favoriteIdFile);
                cb(null);
            } else {
                favoritesMetadataOutputObj.push(historyFromMetadata);
                updateFavoritesMetadata(loginUserName, favoritesMetadataOutputObj, favoritesMetadataFile, (err) => {
                    if (err) {
                        cb(err);
                    } else {
                        fs.copyFileSync(historyIdFile, favoriteIdFile);
                        cb(null);
                    }
                });
            }
        }
    });
}

function updateRequestWithLabel(profileInputObj, cb) {
    let fileName = profileInputObj[constants.HISTORY_ID] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    searchOrCreateBasicHistoryArtifacts(loginUserName, (err, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile) => {
        if (err) {
            log.debug('history details not yet available for the user: ' + loginUserName + +' err: ' + err.message);
            err.statusCode = 400;
            return cb(err);
        } else {
            let labelUpdated = false;
            for (let i = 0; i < historyMetadataOutputObj.length; i++) {
                let eachHistoryEntryMetadata = historyMetadataOutputObj[i];
                if (eachHistoryEntryMetadata && eachHistoryEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME]
                    && eachHistoryEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME].toLowerCase() === fileName.toLowerCase()) {
                    eachHistoryEntryMetadata[constants.REQUESTLABEL] = profileInputObj[constants.REQUESTLABEL];
                    historyMetadataOutputObj[i][constants.REQUESTLABEL] = profileInputObj[constants.REQUESTLABEL];
                    labelUpdated = true;
                }
            }
            if (labelUpdated) {
                updateHistoryMetadata(loginUserName, historyMetadataOutputObj, historyMetadataFile, (err) => {
                    if (err) {
                        cb(err);
                    } else {
                        cb(null);
                    }
                })
            } else {
                cb(null);
            }
        }
    });
}


function updateFavoriteRequestWithLabel(profileInputObj, cb) {
    let fileName = profileInputObj[constants.FAVORITE_ID] + PROFILE_EXT;
    let loginUserName = profileInputObj[constants.USERNAME];
    searchOrCreateBasicFavoriteArtifacts(loginUserName, (err, favoritesMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile) => {
        if (err) {
            log.debug('favorite details not yet available for the user: ' + loginUserName + +' err: ' + err.message);
            err.statusCode = 400;
            return cb(err);
        } else {
            let labelUpdated = false;
            for (let i = 0; i < favoritesMetadataOutputObj.length; i++) {
                let eachFavoriteEntryMetadata = favoritesMetadataOutputObj[i];
                if (eachFavoriteEntryMetadata && eachFavoriteEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME]
                    && eachFavoriteEntryMetadata[constants.EXECUTION_DETAILS_FILE_NAME].toLowerCase() === fileName.toLowerCase()) {
                    eachFavoriteEntryMetadata[constants.REQUESTLABEL] = profileInputObj[constants.REQUESTLABEL];
                    favoritesMetadataOutputObj[i][constants.REQUESTLABEL] = profileInputObj[constants.REQUESTLABEL];
                    labelUpdated = true;
                }
            }
            if (labelUpdated) {
                updateFavoritesMetadata(loginUserName, favoritesMetadataOutputObj, favoritesMetadataFile, (err) => {
                    if (err) {
                        cb(err);
                    } else {
                        cb(null);
                    }
                })
            } else {
                cb(null);
            }
        }
    });
}

function deleteHistoryDetailsForTheGivenRequest(req, res) {
    try {
        extractDetailsFromRequestById(req, (err, profileInputObj) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                log.debug('deleteHistoryDetailsForTheGivenRequest: after processing input: ', redact.forLog(profileInputObj));
                deleteHistoryFileById(profileInputObj, (err, profileOutputObj) => {
                    if(err) {
                        let statusCode = 400;
                        if (err.statusCode) {
                            statusCode = err.statusCode;
                        }
                        log.error('Error in deleting history file by id:', profileInputObj[constants.HISTORY_ID], ' Please try later : ', err);
                        res.status(statusCode).json({'message': err.message});
                    } else {
                        res.status(204).end();
                    }
                });
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in deleteHistoryDetailsForTheGivenRequest: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}


// Return the full stored request+response for a single history entry, so callers
// (the chat agent, MCP clients) can faithfully re-invoke it. list_history only
// returns summary metadata (method/profile/authnMode/status) WITHOUT the actual
// endpoint/headers/body — those live only in the per-id detail file read here.
function getHistoryDetailsForTheGivenRequest(req, res) {
    try {
        extractDetailsFromRequestById(req, (err, profileInputObj) => {
            if (err) {
                return res.status(400).json({ 'message': err.message });
            }
            let loginUserName = profileInputObj[constants.USERNAME];
            // Accept either the raw historyId or the executionDetailsFileName (may end in .json).
            let historyId = String(profileInputObj[constants.HISTORY_ID]).replace(/\.json$/i, '');
            getHistoryDetailsById(loginUserName, historyId, (readErr, responseObj) => {
                if (readErr) {
                    let statusCode = readErr.code === 'ENOENT' ? 404 : 400;
                    return res.status(statusCode).json({ 'message': 'History details not found for id: ' + historyId });
                }
                res.status(200).json(responseObj);
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in getHistoryDetailsForTheGivenRequest: ', catchErr);
        res.status(400).json({ 'message': catchErr.message });
    }
}

// Same as above but for a saved favorite entry.
function getFavoriteDetailsForTheGivenRequest(req, res) {
    try {
        extractFavoriteDetailsFromRequestById(req, (err, profileInputObj) => {
            if (err) {
                return res.status(400).json({ 'message': err.message });
            }
            let loginUserName = profileInputObj[constants.USERNAME];
            let favoriteId = String(profileInputObj[constants.FAVORITE_ID]).replace(/\.json$/i, '');
            getFavoriteDetailsById(loginUserName, favoriteId, (readErr, responseObj) => {
                if (readErr) {
                    let statusCode = readErr.code === 'ENOENT' ? 404 : 400;
                    return res.status(statusCode).json({ 'message': 'Favorite details not found for id: ' + favoriteId });
                }
                res.status(200).json(responseObj);
            });
        });
    } catch (catchErr) {
        log.error('caught unexpected error in getFavoriteDetailsForTheGivenRequest: ', catchErr);
        res.status(400).json({ 'message': catchErr.message });
    }
}


function deleteFavoriteDetailsForTheGivenRequest(req, res) {
    try {
        extractFavoriteDetailsFromRequestById(req, (err, profileInputObj) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                log.debug('deleteFavoriteDetailsForTheGivenRequest: after processing input: ', redact.forLog(profileInputObj));
                deleteFavoriteFileById(profileInputObj, (err) => {
                    if(err) {
                        let statusCode = 400;
                        if (err.statusCode) {
                            statusCode = err.statusCode;
                        }
                        log.error('Error in deleting favorite file by id:', profileInputObj[constants.FAVORITE_ID], ' Please try later : ', err);
                        res.status(statusCode).json({'message': err.message});
                    } else {
                        res.status(204).end();
                    }
                });
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in deleteHistoryDetailsForTheGivenRequest: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function applyLabelForTheGivenRequest(req, res) {
    try {
        extractDetailsFromRequestById(req, (err, profileInputObj) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                if (!profileInputObj[constants.REQUESTLABEL]) {
                    let errMessage = constants.REQUESTLABEL + ' is not specified in the request payload';
                    res.status(400).json({'message': errMessage});
                } else {
                    updateRequestWithLabel(profileInputObj, (err) => {
                        if(err) {
                            let statusCode = 400;
                            if (err.statusCode) {
                                statusCode = err.statusCode;
                            }
                            log.error('Error in applying the label to the history file by id:', profileInputObj[constants.HISTORY_ID], ' Please try later : ', err);
                            res.status(statusCode).json({'message': err.message});
                        } else {
                            res.status(201).json({'message': 'successfully updated'});
                        }
                    });
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in applyLabelForTheGivenRequest: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

function applyLabelForTheGivenFavoriteRequest(req, res) {
    try {
        extractFavoriteDetailsFromRequestById(req, (err, profileInputObj) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                if (!profileInputObj[constants.REQUESTLABEL]) {
                    let errMessage = constants.REQUESTLABEL + ' is not specified in the request payload';
                    res.status(400).json({'message': errMessage});
                } else {
                    updateFavoriteRequestWithLabel(profileInputObj, (err) => {
                        if(err) {
                            let statusCode = 400;
                            if (err.statusCode) {
                                statusCode = err.statusCode;
                            }
                            log.error('Error in applying the label to the favorite file by id:', profileInputObj[constants.FAVORITE_ID], ' Please try later : ', err);
                            res.status(statusCode).json({'message': err.message});
                        } else {
                            res.status(201).json({'message': 'successfully updated'});
                        }
                    });
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in applyLabelForTheGivenRequest: ', catchErr);
        res.status(400).json({'message': catchErr});
    }
}

// Core import routine, shared by the HTTP route and the on-demand AWS catalog.
// `collectionPayload` may be a Postman collection object OR a JSON string; both
// are normalized to a pretty-printed JSON string before being written to disk.
function importCollectionForUser(userName, collectionName, collectionPayload, cb) {
    let collectionObj;
    try {
        // Accept both an already-parsed object (JSON body) and a raw JSON string.
        collectionObj = (typeof collectionPayload === 'string')
            ? JSON.parse(collectionPayload)
            : collectionPayload;
    } catch (parseErr) {
        return cb(new Error('collectionPayload is not valid JSON: ' + parseErr.message));
    }
    if (!collectionObj || typeof collectionObj !== 'object') {
        return cb(new Error('collectionPayload must be a Postman collection object'));
    }

    let timestamp = new Date().getTime();
    searchOrCreateBasicCollectionArtifacts(userName, timestamp, (err, collectionsAbsoluteDir, collectionsInputAbsoluteDir, collectionsOutputAbsoluteDir) => {
        if (err) {
            return cb(err);
        }
        let importedCollectionName = '' + timestamp + '_' + collectionName;
        let inputCollectionFileName = collectionsInputAbsoluteDir + '/' + importedCollectionName;
        let serialized = JSON.stringify(collectionObj, null, 2);
        fs.writeFile(inputCollectionFileName, serialized, (writeErr) => {
            if (writeErr) {
                return cb(writeErr);
            }
            createCollectionsMetadataAndRequests(userName, timestamp, inputCollectionFileName, importedCollectionName, collectionsOutputAbsoluteDir, (metaErr) => {
                if (metaErr) {
                    return cb(metaErr);
                }
                cb(null, importedCollectionName);
            });
        });
    });
}

function importCollection(req, res) {
    try {
        extractCollectionDetailsFromRequest(req, (err, inputPayload) => {
            if(err) {
                res.status(400).json({'message': err.message});
            } else {
                importCollectionForUser(
                    inputPayload[constants.USERNAME],
                    inputPayload[constants.COLLECTION_NAME],
                    inputPayload[constants.COLLECTION_PAYLOAD],
                    (importErr, importedCollectionName) => {
                        if (importErr) {
                            res.status(400).json({'message': importErr.message});
                        } else {
                            res.status(201).json({'importedCollectionName': importedCollectionName});
                        }
                    }
                );
            }
        });
    } catch (catchErr) {
        log.error('Error in importing the collection: ', catchErr);
        res.status(400).json({'message': catchErr.message || String(catchErr)});
    }
}

// GET-style handler: return the bundled AWS service list for the picker.
function listAwsCatalogServices(req, res) {
    try {
        let awsCatalog = require('./awsCatalog');
        res.status(200).json({ services: awsCatalog.listServices() });
    } catch (catchErr) {
        log.error('Error listing AWS catalog services: ', catchErr);
        res.status(500).json({'message': catchErr.message || String(catchErr)});
    }
}

// Build the collection for the requested service on demand and import it.
// Body: { userName, service, region? }. The client sends only the service name.
function importAwsCatalogService(req, res) {
    let awsCatalog = require('./awsCatalog');
    let body = req.body || {};
    let userName = body[constants.USERNAME];
    let service = body.service;
    let region = body.region;
    if (!userName) {
        return res.status(400).json({'message': constants.USERNAME + ' not provided in request payload'});
    }
    if (!service) {
        return res.status(400).json({'message': 'service not provided in request payload'});
    }
    awsCatalog.buildServiceCollection(userName, service, { region: region })
        .then((result) => {
            let collectionName = result.entry.label + ' (' + result.entry.apiVersion + ')';
            importCollectionForUser(userName, collectionName, result.collection, (importErr, importedCollectionName) => {
                if (importErr) {
                    res.status(400).json({'message': importErr.message});
                } else {
                    res.status(201).json({
                        'importedCollectionName': importedCollectionName,
                        'requestCount': (result.collection.item || []).length,
                        'service': service
                    });
                }
            });
        })
        .catch((err) => {
            log.error('Error importing AWS catalog service [', service, ']: ', err.message);
            res.status(400).json({'message': 'Failed to build collection for ' + service + ': ' + err.message});
        });
}

function ignoreFunc(file, stats) {
    return (stats.isDirectory() && path.basename(file) == "test") || (!(stats.isDirectory()) && file.substr(-1*(PROFILE_EXT.length)) !== PROFILE_EXT);
}

function populateCollectionsDetails(req, res) {
    if(!req.body) {
        res.status(400).json({'message': 'request body not available in payload'});
    }
    let inputPayload = req.body;
    if(!inputPayload[constants.USERNAME]) {
        return res.status(400).json({'message': constants.USERNAME + ' not provided in request payload'});
    }

    let inputRequestLabel = inputPayload[constants.REQUESTLABEL];
    getOrCreateCollectionsBaseOutputDir(inputPayload[constants.USERNAME], (err, collectionsBaseOutputAbsoluteDir) => {
        if (err) {
            res.status(400).json({'message': err.message});
        } else {
            recursive(collectionsBaseOutputAbsoluteDir, ["*.html", "*.txt", "*.readme", "*.test", ignoreFunc],function (err, filesList) {
                if (err) {
                    return res.status(400).json({'message': error.message});
                }
                let outputObj = [];
                for (let count = 0; count < filesList.length; count++) {
                    let eachFile = filesList[count];
                    if (path.basename((eachFile)) === COLLECTIONS_METADATA_JSON_FILE) {
                        let eachOutputMetadataObj = jsonfile.readFileSync(eachFile, UTF8);
                        outputObj = outputObj.concat(eachOutputMetadataObj);
                    } else {
                        continue;
                    }
                }
                if (inputRequestLabel) {
                    let searchByLabelOutput = outputObj.filter((eachMetadataEntry) => {
                        let eachRequestLabel = eachMetadataEntry[constants.REQUESTLABEL] || 'Not Specified';
                        inputRequestLabel = inputRequestLabel.toLowerCase();
                        eachRequestLabel = eachRequestLabel.toLowerCase();
                        return inputRequestLabel === eachRequestLabel || inputRequestLabel.includes(eachRequestLabel) || eachRequestLabel.includes(inputRequestLabel);
                    });
                    res.status(201).json(searchByLabelOutput.reverse());
                } else {
                    res.status(201).json(outputObj.reverse());
                }
            });

        }
    });

}

// An imported collection is stored as `input/<timestamp>/<timestamp>_<name>`, so
// the timestamp — which is what identifies the collection's two directories — can
// be read straight off the file name. Pure, so the parsing is testable.
//
// Returns null for anything that is not that shape, including a name carrying a
// path separator: delete builds a filesystem path from this value, so a caller
// must not be able to walk out of the collections directory with it.
function splitImportedCollectionName(importedCollectionName) {
    let name = String(importedCollectionName === null || importedCollectionName === undefined
        ? '' : importedCollectionName);
    if (!name || name !== path.basename(name) || name.indexOf('..') === 0) {
        return null;
    }
    let separator = name.indexOf('_');
    if (separator < 1) {
        return null;
    }
    let timestamp = name.slice(0, separator);
    if (!/^[0-9]+$/.test(timestamp)) {
        return null;
    }
    return { timestamp: timestamp, collectionName: name.slice(separator + 1) };
}

// Locate the timestamp directory holding `importedCollectionName`.
//
// This deliberately does NOT reuse the `recursive` + `ignoreFunc` scan the other
// collection handlers use. `ignoreFunc` drops every file that does not end in
// `.json`, and a collection imported from the AWS catalog is named from its
// service label — `1788457090741_Aiops (2018-05-10)`, no extension at all — so
// the scan never saw it and deleting one always failed with "could not locate
// the collection". Only collections whose name happened to end in `.json` (an
// uploaded `foo.json`) were ever deletable.
function findCollectionTimestamp(collectionsBaseInputAbsoluteDir, importedCollectionName) {
    let parsed = splitImportedCollectionName(importedCollectionName);
    if (parsed) {
        let candidate = path.join(collectionsBaseInputAbsoluteDir, parsed.timestamp, importedCollectionName);
        if (fs.existsSync(candidate)) {
            return parsed.timestamp;
        }
    }
    // Fall back to a scan for a collection that predates the naming convention.
    let entries;
    try {
        entries = fs.readdirSync(collectionsBaseInputAbsoluteDir);
    } catch (readErr) {
        return null;
    }
    for (let count = 0; count < entries.length; count++) {
        let timestampDir = path.join(collectionsBaseInputAbsoluteDir, entries[count]);
        try {
            if (!fs.statSync(timestampDir).isDirectory()) {
                continue;
            }
            if (fs.readdirSync(timestampDir).indexOf(importedCollectionName) !== -1) {
                return entries[count];
            }
        } catch (statErr) {
            continue;
        }
    }
    return null;
}

// Remove every file in `dir`, then the (now empty) directory itself. Used for a
// collection's per-timestamp input and output directories, each of which holds
// exactly one collection's artifacts.
function removeCollectionDir(dir) {
    if (!fs.existsSync(dir)) {
        return;
    }
    let entries = fs.readdirSync(dir);
    for (let count = 0; count < entries.length; count++) {
        let each = path.join(dir, entries[count]);
        if (fs.statSync(each).isDirectory()) {
            removeCollectionDir(each);
        } else {
            fs.unlinkSync(each);
        }
    }
    fs.rmdirSync(dir);
}

function deleteCollection(req, res) {
    try {
        if(!req.body) {
            return res.status(400).json({'message': 'request body not available in payload'});
        }
        let inputPayload = req.body;
        let loginUserName = inputPayload[constants.USERNAME];
        if(!loginUserName) {
            return res.status(400).json({'message': constants.USERNAME + ' not provided in request payload'});
        }
        let importedCollectionName = inputPayload[constants.IMPORTED_COLLECTION_NAME]
        if(!importedCollectionName) {
            return res.status(400).json({'message': constants.IMPORTED_COLLECTION_NAME + ' not provided in payload'});
        }

        getOrCreateCollectionsBaseInputDir(loginUserName, (inputDirErr, collectionsBaseInputAbsoluteDir) => {
            if (inputDirErr) {
                return res.status(400).json({'message': inputDirErr.message});
            }
            let timestamp = findCollectionTimestamp(collectionsBaseInputAbsoluteDir, importedCollectionName);
            if (!timestamp) {
                return res.status(400).json({'message': 'could not locate the collection: ' + importedCollectionName});
            }
            getOrCreateCollectionsBaseOutputDir(loginUserName, (outputDirErr, collectionsBaseOutputAbsoluteDir) => {
                if (outputDirErr) {
                    return res.status(400).json({'message': outputDirErr.message});
                }
                try {
                    // The collection's input file and every generated request file
                    // live under these two directories and nowhere else.
                    removeCollectionDir(path.join(collectionsBaseInputAbsoluteDir, timestamp));
                    removeCollectionDir(path.join(collectionsBaseOutputAbsoluteDir, timestamp));
                } catch (removeErr) {
                    log.error('error deleting collection [', importedCollectionName, '] : ', removeErr);
                    return res.status(400).json({'message': 'could not delete the collection: ' + removeErr.message});
                }
                return res.status(204).end();
            });
        });
    } catch (catchErr) {
        log.error('Error in deleting the collection: ', catchErr);
        res.status(400).json({'message': catchErr.message || String(catchErr)});
    }
}


// Delete a single request from whichever imported collection contains it,
// keyed by the request's unique detail file name (requestDetailsFileName).
// Only the collection artifacts are touched — any copies already saved to
// History or Favorites are independent and left intact.
function deleteRequestFromCollection(req, res) {
    try {
        if (!req.body) {
            return res.status(400).json({'message': 'request body not available in payload'});
        }
        let inputPayload = req.body;
        let loginUserName = inputPayload[constants.USERNAME];
        if (!loginUserName) {
            return res.status(400).json({'message': constants.USERNAME + ' not provided in request payload'});
        }
        let requestDetailsFileName = inputPayload['requestDetailsFileName'];
        if (!requestDetailsFileName) {
            return res.status(400).json({'message': 'requestDetailsFileName not provided in payload'});
        }
        getOrCreateCollectionsBaseOutputDir(loginUserName, (err, collectionsBaseOutputAbsoluteDir) => {
            if (err) {
                return res.status(400).json({'message': err.message});
            }
            recursive(collectionsBaseOutputAbsoluteDir, ["*.html", "*.txt", "*.readme", "*.test", ignoreFunc], function (err, filesList) {
                if (err) {
                    return res.status(400).json({'message': err.message});
                }
                // Find the collection's metadata.json that lists this request.
                let targetMetadataFile = null;
                let targetMetadataObj = null;
                for (let count = 0; count < filesList.length; count++) {
                    let eachFile = filesList[count];
                    if (path.basename(eachFile) === COLLECTIONS_METADATA_JSON_FILE) {
                        let metadataObj = jsonfile.readFileSync(eachFile, UTF8);
                        let found = metadataObj.some((e) => e['requestDetailsFileName'] === requestDetailsFileName);
                        if (found) {
                            targetMetadataFile = eachFile;
                            targetMetadataObj = metadataObj;
                            break;
                        }
                    }
                }
                if (!targetMetadataFile) {
                    return res.status(400).json({'message': 'could not locate the request: ' + requestDetailsFileName});
                }
                let dir = path.dirname(targetMetadataFile);
                let requestFile = path.resolve(dir + '/' + requestDetailsFileName);
                // Remove the per-request detail file (best-effort; ignore if gone).
                try {
                    if (fs.existsSync(requestFile)) {
                        fs.unlinkSync(requestFile);
                    }
                } catch (unlinkErr) {
                    return res.status(400).json({'message': unlinkErr.message});
                }
                // Rewrite the metadata without the removed entry.
                let updatedMetadata = targetMetadataObj.filter((e) => e['requestDetailsFileName'] !== requestDetailsFileName);
                jsonfile.writeFile(targetMetadataFile, updatedMetadata, { spaces: 2 }, (writeErr) => {
                    if (writeErr) {
                        return res.status(400).json({'message': writeErr.message});
                    }
                    return res.status(204).end();
                });
            });
        });
    } catch (catchErr) {
        log.error('Error in deleting request from collection: ', catchErr);
        res.status(400).json({'message': catchErr.message || String(catchErr)});
    }
}


function deleteFileInDir(file, cb) {
    if (fs.existsSync(file)) {
        let stats = fs.statSync(file);
        if (!stats.isFile()) {
            let error = new Error('[' + file + '] is not a file.');
            return cb(error);
        } else {
            fs.unlinkSync(file);
            cb(null);
        }
    } else {
        cb(new Error('message' + importedCollectionName + ' does not exist'));
    }
}

function updateHistoryMetadata(loginUserName, historyMetadataOutputObj, historyMetadataFile, cb) {
    jsonfile.writeFile(historyMetadataFile, historyMetadataOutputObj, function (err) {
        if(err) {
            return cb(err);
        } else {
            let updateHistoryTableEvent = 'event_update_' + loginUserName +  '_history_table';
            if (!origSocket) {
                log.debug('socket not available. can not emit updateHistoryTableEvent');
            } else {
                origSocket.emit(updateHistoryTableEvent, {
                    history: historyMetadataOutputObj.reverse(),
                    userName: loginUserName
                });
            }
            cb(null);
        }
    });
}

function updateFavoritesMetadata(loginUserName, favoritesMetadataOutputObj, favoritesMetadataFile, cb) {
    jsonfile.writeFile(favoritesMetadataFile, favoritesMetadataOutputObj, function (err) {
        if(err) {
            return cb(err);
        } else {
            let updateFavoritesTableEvent = 'event_update_' + loginUserName +  '_favorites_table';
            if (!origSocket) {
                log.debug('socket not available. can not emit updateFavoritesTableEvent');
            } else {
                origSocket.emit(updateFavoritesTableEvent, {
                    favorites: favoritesMetadataOutputObj.reverse(),
                    userName: loginUserName
                });
            }
            cb(null);
        }
    });
}

function createCollectionsMetadata(loginUserName, collectionsMetadataOutputObj, collectionsMetadataFile, cb) {
    jsonfile.writeFile(collectionsMetadataFile, collectionsMetadataOutputObj, function (err) {
        if(err) {
            return cb(err);
        } else {
            let updateFavoritesTableEvent = 'event_update_' + loginUserName +  '_collections_table';
            if (!origSocket) {
                log.debug('socket not available. can not emit updateFavoritesTableEvent');
            } else {
                origSocket.emit(updateFavoritesTableEvent, {
                    collections: collectionsMetadataOutputObj.reverse(),
                    userName: loginUserName
                });
            }
            cb(null);
        }
    });
}

function createCollectionsMetadataAndRequests(loginUserName, timestamp, inputCollectionFileName, importedCollectionName, collectionsOutputAbsoluteDir, cb) {
    let nameHolder = '';
    let inputCollectionObj = jsonfile.readFileSync(inputCollectionFileName, UTF8);
    if (!inputCollectionObj || !inputCollectionObj.item || inputCollectionObj.item.length == 0) {
        return cb(new Error('input collection is empty.'))
    }
    if (inputCollectionObj.info && inputCollectionObj.info.name) {
        nameHolder = inputCollectionObj.info.name;
    }
    // The collection's display name is tracked separately (its own column/field);
    // the per-request label starts from an empty folder path so it does NOT
    // accumulate the collection name or sibling names.
    let result = processItemsInCollection(inputCollectionObj.item, '', timestamp, new Date(timestamp).toString(), importedCollectionName, nameHolder);
    let collectionsMetadataOutputObj = [];
    for (let count = 0; count < result.length; count++) {
        let eachObj = result[count];
        let requestDetails = eachObj['requestDetails'];
        let metadata = eachObj['metadata'];
        collectionsMetadataOutputObj.push(metadata);
        let fileName = metadata['requestDetailsFileName'];
        let requestFile = collectionsOutputAbsoluteDir + '/' + fileName;
        jsonfile.writeFileSync(requestFile, requestDetails);
    }
    let collectionsMetadataFile = collectionsOutputAbsoluteDir + '/' + COLLECTIONS_METADATA_JSON_FILE;
    createCollectionsMetadata(loginUserName, collectionsMetadataOutputObj, collectionsMetadataFile, (err) => {
        if(err) {
            cb(err);
        } else {
            cb(null);
        }
    })

}

// Walk a Postman collection's items depth-first. `folderPath` is the nested
// folder path (within the collection) leading to the current items — it is
// passed by value into each recursion and NEVER mutated in place, so a request's
// label reflects only its own folder path + name, not its siblings. The
// collection's display name is carried separately in `collectionName` so it can
// be shown/searched on its own without bloating each request label.
function processItemsInCollection(item, folderPath, timestamp, timestampReadable, importedCollectionName, collectionName) {
    let result = [];
    if (item.length == 0) {
        return result;
    }
    for (let i = 0; i < item.length; i++) {
        let eachItem = item[i];
        if (eachItem.item && eachItem.item.length > 0) {
            // Descend into a sub-folder: extend the path for the child scope only.
            let childFolderPath = folderPath ? folderPath + '/' + eachItem.name : (eachItem.name || '');
            let subResult = processItemsInCollection(eachItem.item, childFolderPath, timestamp, timestampReadable, importedCollectionName, collectionName);
            result = result.concat(subResult);
        }
        let request = eachItem.request
        if (request ) {
            let eachObj = {
            };
            let metadata = {
            };
            let requestDetails = {
            };
            requestDetails['id'] = uuidv4().toUpperCase().replace(/-/g, '');
            metadata['requestDetailsFileName'] = requestDetails['id'] + PROFILE_EXT;
            requestDetails['timestamp'] = timestamp;
            requestDetails['addedAt'] = timestampReadable;
            requestDetails['importedCollectionName'] = importedCollectionName;
            // Carry the imported collection name in the metadata too, so the UI
            // can offer a "delete this collection" picker (delete keys off it).
            metadata['importedCollectionName'] = importedCollectionName;
            metadata['collectionName'] = collectionName || '';
            requestDetails['collectionName'] = collectionName || '';
            metadata['requestName'] = eachItem.name;
            requestDetails['requestName'] = eachItem.name;
            if (request.description) {
                requestDetails['requestDescription'] = request.description;
            }
            if (!request.url || !request.url.raw) {
                continue;
            }
            requestDetails['endpoint'] = request.url.raw;
            metadata['method'] = request.method;
            requestDetails['method'] = request.method;
            if (request.auth && request.auth.type && request.auth.type.toLowerCase().includes('aws')) {
                requestDetails['requestAuthType'] = 'aws';
            } else if (request.auth && request.auth.type && request.auth.type.toLowerCase().includes('basic')) {
                requestDetails['requestAuthType'] = 'basic_auth';
            } else if (request.auth && request.auth.type && request.auth.type.toLowerCase().includes('bearer')) {
                requestDetails['requestAuthType'] = 'bearer_token';
            } else {
                requestDetails['requestAuthType'] = 'other';
            }
            if (request.header && request.header.length > 0) {
                let headerArr = request.header;
                let header = [];
                for (let count = 0; count < headerArr.length; count++) {
                    let eachHeader = headerArr[count];
                    let key = eachHeader.key;
                    let value = eachHeader.value;
                    if (key.toLowerCase() === 'authorization') {
                        if (value && value.toLowerCase().includes('bearer')) {
                            requestDetails['requestAuthType'] = 'bearer_token';
                        } else  { //if (value.toLowerCase().includes('basic')) {
                            requestDetails['requestAuthType'] = 'basic_auth';
                        }
                    } else {
                        header.push({
                            'key': key,
                            'value': value
                        });
                    }
                }
                requestDetails['header'] = header;
            } else {
                requestDetails['header'] = [];
            }
            if (request.body && request.body.mode.toLowerCase() === 'raw') {
                requestDetails['body'] = request.body.raw;
            } else if (request.body && request.body.mode.toLowerCase() === 'urlencoded') {
                let urlencodedArr = request.body.urlencoded;
                let body = '';
                for (let count = 0; count < urlencodedArr.length; count++) {
                    let eachUrlEncoded = urlencodedArr[count];
                    let key = eachUrlEncoded.key;
                    let value = eachUrlEncoded.value;
                    if (count >= 1) {
                        body += '&';
                    }
                    body += key + '=' + value;
                }
                requestDetails['body'] = body;
            }
            // Label = folder path (if any) + this request's name. No collection
            // name, no sibling names — just this request's own location.
            let requestLabel = folderPath ? folderPath + '/' + eachItem.name : (eachItem.name || '');
            metadata['requestLabel'] = requestLabel;
            requestDetails['requestLabel'] = requestLabel;

            eachObj['metadata'] = metadata;
            eachObj['requestDetails'] = requestDetails;
            result.push(eachObj);
        }
    }
    return result;
}

function getHistoryDetailsById(loginUserName, historyId, cb) {
    let segmentErr = pathSafety.assertSafeSegment(historyId, 'historyId');
    if (segmentErr) {
        return cb(segmentErr);
    }
    getOrCreateHistoryDir(loginUserName, (err, historyAbsoluteDir) => {
       if (err) {
           cb(err);
       } else {
           let historyIdAbsoluteFile = path.resolve( historyAbsoluteDir + '/' + historyId + '.json');
           jsonfile.readFile(historyIdAbsoluteFile, (readErr, responseObj) => {
               if (readErr) {
                   cb(readErr);
               } else {
                   cb(null, responseObj);
               }
           });
       }
    });
}

function getCollectionDetailsById(loginUserName, collectionId, cb) {
    getOrCreateCollectionsBaseOutputDir(loginUserName, (err, collectionsBaseOutputAbsoluteDir) => {
        if (err) {
            return cb(err);
        } else {
            log.debug('collectionsBaseOutputAbsoluteDir: ', collectionsBaseOutputAbsoluteDir);
            recursive(collectionsBaseOutputAbsoluteDir, ["*.html", "*.txt", "*.readme", "*.test", ignoreFunc],function (err, filesList) {
                if (err) {
                    log.error('in the err: ', err);
                    return cb(err);
                }
                let collectionObj = [];
                for (let count = 0; count < filesList.length; count++) {
                    let eachFile = filesList[count];
                    if (path.basename((eachFile)) === (collectionId + PROFILE_EXT)) {
                        collectionObj = jsonfile.readFileSync(eachFile, UTF8);
                        break;
                    }
                }
                log.debug('returning the collectionObj: ', collectionObj)
                return cb(null, collectionObj);
            });
        }
    });
}

function getFavoriteDetailsById(loginUserName, favoriteId, cb) {
    let segmentErr = pathSafety.assertSafeSegment(favoriteId, 'favoriteId');
    if (segmentErr) {
        return cb(segmentErr);
    }
    getOrCreateFavoritesDir(loginUserName, (err, favoritesAbsoluteDir) => {
        if (err) {
            cb(err);
        } else {
            let favoriteIdAbsoluteFile = path.resolve( favoritesAbsoluteDir + '/' + favoriteId + '.json');
            jsonfile.readFile(favoriteIdAbsoluteFile, (readErr, responseObj) => {
                if (readErr) {
                    cb(readErr);
                } else {
                    cb(null, responseObj);
                }
            });
        }
    });
}

function getOrCreateHistoryDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create history dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let historyAbsoluteDir = path.join(paths.getUserDir(loginUserName), historyDirName);
    fs.mkdirSync(historyAbsoluteDir, { recursive: true });
    cb(null, historyAbsoluteDir);
}

function getOrCreateFavoritesDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create favorites dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let favoritesAbsoluteDir = path.join(paths.getUserDir(loginUserName), favoritesDirName);
    fs.mkdirSync(favoritesAbsoluteDir, { recursive: true });
    cb(null, favoritesAbsoluteDir);
}

function getOrCreateCollectionsDir(loginUserName, timestamp, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create collections dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let collectionsAbsoluteDir = path.join(paths.getUserDir(loginUserName), collectionsDirName);
    fs.mkdirSync(collectionsAbsoluteDir, { recursive: true });
    let collectionsInputAbsoluteDir = path.join(collectionsAbsoluteDir, 'input', String(timestamp));
    fs.mkdirSync(collectionsInputAbsoluteDir, { recursive: true });
    let collectionsOutputAbsoluteDir = path.join(collectionsAbsoluteDir, 'output', String(timestamp));
    fs.mkdirSync(collectionsOutputAbsoluteDir, { recursive: true });
    cb(null, collectionsAbsoluteDir, collectionsInputAbsoluteDir, collectionsOutputAbsoluteDir);
}

function getOrCreateCollectionsBaseInputDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create collections input dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let collectionsBaseInputAbsoluteDir = path.join(paths.getUserDir(loginUserName), collectionsDirName, 'input');
    fs.mkdirSync(collectionsBaseInputAbsoluteDir, { recursive: true });
    cb(null, collectionsBaseInputAbsoluteDir);
}

function getOrCreateCollectionsBaseOutputDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create collections output dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let collectionsBaseOutputAbsoluteDir = path.join(paths.getUserDir(loginUserName), collectionsDirName, 'output');
    fs.mkdirSync(collectionsBaseOutputAbsoluteDir, { recursive: true });
    cb(null, collectionsBaseOutputAbsoluteDir);
}

function getOrCreateSettingsDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create settings dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let settingsAbsoluteDir = path.join(paths.getUserDir(loginUserName), settingsDirName);
    fs.mkdirSync(settingsAbsoluteDir, { recursive: true });
    cb(null, settingsAbsoluteDir);
}

function getOrCreateScriptsDir(loginUserName, cb) {
    if (!loginUserName) {
        let err = new Error('loginUserName is not specified. Can not search or create scripts dir.');
        return cb(err);
    }
    loginUserName = loginUserName.toLowerCase();
    let scriptsAbsoluteDir = path.join(paths.getUserDir(loginUserName), scriptsDirName);
    fs.mkdirSync(scriptsAbsoluteDir, { recursive: true });
    cb(null, scriptsAbsoluteDir);
}


function searchOrCreateBasicHistoryArtifacts(loginUserName, cb) {
    let fileName = HISTORY_METADATA_JSON_FILE;
    try {
        getOrCreateHistoryDir(loginUserName, (err, historyAbsoluteDir) => {
            if (err) {
                return cb(err);
            } else {
                let historyMetadataFile = path.resolve(historyAbsoluteDir + "/" + fileName);
                log.debug('historyMetadataFile : ', historyMetadataFile);
                if (fs.existsSync(historyMetadataFile)) {
                    let stats = fs.statSync(historyMetadataFile);
                    if (!stats.isFile()) {
                        let error = new Error('[' + historyMetadataFile + '] is not a file.');
                        return cb(error);
                    } else {
                        let historyMetadataOutputObj = jsonfile.readFileSync(historyMetadataFile, UTF8);
                        cb(null, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile)
                    }
                } else {
                    let historyMetadataOutputObj = [];
                    jsonfile.writeFile(historyMetadataFile, historyMetadataOutputObj, (writeErr) => {
                        if (writeErr) {
                            log.error('error in creating the history metadata : ', historyMetadataFile, ' : ', writeErr);
                            return cb(writeErr);
                        } else {
                            return cb(null, historyMetadataOutputObj, historyAbsoluteDir, historyMetadataFile);
                        }
                    });
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in creating history metadata for [', loginUserName, '] : ', catchErr);
        cb(catchErr);
    }
}

function searchOrCreateBasicFavoriteArtifacts(loginUserName, cb) {
    let fileName = FAVORITE_METADATA_JSON_FILE;
    try {
        getOrCreateFavoritesDir(loginUserName, (err, favoritesAbsoluteDir) => {
            if (err) {
                return cb(err);
            } else {
                let favoritesMetadataFile = path.resolve(favoritesAbsoluteDir + "/" + fileName);
                log.debug('favoritesMetadataFile : ', favoritesMetadataFile);
                if (fs.existsSync(favoritesMetadataFile)) {
                    let stats = fs.statSync(favoritesMetadataFile);
                    if (!stats.isFile()) {
                        let error = new Error('[' + favoritesMetadataFile + '] is not a file.');
                        return cb(error);
                    } else {
                        let historyMetadataOutputObj = jsonfile.readFileSync(favoritesMetadataFile, UTF8);
                        cb(null, historyMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile)
                    }
                } else {
                    let favoritesMetadataOutputObj = [];
                    jsonfile.writeFile(favoritesMetadataFile, favoritesMetadataOutputObj, (writeErr) => {
                        if (writeErr) {
                            log.error('error in creating the favorites metadata : ', favoritesMetadataFile, ' : ', writeErr);
                            return cb(writeErr);
                        } else {
                            return cb(null, favoritesMetadataOutputObj, favoritesAbsoluteDir, favoritesMetadataFile);
                        }
                    });
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in creating history metadata for [', loginUserName, '] : ', catchErr);
        cb(catchErr);
    }
}


function searchOrCreateBasicCollectionArtifacts(loginUserName, timestamp, cb) {
    try {
        getOrCreateCollectionsDir(loginUserName, timestamp, (err, collectionsAbsoluteDir, collectionsInputAbsoluteDir, collectionsOutputAbsoluteDir) => {
            if (err) {
                return cb(err);
            } else {
                return cb(null, collectionsAbsoluteDir, collectionsInputAbsoluteDir, collectionsOutputAbsoluteDir);
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in creating collections dir for [', loginUserName, '] : ', catchErr);
        cb(catchErr);
    }
}

function getSettingsMetadataSync(loginUserName) {
    try {
        let fileName = settingsFileName;
        let settingsMetadataFile = path.join(paths.getUserDir(loginUserName), settingsDirName, fileName);
        return jsonfile.readFileSync(settingsMetadataFile, UTF8);
    } catch (err) {
        return err.message;
    }
}

function searchOrCreateBasicSettingsArtifacts(loginUserName, cb) {
    let fileName = settingsFileName;
    try {
        getOrCreateSettingsDir(loginUserName, (err, settingsAbsoluteDir) => {
            if (err) {
                return cb(err);
            } else {
                let settingsMetadataFile = path.resolve(settingsAbsoluteDir + "/" + fileName);
                log.debug('settingsMetadataFile : ', settingsMetadataFile);
                if (fs.existsSync(settingsMetadataFile)) {
                    let stats = fs.statSync(settingsMetadataFile);
                    if (!stats.isFile()) {
                        let error = new Error('[' + settingsMetadataFile + '] is not a file.');
                        return cb(error);
                    } else {
                        let settingsMetadataOutputObj = jsonfile.readFileSync(settingsMetadataFile, UTF8);
                        cb(null, settingsMetadataOutputObj, settingsAbsoluteDir, settingsMetadataFile)
                    }
                } else {
                    let settingsMetadataOutputObj = {
                      "variables": [],
                      "tinyUrlIntegration": {
                          "isEnabled": false,
                          "token": ""
                      },
                      "shouldPromptHistoryDeletion": true,
                      "shouldPromptFavoriteDeletion": true,
                      "shouldPromptCollectionRequestDeletion": true,
                      "shouldPromptCollectionDeletion": true
                    };
                    jsonfile.writeFile(settingsMetadataFile, settingsMetadataOutputObj, { spaces: 2 }, (writeErr) => {
                        if (writeErr) {
                            log.error('error in creating the settings metadata : ', settingsMetadataFile, ' : ', writeErr);
                            return cb(writeErr);
                        } else {
                            return cb(null, settingsMetadataOutputObj, settingsAbsoluteDir, settingsMetadataFile);
                        }
                    });
                }
            }
        });
    } catch (catchErr) {
        log.error('caught unexpected error in creating settings metadata for [', loginUserName, '] : ', catchErr);
        cb(catchErr);
    }
}

function getUserConfiguredProfilesBaseDir(loginUserName, cb) {
    if (!loginUserName) {
        return cb(new Error('user login not provided in request payload'));
    }
    loginUserName = loginUserName.toLowerCase();
    let userConfiguredProfilesBaseDir = path.join(paths.getUserDir(loginUserName), profilesDirName);
    fs.mkdirSync(userConfiguredProfilesBaseDir, { recursive: true });
    cb(null, userConfiguredProfilesBaseDir);
}

// Every profile read, write and delete funnels through here, so this is the one
// place a profile name has to be checked: it becomes a directory name, and the
// mkdir below is recursive, so an unchecked name creates directories anywhere the
// process can write.
function getOrCreateProfilesDir(loginUserName, profileDir, cb) {
    if (!loginUserName) {
        return cb(new Error('user login not provided in request payload'));
    }
    let segmentErr = pathSafety.assertSafeSegment(profileDir, 'profileName');
    if (segmentErr) {
        return cb(segmentErr);
    }
    loginUserName = loginUserName.toLowerCase();
    let signingKeysProfilesAbsoluteDir = path.join(paths.getUserDir(loginUserName), profilesDirName, profileDir);
    fs.mkdirSync(signingKeysProfilesAbsoluteDir, { recursive: true });
    cb(null, signingKeysProfilesAbsoluteDir);
}

// The region becomes a directory name, and it arrives from a profile the caller
// created — so it is caller-supplied text, not an AWS-validated region.
function getPublicClientCreds(region) {
    let segmentErr = pathSafety.assertSafeSegment(region, 'region');
    if (segmentErr) {
        throw segmentErr;
    }
    let publicClientCredsDirName = props.get('server.publicClientCredsDirName') || 'public_client_creds';
    let credsDir = path.join(paths.getUserDir(authConfig.getDefaultUserName()), publicClientCredsDirName, region);
    fs.mkdirSync(credsDir, { recursive: true });
    return path.resolve(credsDir + "/" + publicClientCredsFileName)
}

module.exports = {
    getOrCreateProfilesDir: getOrCreateProfilesDir,
    getPublicClientCreds: getPublicClientCreds,
    getUserConfiguredProfilesBaseDir: getUserConfiguredProfilesBaseDir,
    socketEventMgmt: socketEventMgmt,
    emitToUser: emitToUser,
    updateHistoryMetadata: updateHistoryMetadata,
    createHistoryDetailsForTheGivenRequest: createHistoryDetailsForTheGivenRequest,
    deleteHistoryDetailsForTheGivenRequest: deleteHistoryDetailsForTheGivenRequest,
    deleteFavoriteDetailsForTheGivenRequest: deleteFavoriteDetailsForTheGivenRequest,
    getHistoryDetailsForTheGivenRequest: getHistoryDetailsForTheGivenRequest,
    getFavoriteDetailsForTheGivenRequest: getFavoriteDetailsForTheGivenRequest,
    addToFavoritesAndUpdateMetadata: addToFavoritesAndUpdateMetadata,
    applyLabelForTheGivenRequest: applyLabelForTheGivenRequest,
    applyLabelForTheGivenFavoriteRequest: applyLabelForTheGivenFavoriteRequest,
    importCollection: importCollection,
    listAwsCatalogServices: listAwsCatalogServices,
    importAwsCatalogService: importAwsCatalogService,
    deleteCollection: deleteCollection,
    // Exported for tests: the name parsing and directory lookup delete depends on.
    splitImportedCollectionName: splitImportedCollectionName,
    findCollectionTimestamp: findCollectionTimestamp,
    deleteRequestFromCollection: deleteRequestFromCollection,
    populateCollectionsDetails: populateCollectionsDetails,
    constants: constants,
    searchOrCreateBasicHistoryArtifacts: searchOrCreateBasicHistoryArtifacts,
    searchOrCreateBasicFavoriteArtifacts: searchOrCreateBasicFavoriteArtifacts,
    searchOrCreateBasicSettingsArtifacts: searchOrCreateBasicSettingsArtifacts,
    getSettingsMetadataSync: getSettingsMetadataSync,
    getOrCreateScriptsDir: getOrCreateScriptsDir
};

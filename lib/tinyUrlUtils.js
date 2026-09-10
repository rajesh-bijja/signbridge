const { https } = require('follow-redirects');
let coreUtils = require('./coreUtils');
let redact = require('./redact');
let log = require('./logger').create('tinyUrlUtils');
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

function createTinyUrl(loginUserName, urlToShort, cb) {
    if (!loginUserName) {
        return cb(new Error('user login not provided in request payload'));
    }
    coreUtils.searchOrCreateBasicSettingsArtifacts(loginUserName, (err, settingsMetadataOutputObj) => {
        if (err) {
            return cb(err);
        }
        if (settingsMetadataOutputObj['tinyUrlIntegration'] &&
            settingsMetadataOutputObj['tinyUrlIntegration']['isEnabled'] &&
            settingsMetadataOutputObj['tinyUrlIntegration']['token']) {
            _createTinyUrl(urlToShort, settingsMetadataOutputObj['tinyUrlIntegration']['token'], (tinyUrlErr, tinyUrl) => {
                if (tinyUrlErr) {
                    return cb(tinyUrlErr)
                }
                return cb(null, tinyUrl)
            });
        } else {
            return cb(null, urlToShort);
        }

    });


}

function _createTinyUrl(urlToShort, token, cb) {
    let authToken = 'Bearer ' + token;
    let options = {
        'method': 'POST',
        'protocol': 'https:',
        'hostname': 'api.tinyurl.com',
        'port': 443,
        'path': '/create',
        'headers': {
            'Content-Type': 'application/json',
            'Authorization': authToken
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
                    // The echoed long URL is a presigned URL, i.e. X-Amz-Signature and (for a
                    // temporary-credential profile) X-Amz-Security-Token in the query string.
                    log.debug('tinyUrl response is: ', redact.forLog(responseJson));
                    return cb(null, responseJson['data']['tiny_url']);
                } catch (err) {
                    log.error('error occurred in extracting the tiny url from the response: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('create tiny url response is empty.'))
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('error response received in create tiny url call: ', JSON.parse(error));
            } else {
                log.error('error response received in create tiny url call : ', error);
            }
            return cb(error);
        });
    });

    let postData = JSON.stringify({
        "url": urlToShort
    });

    req.write(postData);

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to execute the create tiny url request : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to execute the create tiny url request : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

module.exports = {
    createTinyUrl: createTinyUrl
}
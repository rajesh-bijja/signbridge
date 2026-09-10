const { https } = require('follow-redirects')
let TIMEOUT = 600000;

const crypto =require('crypto')
let sigv4 = require('./sigv4');
const { parseString } = require('xml2js')
let redact = require('./redact');
let log = require('./logger').create('ssoS3Get');

const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function callSsoS3Get(options, roleCredentials, cb) {
    let pathname = options['pathname'];
    let canonicalUriPath = '';
    if (pathname === '/') {
        canonicalUriPath = '/';
    } else {
        let splitPaths = pathname.split('/');
        splitPaths.shift();
        for (let i = 0; i < splitPaths.length; i++) {
            if (splitPaths[i].length == 0) {
                canonicalUriPath += '/';
            } else {
                canonicalUriPath += '/';
                canonicalUriPath += encodeRFC3986URIComponent(splitPaths[i]);
            }
        }
    }



    let algorithm = 'AWS4-HMAC-SHA256'

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
        return cb(new Error(message));
    }

    let accessKeyId = roleCredentials.accessKeyId
    let secretAccessKey = roleCredentials.secretAccessKey
    let xAmzSecurityToken = roleCredentials.sessionToken

    let amzDates = sigv4.amzDates();
    let dateTimeStamp = amzDates.amzDate;
    let dateStamp = amzDates.dateStamp;
    let requestDateTime = dateTimeStamp;
    log.debug('requestDateTime is: [' + requestDateTime + '] and dateStamp is: [' + dateStamp + ']')
    let awsRequestTerminator = 'aws4_request'

    // there is no payload in GET request, hence hashed payload is created using empty string.
    let payload = ''
    let hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
    log.debug('hashedPayload: [', hashedPayload, ']')




    let sortedHeaders = [
        'host',
        'x-amz-content-sha256',
        'x-amz-date',
        'x-amz-security-token'
    ].sort();
    let headersToBeProcessed = {
        'host': host,
        'x-amz-content-sha256': hashedPayload,
        'x-amz-date': requestDateTime,
        'x-amz-security-token': xAmzSecurityToken
    };
    let canonicalHeaders = '';
    // canonical headers are built using the format: <header_name>:<header_value>\n
    // And there is a \n at the end.
    for (let eachHeaderIndex in sortedHeaders) {
        let eachHeader = sortedHeaders[eachHeaderIndex];
        canonicalHeaders += eachHeader + ':' + headersToBeProcessed[eachHeader] + '\n';
    }
    log.debug('canonicalHeaders: --start', redact.redactCanonicalRequest(canonicalHeaders), '--complete')




    // signedHeaders are sorted headers separated by semi-colon (;) and there is
    // no semi-colon at the end.
    let signedHeaders = ''
    for (let eachSortedHeaderIndex in sortedHeaders) {
        signedHeaders += sortedHeaders[eachSortedHeaderIndex] + ';';
    }
    signedHeaders = signedHeaders.substring(0, signedHeaders.length -1)

    let credentialScope = dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator



    let path = options['path'];
    let query = options['query'];
    let canonicalQueryString = '';
    let queriesToBeProcessed = {};
    let queryParts = query.split('&');
    if (queryParts.length > 0 && queryParts[0] === '') {
        queryParts.shift();
    }
    let queryNames= [];

    for (let i = 0; i < queryParts.length; i++) {
        let querySubParts = queryParts[i].split('=');
        let eachQueryName = encodeRFC3986URIComponent(querySubParts[0])
        queryNames.push(eachQueryName);
        queriesToBeProcessed[eachQueryName] = encodeRFC3986URIComponent(querySubParts[1]);

    }
    let sortedQueryNames = queryNames.sort();
    if (sortedQueryNames.length >= 1) {
        let sortedQueryName = sortedQueryNames[0];
        canonicalQueryString = sortedQueryName + '=' + queriesToBeProcessed[sortedQueryName];
    }
    for (let i = 1; i < sortedQueryNames.length; i++) {
        let eachSortedQueryName = sortedQueryNames[i];
        canonicalQueryString += '&' + eachSortedQueryName + '=' + queriesToBeProcessed[eachSortedQueryName];
    }



    let canonicalRequest = options['method'].toUpperCase() + '\n' +
        canonicalUriPath + '\n' +
        canonicalQueryString + '\n' +
        canonicalHeaders + '\n' +
        signedHeaders + '\n' +
        hashedPayload
    // The canonical headers include x-amz-security-token, so the raw block is a credential.
    log.debug('canonicalRequest: [\n' +  redact.redactCanonicalRequest(canonicalRequest) +  '\n]')
    let hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    log.debug('canonical request hash: [', hashedCanonicalRequest, ']');

    let stringToSign = algorithm + '\n' +
        requestDateTime + '\n' +
        credentialScope + '\n' +
        hashedCanonicalRequest
    log.debug('string to sign: [\n' +  stringToSign +  '\n]');
    let kSecret = 'AWS4' + secretAccessKey
    let kDate = crypto.createHmac('sha256', kSecret).update(dateStamp).digest(undefined)
    let kRegion = crypto.createHmac('sha256', kDate).update(region).digest(undefined)
    let kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest(undefined)
    let kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest(undefined)
    let signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    log.debug('signature: [\n' + redact.maskIdentifier(signature) + '\n]')
    let new_credential = 'Credential=' + accessKeyId + '/' + dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator;
    let authorizationHeader = algorithm + ' ' + new_credential + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
    log.debug(redact.redactText(authorizationHeader));

    let headers = {};
    Object.assign(headers, options['headers']);
    Object.assign(headers, headersToBeProcessed);
    headers['Authorization'] = authorizationHeader;

    invokeAwsGetApi(headers, path, options['method'].toUpperCase(), (awsApiErr, responseStatusCode, responseHeaders, data) => {
        if (awsApiErr) {
            return cb(awsApiErr);
        }
        return cb(null, responseStatusCode, responseHeaders, data);
    });
}

function invokeAwsGetApi(headers, path, method, cb) {
    let host = headers['host']
    delete headers['host'];
    log.debug('passed headers: [', redact.forLog(headers), '] host: [', host, '] path: ', path);

    let options = {
        'method': method,
        'protocol': 'https:',
        'hostname': host,
        'port': 443,
        'path': path,
        'headers': headers,
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
                    log.debug('aws GET api invocation response status: ', res.statusCode);
                    if (res.statusCode == 200 || res.statusCode == 201) {
                        log.debug('success response from aws GET api invocation.');
                        try {
                            let data = JSON.parse(responseBody);
                            return cb(null, res.statusCode, res.headers, data);
                        } catch(parseErr) {
                            parseString(responseBody, function (parseErr, results) {
                                if (parseErr) {
                                    log.error('error in parsing the response from xml2js: ', parseErr);
                                    return cb(parseErr);
                                }
                                log.debug('GET Api results: instanceof: ', typeof results);
                                return cb(null, res.statusCode, res.headers, results);
                            });
                        }
                    } else {
                        let errMsg = 'Error in aws GET api invocation: ' + res.statusCode + responseBody
                        log.error(errMsg);
                        return cb(new Error(errMsg));
                    }
                } catch (err) {
                    log.error('error occurred in extracting the response from aws GET api result: ', err.message);
                    return cb(err);
                }
            } else {
                let data = {};
                return cb(null, res.statusCode, res.headers, data);
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('error response received in aws GET api invocation call: ', JSON.parse(error));
            } else {
                log.error('error response received in aws GET api invocation call : ', error);
            }
            return cb(error);
        });
    });

    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'socket timeout error occurred while trying to invoke aws GET api : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'Error occurred while trying to invoke aws GET api : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

module.exports = {
    callSsoS3Get: callSsoS3Get
}
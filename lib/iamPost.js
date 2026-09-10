const { https } = require('follow-redirects')
const { randomUUID: uuidv4 } = require('crypto');
let TIMEOUT = 600000;

const crypto =require('crypto')
let sigv4 = require('./sigv4');
const { parseString } = require('xml2js')
let redact = require('./redact');
let awsSigningName = require('./awsSigningName');
let log = require('./logger').create('iamPost');
let algorithm = 'AWS4-HMAC-SHA256'

const FORM_URL_ENCODED_UTF8 = 'application/x-www-form-urlencoded;charset=UTF-8';
const FORM_URL_ENCODED_UTF8_2 = 'application/x-www-form-urlencoded; charset=UTF-8';
const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';
const FORM_URL_ENCODED = 'application/x-www-form-urlencoded';

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function callIamPost(options, iamUserCredentials, cb) {
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

    let host = options['host'];
    // The credential scope names the service's SigV4 *signing name*, which is not
    // always the leading label of the hostname: bedrock-runtime signs as 'bedrock',
    // and signing the host prefix instead earns a 401 that reads like a credential
    // problem. lib/awsSigningName.js owns that derivation for all four signers.
    let signingTarget = awsSigningName.resolveSigningTarget(host);
    if (signingTarget.error) {
        return cb(new Error(signingTarget.error));
    }
    let serviceName = signingTarget.serviceName;
    let region = signingTarget.region;

    let amzDates = sigv4.amzDates();
    let dateTimeStamp = amzDates.amzDate;
    let dateStamp = amzDates.dateStamp;
    let requestDateTime = dateTimeStamp;
    log.debug('requestDateTime is: [' + requestDateTime + '] and dateStamp is: [' + dateStamp + ']');
    let amzSdkInvocationId = uuidv4();
    let amzSdkRequest = 'attempt=1; max=4';
    let awsRequestTerminator = 'aws4_request'

    let payload = '';
    if (options['body'] && options['headers'] && options['headers']['content-type'] &&
        (options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8.toLowerCase() ||
            options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8_2.toLowerCase() ||
            options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED_UTF8_3.toLowerCase() ||
            options['headers']['content-type'].toLowerCase() === FORM_URL_ENCODED.toLowerCase())) {
        let payloadParts = options['body'].split('&');
        if (payloadParts.length >= 1) {
            let payloadSubParts = payloadParts[0].split('=');
            payload += encodeURIComponent(payloadSubParts[0]) + '=' + encodeURIComponent(payloadSubParts[1]);
        }
        for (let i = 1; i < payloadParts.length; i++) {
            let payloadSubParts = payloadParts[i].split('=');
            payload += '&' + encodeURIComponent(payloadSubParts[0]) + '=' + encodeURIComponent(payloadSubParts[1]);
        }
    } else {
        payload = options['body'];
    }
    if (payload == undefined) {
        payload = '';
    }
    log.debug('final payload generated is: ', payload);

    let hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
    log.debug('hashedPayload: [', hashedPayload, ']')
    let contentLength = payload.length

    let accessKeyId = iamUserCredentials.accessKeyId;
    let secretAccessKey = iamUserCredentials.secretAccessKey;

    let sortedHeaders = [
        'amz-sdk-invocation-id',
        'amz-sdk-request',
        'content-length',
        //'content-type',
        'host',
        'x-amz-content-sha256',
        'x-amz-date'
    ];
    if (options['headers']) {
        sortedHeaders.push.apply(sortedHeaders, Object.keys(options['headers']))
    }
    // remove duplicate headers if any.
    sortedHeaders.filter((value, index) => sortedHeaders.indexOf(value) === index);
    sortedHeaders = sortedHeaders.sort();


    let headersToBeProcessed = {
        'amz-sdk-invocation-id': amzSdkInvocationId,
        'amz-sdk-request': amzSdkRequest,
        'content-length': contentLength,
        //'content-type': contentType,
        'host': host,
        'x-amz-content-sha256': hashedPayload,
        'x-amz-date': requestDateTime
    };
    // add headers passed in the request.
    if (options['headers']) {
        let counter = 0;
        let headersArr = Object.keys(options['headers'])
        for (counter in headersArr) {
            let headerName = headersArr[counter];
            headersToBeProcessed[headerName] = options['headers'][headerName];
        }
    }

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
    signedHeaders = signedHeaders.substring(0, signedHeaders.length -1);

    let canonicalRequest = options['method'].toUpperCase() + '\n' +
        canonicalUriPath+ '\n' +
        canonicalQueryString + '\n' +
        canonicalHeaders + '\n' +
        signedHeaders + '\n' +
        hashedPayload
    // The canonical headers include x-amz-security-token, so the raw block is a credential.
    log.debug('canonicalRequest: [', redact.redactCanonicalRequest(canonicalRequest), ']')
    let hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    log.debug('canonical request hash: [', hashedCanonicalRequest, ']')

    let credentialScope = dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator
    let stringToSign = algorithm + '\n' +
        requestDateTime + '\n' +
        credentialScope + '\n' +
        hashedCanonicalRequest
    log.debug('string to sign: [', stringToSign, ']')
    let kSecret = 'AWS4' + secretAccessKey;
    let kDate = crypto.createHmac('sha256', kSecret).update(dateStamp).digest(undefined)
    let kRegion = crypto.createHmac('sha256', kDate).update(region).digest(undefined)
    let kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest(undefined)
    let kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest(undefined)
    let signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
    log.debug('signature: [', redact.maskIdentifier(signature), ']')

    let credential = 'Credential=' + accessKeyId + '/' + dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator
    let authorizationHeader = algorithm + ' ' + credential + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    log.debug(redact.redactText(authorizationHeader))

    let headers = {};
    Object.assign(headers, options['headers']);
    Object.assign(headers, headersToBeProcessed);
    headers['Authorization'] = authorizationHeader;
    invokeIamAwsApi(headers, payload, options['method'].toUpperCase(), options['path'],(awsApiErr, responseStatusCode, responseHeaders, data) => {
        if (awsApiErr) {
            return cb(awsApiErr);
        }
        return cb(null, responseStatusCode, responseHeaders, data);
    });
}

function invokeIamAwsApi(headers, payload, method, path, cb) {
    log.debug('iam post: passed headers: ', redact.forLog(headers));
    let host = headers['host']
    delete headers['host'];
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
                    log.debug('iam post: aws api invocation response status: ', res.statusCode);
                    if (res.statusCode == 200 || res.statusCode == 201) {
                        log.debug('success response from iam aws POST api invocation');
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
                        let errMsg = 'iam post: Error in aws api invocation: ' + res.statusCode + responseBody
                        log.error(errMsg);
                        return cb(new Error(errMsg));
                    }
                } catch (err) {
                    log.error('iam post: error occurred in extracting the response from aws api result: ', err.message);
                    return cb(err);
                }
            } else {
                return cb(new Error('iam post: aws api response is empty.'))
            }
        });

        res.on("error", (error) => {
            if (error instanceof Object) {
                log.error('iam post: error response received in aws api invocation call: ', JSON.parse(error));
            } else {
                log.error('iam post: error response received in aws api invocation call : ', error);
            }
            return cb(error);
        });
    });

    let postData = payload;

    req.write(postData);


    req.on('socket', function (socket) {
        socket.setTimeout(TIMEOUT);
        socket.on('timeout', function() {
            let message = 'iam post: socket timeout error occurred while trying to invoke aws api : ' + options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'];
            log.warn(message);
            req.abort();
        });
    });

    req.on('error', function(err) {
        let message = 'iam post: Error occurred while trying to invoke aws api : ' +
            options['protocol'] + '//' + options['hostname'] + ':' + options['port'] +  options['path'] +
            ' [' + err.code + '] : ' + err.message;
        log.error(message);
        log.debug(err);
        return cb(new Error(message));
    });

    req.end();
}

module.exports = {
    callIamPost: callIamPost
}
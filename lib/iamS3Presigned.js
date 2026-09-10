const { https } = require('follow-redirects')
let TIMEOUT = 600000;

const crypto =require('crypto')
const { parseString } = require('xml2js')
let redact = require('./redact');
const tinyUrlUtils = require("./tinyUrlUtils");
let sigv4 = require('./sigv4');
let log = require('./logger').create('iamS3Presigned');

const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function callIamS3Presigned(options, iamUserCredentials, cb) {
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

    let accessKeyId = iamUserCredentials.accessKeyId;
    let secretAccessKey = iamUserCredentials.secretAccessKey;

    let amzDates = sigv4.amzDates();
    let dateTimeStamp = amzDates.amzDate;
    let dateStamp = amzDates.dateStamp;
    let requestDateTime = dateTimeStamp;
    log.debug('requestDateTime is: [' + requestDateTime + '] and dateStamp is: [' + dateStamp + ']')
    let awsRequestTerminator = 'aws4_request'

    // there is no payload in presigned request, hence hashed payload is created using empty string.
    let payload = ''
    let hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
    log.debug('hashedPayload: [', hashedPayload, ']')
    if (serviceName.toLowerCase() === 's3') {
        hashedPayload = 'UNSIGNED-PAYLOAD';
    }


    // canonical headers are built using the format: <header_name>:<header_value>\n
    // And there is a \n at the end.
    let canonicalHeaders = 'host:' + host + '\n';
    log.debug('canonicalHeaders: --start\n' +  redact.redactCanonicalRequest(canonicalHeaders) + '\n--complete')

    // signedHeaders are sorted headers separated by semi-colon (;) and there is
    // no semi-colon at the end.
    let signedHeaders = 'host';




    let credentialScope = dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator
    let credential = accessKeyId + '/' + dateStamp + '/' + region + '/' + serviceName + '/' + awsRequestTerminator
    let expiresIn = 3600;
    let algorithmName = 'X-Amz-Algorithm'
    let credentialName = 'X-Amz-Credential'
    let dateName = 'X-Amz-Date'
    let expiresInName = 'X-Amz-Expires'
    if (options['headers'] && options['headers'][expiresInName.toLowerCase()]) {
        log.debug('expiresInName header provided: ', options['headers'][expiresInName.toLowerCase()], ' . overriding the value with this.');
        expiresIn = options['headers'][expiresInName.toLowerCase()];
    }
    let signatureName = 'X-Amz-Signature'
    let signedHeadersName = 'X-Amz-SignedHeaders'

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
    let encodedAlgorithm = encodeRFC3986URIComponent(algorithm);
    let queryName = encodeRFC3986URIComponent(algorithmName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedAlgorithm;

    let encodedCredential = encodeRFC3986URIComponent(credential);
    queryName = encodeRFC3986URIComponent(credentialName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedCredential;

    let encodedRequestDateTime = encodeRFC3986URIComponent(requestDateTime);
    queryName = encodeRFC3986URIComponent(dateName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedRequestDateTime;

    let encodedExpiresIn= encodeRFC3986URIComponent(expiresIn);
    queryName = encodeRFC3986URIComponent(expiresInName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedExpiresIn;


    let encodedSignedHeaders = encodeRFC3986URIComponent(signedHeaders);
    queryName = encodeRFC3986URIComponent(signedHeadersName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedSignedHeaders;

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
    let hashedCanonicalRequest = sigv4.sha256Hex(canonicalRequest)
    log.debug('canonical request hash: [', hashedCanonicalRequest, ']');

    let stringToSign = algorithm + '\n' +
        requestDateTime + '\n' +
        credentialScope + '\n' +
        hashedCanonicalRequest
    log.debug('string to sign: [\n' +  stringToSign +  '\n]');
    let signature = sigv4.sign(secretAccessKey, dateStamp, region, serviceName, stringToSign)
    log.debug('signature: [\n' + redact.maskIdentifier(signature) + '\n]')

    let _preSignedLongUrl = 'https://' + host + pathname + '?' +
        canonicalQueryString + '&' +
        encodeRFC3986URIComponent(signatureName) + "=" + signature;
    tinyUrlUtils.createTinyUrl(options['userName'], _preSignedLongUrl, (tinyUrlErr, tinyUrl) => {
        if (tinyUrlErr) {
            log.error('Error in tiny url creation: ', tinyUrlErr);
            tinyUrl = _preSignedLongUrl;
        }
        let preSignedUrl = '<html><body>' +
            '<a href=' + tinyUrl + ' target="_blank" rel="noopener noreferrer">' + tinyUrl + '</a>' +
            '</body></html>'
        let data = {
            'preSignedUrl': preSignedUrl
        }
        return cb(null, 0, {}, data);
    });
}

module.exports = {
    callIamS3Presigned: callIamS3Presigned
}
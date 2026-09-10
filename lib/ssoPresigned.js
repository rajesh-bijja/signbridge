const { https } = require('follow-redirects')
let TIMEOUT = 600000;

const crypto =require('crypto')
const { parseString } = require('xml2js')
let redact = require('./redact');
let awsSigningName = require('./awsSigningName');
let tinyUrlUtils = require('./tinyUrlUtils');
let expiryUtils = require('./expiryUtils');
let sigv4 = require('./sigv4');
let log = require('./logger').create('ssoPresigned');

const FORM_URL_ENCODED_UTF8_3 = 'application/x-www-form-urlencoded; charset=utf-8';

function encodeRFC3986URIComponent(str) {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function callSsoPresigned(options, roleCredentials, cb) {
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

    let accessKeyId = roleCredentials.accessKeyId;
    let secretAccessKey = roleCredentials.secretAccessKey;
    let xAmzSecurityToken = roleCredentials.sessionToken;

    let amzDates = sigv4.amzDates();
    let dateTimeStamp = amzDates.amzDate;
    let dateStamp = amzDates.dateStamp;
    let requestDateTime = dateTimeStamp;
    log.debug('requestDateTime is: [' + requestDateTime + '] and dateStamp is: [' + dateStamp + ']')
    let awsRequestTerminator = 'aws4_request'

    // Payload hashing for the presigned URL depends on the service and method:
    //  - S3 (any method): sign UNSIGNED-PAYLOAD. S3 explicitly supports it, and
    //    the eventual body (e.g. a file upload) is not known at presign time.
    //  - GET: no body — sign the hash of the empty payload.
    //  - Other services with a body-bearing method (EC2 and the AWS
    //    "query-protocol" APIs): these REJECT UNSIGNED-PAYLOAD, and the operation
    //    itself lives in the body (e.g. Action=DescribeInstances). Sign sha256 of
    //    the exact body so the presigned URL authenticates when the caller sends
    //    that same body. The body is hashed verbatim because that is exactly what
    //    the copied "Copy Request as Curl" command sends via --data-raw.
    //  - Body-bearing method but no body supplied: fall back to UNSIGNED-PAYLOAD.
    let payload = ''
    let hashedPayload;
    if (serviceName.toLowerCase() === 's3') {
        hashedPayload = 'UNSIGNED-PAYLOAD';
    } else if (options['method'].toLowerCase() === 'get') {
        hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
    } else if (options['body']) {
        payload = options['body'];
        hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
    } else {
        hashedPayload = 'UNSIGNED-PAYLOAD';
    }
    log.debug('hashedPayload: [', hashedPayload, ']')


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
    let expiresInName = 'X-Amz-Expires';
    if (options['headers'] && options['headers'][expiresInName.toLowerCase()]) {
        log.debug('expiresInName header provided: ', options['headers'][expiresInName.toLowerCase()], ' . overriding the value with this.');
        expiresIn = options['headers'][expiresInName.toLowerCase()];
    }
    // A request signed with temporary SSO credentials is valid only until the
    // EARLIER of X-Amz-Expires and the session token's own expiration. Advertising
    // a full hour when the token dies sooner yields a URL that fails with
    // "AuthFailure" long before X-Amz-Expires. Cap it to the credential's real
    // remaining lifetime (roleCredentials.expiration is epoch milliseconds).
    let cappedExpiresIn = expiryUtils.capExpiryToCredentialLife(expiresIn, roleCredentials, Date.now());
    if (cappedExpiresIn !== expiresIn) {
        log.debug('capping X-Amz-Expires from [' + expiresIn + '] to credential remaining life [' + cappedExpiresIn + '] seconds');
        expiresIn = cappedExpiresIn;
    }
    let securityTokenName = 'X-Amz-Security-Token'
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

    let encodedXAmzSecurityToken = encodeRFC3986URIComponent(xAmzSecurityToken);
    queryName = encodeRFC3986URIComponent(securityTokenName);
    queryNames.push(queryName);
    queriesToBeProcessed[queryName] = encodedXAmzSecurityToken;

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
    callSsoPresigned: callSsoPresigned
}
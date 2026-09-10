"use strict";

// Which service name goes into the SigV4 credential scope.
//
// For most of AWS the answer is the first label of the hostname, which is why
// every signer here derived it that way — `dynamodb.us-east-1.amazonaws.com` is
// signed as `dynamodb`. But the hostname carries the service's *endpoint prefix*,
// and a service's *signing name* is a separate field in its botocore model. When
// the two differ, signing the host prefix produces a request AWS rejects with
//
//     Credential should be scoped to correct service: 'bedrock'.
//
// which reads like a credential problem and is not one. Bedrock is the case that
// surfaced it: `bedrock-runtime.<region>.amazonaws.com` signs as `bedrock`, and
// with the host prefix every call to it failed 401 no matter which profile type
// minted the credentials.
//
// So the derivation lives here once, as a pure function over the hostname, with a
// table of the services whose signing name is not their endpoint prefix.
//
// Known limitation, unchanged from before this module existed: an endpoint prefix
// containing a dot (`streams.dynamodb`, `api.ecr`, `metering.marketplace`,
// `data.iot`, `portal.sso`) makes a five-label hostname, which is only accepted
// for S3. Those hosts are rejected with the message below rather than mis-signed.

// endpoint prefix (the leading hostname label) -> SigV4 signing name.
//
// Sourced from the `signingName` field of the botocore service models. Only
// entries where signingName differs from endpointPrefix belong here; anything
// absent falls through to the hostname label, which is correct for the rest of
// AWS. Keep it to services whose model has actually been checked — a wrong guess
// here breaks a service that works today.
const SIGNING_NAME_OVERRIDES = {
    // All three Bedrock data/agent planes sign as the control plane's name.
    'bedrock-runtime': 'bedrock',
    'bedrock-agent': 'bedrock',
    'bedrock-agent-runtime': 'bedrock',
    // SES: the endpoint has always been email.<region>.amazonaws.com.
    'email': 'ses',
    // IAM Identity Center's OIDC service (the device-authorization flow).
    'oidc': 'awsssooidc'
};

const DEFAULT_REGION = 'us-east-1';

function unsupportedHostMessage(host) {
    return 'hostname provided: [' + host + ']' + '. ' +
        'Supported hostname format are: [[service-code].[region-code].amazonaws.com] or ' +
        '[[bucket].s3.[region-code].amazonaws.com] or [[service-code].amazonaws.com] for S3';
}

// Returns { endpointPrefix, serviceName, region } for a supported host, or
// { error: <message> } for one of the shapes SigV4 cannot be derived from.
// `serviceName` is what belongs in the credential scope; `endpointPrefix` is kept
// so a caller can tell the two apart (the presigners branch on S3, and a log line
// naming both is the difference between a five-minute and a five-hour debug).
function resolveSigningTarget(host) {
    let hostName = String(host === null || host === undefined ? '' : host);
    let hostParts = hostName.split('.');
    let endpointPrefix = '';
    let region = DEFAULT_REGION;

    if (hostParts.length == 4) {
        if (hostParts[1].toLowerCase() === 's3') {
            endpointPrefix = hostParts[1].toLowerCase();
        } else {
            endpointPrefix = hostParts[0].toLowerCase();
            region = hostParts[1].toLowerCase();
        }
    } else if (hostParts.length == 3) {
        endpointPrefix = hostParts[0].toLowerCase();
    } else if (hostParts.length == 5 && hostParts[1].toLowerCase() === 's3') {
        endpointPrefix = hostParts[1].toLowerCase();
        region = hostParts[2].toLowerCase();
    } else {
        return { error: unsupportedHostMessage(hostName) };
    }

    return {
        endpointPrefix: endpointPrefix,
        serviceName: signingNameFor(endpointPrefix),
        region: region
    };
}

// The signing name for an endpoint prefix. Exported on its own because callers
// that already know their service (the Bedrock chat client names `bedrock`
// directly) should not have to synthesise a hostname to ask.
function signingNameFor(endpointPrefix) {
    let prefix = String(endpointPrefix === null || endpointPrefix === undefined
        ? '' : endpointPrefix).toLowerCase();
    return SIGNING_NAME_OVERRIDES[prefix] || prefix;
}

module.exports = {
    resolveSigningTarget: resolveSigningTarget,
    signingNameFor: signingNameFor,
    unsupportedHostMessage: unsupportedHostMessage,
    // Exported for tests: the table is the whole point of the module.
    SIGNING_NAME_OVERRIDES: SIGNING_NAME_OVERRIDES,
    DEFAULT_REGION: DEFAULT_REGION
};

"use strict";

// IRSA (IAM Roles for Service Accounts) credentials.
//
// An IRSA profile borrows a *base* AWS profile (IAM user or SSO) purely to reach
// the EKS control plane, then swaps identities: it mints a Kubernetes
// service-account token for the audience the role's trust policy demands and
// exchanges it for role credentials via sts:AssumeRoleWithWebIdentity. What comes
// back is the same temporary-credential triple SSO and EC2 produce, so every
// signer downstream is unchanged.
//
// NO kubectl, NO jq, NO kubeconfig. The equivalent CLI recipe is
//   aws eks update-kubeconfig --name <cluster>
//   kubectl get sa -A -o json | jq ...
//   kubectl create token <sa> -n <ns> --audience sts.amazonaws.com
// but every one of those is a thin client of an HTTP API we can call directly:
//   * eks:DescribeCluster gives the API-server endpoint and its CA certificate.
//   * The API server accepts a bearer token of the form
//     `k8s-aws-v1.<base64url(presigned sts:GetCallerIdentity URL)>` — precisely
//     what `aws eks get-token` emits — so no kubeconfig is needed.
//   * `kubectl create token` is POST .../serviceaccounts/<name>/token (TokenRequest).
// That keeps the container free of a kubectl binary to install, version-match and
// keep patched, and avoids mutating a kubeconfig shared with the user's own
// tooling. It also means IRSA works identically over MCP and chat.
//
// Pure decisions (token construction, trust-policy reading, ARN parsing) live in
// exported functions with an injectable clock, so they are unit-tested without a
// cluster.

let profileUtils = require('./profileUtils');
let expiryUtils = require('./expiryUtils');
let authConfig = require('./authConfig');
let awsSigner = require('./awsSigner');
let awsApiClient = require('./awsApiClient');
let log = require('./logger').create('irsaUtils');

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_AUDIENCE = 'sts.amazonaws.com';
const DEFAULT_TOKEN_DURATION_SECONDS = 3600;
const DEFAULT_SESSION_DURATION_SECONDS = 3600;
// `aws eks get-token` presigns GetCallerIdentity with a 60s window; the API
// server validates it immediately, so a short life is correct and safer.
const EKS_TOKEN_EXPIRY_SECONDS = 60;
const EKS_TOKEN_PREFIX = 'k8s-aws-v1.';
const CLUSTER_NAME_HEADER = 'x-k8s-aws-id';
const STS_API_VERSION = '2011-06-15';
const IAM_API_VERSION = '2010-05-08';
const K8S_PAGE_LIMIT = 500;
const IRSA_ROLE_ANNOTATION = 'eks.amazonaws.com/role-arn';

let CREDENTIAL_REFRESH_BUFFER_MS = expiryUtils.DEFAULT_REFRESH_BUFFER_MS;
if (process.env.IRSA_CREDENTIAL_REFRESH_BUFFER_MS) {
    let parsed = parseInt(process.env.IRSA_CREDENTIAL_REFRESH_BUFFER_MS, 10);
    if (!isNaN(parsed) && parsed >= 0) {
        CREDENTIAL_REFRESH_BUFFER_MS = parsed;
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(input) {
    return Buffer.from(input, 'utf8').toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Build the EKS API-server bearer token: base64url of a presigned
// sts:GetCallerIdentity URL that also signs the cluster name as an
// `x-k8s-aws-id` header. The cluster's authenticator replays that URL against
// STS to learn who we are, which is why the header must be *inside* the
// signature — otherwise a token minted for one cluster would work on another.
//
// Pure and clock-injected (`now`), so tests pin the exact token bytes.
function buildEksToken(input) {
    let region = input.region || DEFAULT_REGION;
    let presigned = awsSigner.presignUrl({
        credentials: input.credentials,
        region: region,
        service: 'sts',
        method: 'GET',
        host: input.stsHost || awsApiClient.stsHost(region),
        path: '/',
        query: {
            'Action': 'GetCallerIdentity',
            'Version': STS_API_VERSION
        },
        extraSignedHeaders: (() => {
            let headers = {};
            headers[CLUSTER_NAME_HEADER] = input.clusterName;
            return headers;
        })(),
        expiresInSeconds: input.expiresInSeconds || EKS_TOKEN_EXPIRY_SECONDS,
        now: input.now
    });
    return {
        token: EKS_TOKEN_PREFIX + base64UrlEncode(presigned.url),
        presignedUrl: presigned.url
    };
}

// 'arn:aws:iam::123456789012:role/path/to/name' -> { accountId, roleName: 'path/to/name' }
// IAM role names may carry a path, and iam:GetRole wants the name only (the last
// segment) — getting that wrong is a confusing NoSuchEntity.
function parseRoleArn(roleArn) {
    if (!roleArn || typeof roleArn !== 'string') {
        return null;
    }
    let match = roleArn.match(/^arn:[^:]*:iam::(\d+):role\/(.+)$/);
    if (!match) {
        return null;
    }
    let fullPath = match[2];
    let segments = fullPath.split('/');
    return {
        accountId: match[1],
        roleName: segments[segments.length - 1],
        rolePath: segments.length > 1 ? '/' + segments.slice(0, -1).join('/') + '/' : '/',
        arn: roleArn
    };
}

function asArray(value) {
    if (value == null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

// Read a role's trust policy and report what it actually requires: which
// audiences, which service-account subjects, and which OIDC providers are
// federated. This is what turns "assume failed" into "this role trusts
// system:serviceaccount:assistants:api-service, not the one you picked".
//
// Pure: takes the already-decoded policy document object.
function extractTrustPolicyFacts(policyDocument) {
    let facts = {
        audiences: [],
        subjects: [],
        oidcProviders: [],
        hasWebIdentityStatement: false
    };
    if (!policyDocument) {
        return facts;
    }
    asArray(policyDocument.Statement).forEach((statement) => {
        if (!statement || String(statement.Effect || '').toLowerCase() !== 'allow') {
            return;
        }
        let actions = asArray(statement.Action).map((a) => String(a));
        if (!actions.some((a) => /^sts:AssumeRoleWithWebIdentity$/i.test(a) || a === 'sts:*' || a === '*')) {
            return;
        }
        facts.hasWebIdentityStatement = true;
        let federated = statement.Principal && statement.Principal.Federated;
        asArray(federated).forEach((provider) => {
            if (provider && facts.oidcProviders.indexOf(provider) < 0) {
                facts.oidcProviders.push(String(provider));
            }
        });
        // Conditions may use StringEquals or StringLike; both matter, and the keys
        // are provider-qualified (oidc.eks.<region>.amazonaws.com/id/<id>:aud), so
        // match on the suffix rather than the full key.
        ['StringEquals', 'StringLike'].forEach((operator) => {
            let condition = statement.Condition && statement.Condition[operator];
            if (!condition) {
                return;
            }
            Object.keys(condition).forEach((key) => {
                let values = asArray(condition[key]).map((v) => String(v));
                if (/:aud$/.test(key)) {
                    values.forEach((v) => {
                        if (facts.audiences.indexOf(v) < 0) { facts.audiences.push(v); }
                    });
                } else if (/:sub$/.test(key)) {
                    values.forEach((v) => {
                        if (facts.subjects.indexOf(v) < 0) { facts.subjects.push(v); }
                    });
                }
            });
        });
    });
    return facts;
}

// The audience to ask Kubernetes for. The trust policy is authoritative; fall
// back to sts.amazonaws.com (what EKS configures by default) when the policy
// pins none. Pure.
function resolveAudience(facts, override) {
    if (override) {
        return override;
    }
    if (facts && facts.audiences.length) {
        // Prefer the conventional one when the policy allows several.
        if (facts.audiences.indexOf(DEFAULT_AUDIENCE) >= 0) {
            return DEFAULT_AUDIENCE;
        }
        return facts.audiences[0];
    }
    return DEFAULT_AUDIENCE;
}

function serviceAccountSubject(namespace, serviceAccount) {
    return 'system:serviceaccount:' + namespace + ':' + serviceAccount;
}

// Does the role actually trust this service account? Returns
// { ok, message, expectedSubjects }. A `*` in a StringLike subject is honoured.
// Pure — this is a pre-flight check, so it must be exactly right about what it
// claims, and it never blocks: the caller surfaces it as a warning and still
// attempts the assume, because a trust policy we cannot read (no iam:GetRole
// permission) is common and not fatal.
function checkSubjectTrusted(facts, namespace, serviceAccount) {
    let subject = serviceAccountSubject(namespace, serviceAccount);
    if (!facts || !facts.subjects.length) {
        return {
            ok: true,
            unknown: true,
            subject: subject,
            message: 'The role\'s trust policy does not pin a service-account subject (or could not be read), ' +
                'so it was not verified.'
        };
    }
    let matched = facts.subjects.some((pattern) => {
        if (pattern.indexOf('*') < 0) {
            return pattern === subject;
        }
        let regex = new RegExp('^' + pattern.split('*').map((part) => {
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('.*') + '$');
        return regex.test(subject);
    });
    if (matched) {
        return { ok: true, subject: subject, message: 'The role trusts ' + subject + '.' };
    }
    return {
        ok: false,
        subject: subject,
        expectedSubjects: facts.subjects,
        message: 'This role does not trust ' + subject + '. Its trust policy allows: ' +
            facts.subjects.join(', ') + '.'
    };
}

// The TokenRequest body — the API form of `kubectl create token <sa> -n <ns>
// --audience <aud> --duration <n>s`. Pure.
function buildTokenRequestBody(audience, expirationSeconds) {
    return JSON.stringify({
        apiVersion: 'authentication.k8s.io/v1',
        kind: 'TokenRequest',
        spec: {
            audiences: [audience || DEFAULT_AUDIENCE],
            expirationSeconds: expirationSeconds || DEFAULT_TOKEN_DURATION_SECONDS
        }
    });
}

// Reduce a Kubernetes ServiceAccount list to the IRSA-annotated ones. Pure, and
// the direct equivalent of the `jq` filter in the manual recipe.
function serviceAccountsFromK8sItems(items) {
    let out = [];
    asArray(items).forEach((item) => {
        let metadata = item && item.metadata;
        let annotations = metadata && metadata.annotations;
        let roleArn = annotations && annotations[IRSA_ROLE_ANNOTATION];
        if (!roleArn) {
            return;
        }
        out.push({
            namespace: metadata.namespace,
            name: metadata.name,
            roleArn: roleArn
        });
    });
    out.sort((a, b) => {
        if (a.namespace !== b.namespace) {
            return a.namespace < b.namespace ? -1 : 1;
        }
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    return out;
}

// STS AssumeRoleWithWebIdentity credentials -> SignBridge credential shape.
function toRoleCredentials(stsCredentials, extra) {
    let expirationMs = Date.parse(stsCredentials.Expiration);
    let creds = {
        accessKeyId: stsCredentials.AccessKeyId,
        secretAccessKey: stsCredentials.SecretAccessKey,
        sessionToken: stsCredentials.SessionToken,
        expiration: isNaN(expirationMs) ? null : expirationMs,
        expirationReadable: stsCredentials.Expiration || null,
        source: 'irsa'
    };
    return Object.assign(creds, extra || {});
}

function maskCredentials(roleCredentials) {
    if (!roleCredentials) {
        return null;
    }
    let accessKeyId = roleCredentials.accessKeyId || '';
    return {
        accessKeyId: accessKeyId ? accessKeyId.slice(0, 4) + '****' + accessKeyId.slice(-4) : null,
        secretAccessKey: '********',
        sessionToken: '********',
        expiration: roleCredentials.expiration || null,
        expirationReadable: roleCredentials.expirationReadable || null,
        assumedRoleArn: roleCredentials.assumedRoleArn || null
    };
}

// The API-server host from an EKS cluster endpoint URL. Pure.
function endpointHost(endpoint) {
    if (!endpoint) {
        return null;
    }
    return String(endpoint).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function decodeCertificateAuthority(certificateAuthorityData) {
    if (!certificateAuthorityData) {
        return null;
    }
    return Buffer.from(certificateAuthorityData, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// AWS / Kubernetes calls
// ---------------------------------------------------------------------------

// Resolve the credentials of the *base* profile — the account access used to
// reach EKS and IAM. Requiring this lazily breaks the require cycle
// (credentialProvider -> irsaUtils -> credentialProvider); it is the one seam
// every AWS mode goes through, so IRSA can itself be backed by an SSO profile,
// an IAM user, or even an EC2 instance profile.
function resolveBaseCredentials(userName, profile, cb) {
    let baseProfileName = profile.irsaBaseProfileName;
    if (!baseProfileName) {
        let err = new Error('This IRSA profile has no base AWS profile. Choose the AWS profile that has access to ' +
            'the EKS cluster\'s account.');
        err.statusCode = 400;
        return cb(err);
    }
    let credentialProvider = require('./credentialProvider');
    credentialProvider.resolveByProfileName(userName || profile.userName, baseProfileName,
        profile.irsaBaseAuthnMode, (err, resolved) => {
            if (err) {
                // Pass the diagnosis through untouched (including SSO authorize
                // links) but name the profile that actually needs attention.
                err.message = 'Base AWS profile "' + baseProfileName + '" could not provide credentials. ' + err.message;
                return cb(err);
            }
            return cb(null, resolved);
        });
}

// eks:ListClusters — GET /clusters (paginated by nextToken).
function listClusters(credentials, region, cb) {
    let clusters = [];
    let fetchPage = (nextToken) => {
        let query = { 'maxResults': '100' };
        if (nextToken) {
            query['nextToken'] = nextToken;
        }
        awsApiClient.callSigned({
            credentials: credentials,
            region: region,
            service: 'eks',
            method: 'GET',
            path: '/clusters',
            query: query
        }, (err, response) => {
            if (err) {
                return cb(err);
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
                return cb(awsApiClient.toAwsError('eks:ListClusters', response));
            }
            let parsed;
            try {
                parsed = JSON.parse(response.body);
            } catch (parseErr) {
                return cb(new Error('eks:ListClusters returned an unreadable response.'));
            }
            clusters = clusters.concat(parsed.clusters || []);
            if (parsed.nextToken) {
                return fetchPage(parsed.nextToken);
            }
            return cb(null, clusters);
        });
    };
    fetchPage(null);
}

// eks:DescribeCluster — the API-server endpoint and CA. cb(err, { host, caPem, cluster })
function describeCluster(credentials, region, clusterName, cb) {
    awsApiClient.callSigned({
        credentials: credentials,
        region: region,
        service: 'eks',
        method: 'GET',
        path: '/clusters/' + clusterName
    }, (err, response) => {
        if (err) {
            return cb(err);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            return cb(awsApiClient.toAwsError('eks:DescribeCluster (' + clusterName + ')', response));
        }
        let parsed;
        try {
            parsed = JSON.parse(response.body);
        } catch (parseErr) {
            return cb(new Error('eks:DescribeCluster returned an unreadable response.'));
        }
        let cluster = parsed.cluster || {};
        let host = endpointHost(cluster.endpoint);
        let caPem = decodeCertificateAuthority(cluster.certificateAuthority && cluster.certificateAuthority.data);
        if (!host || !caPem) {
            return cb(new Error('Cluster "' + clusterName + '" did not report an endpoint and CA certificate. ' +
                'Its status is ' + (cluster.status || 'unknown') + '.'));
        }
        return cb(null, {
            host: host,
            caPem: caPem,
            cluster: {
                name: cluster.name,
                status: cluster.status,
                version: cluster.version,
                endpoint: cluster.endpoint,
                oidcIssuer: cluster.identity && cluster.identity.oidc && cluster.identity.oidc.issuer
            }
        });
    });
}

// A cluster 403 is the single most common IRSA failure, and "you are not
// authorized" is useless on its own: the two calls SignBridge makes need
// *different* Kubernetes RBAC verbs, so which one was refused tells the user
// which rule is missing. Listing service accounts can succeed while minting a
// token is refused (creating a token is a `create` on the `serviceaccounts/token`
// subresource, which read-only cluster roles like `view` do not include) — so the
// message must not lump them together and send someone to fix an access entry
// that is already correct. Pure, so it is unit-testable without a cluster.
//
// `intent` is what the caller was doing: 'list-service-accounts' | 'create-token'.
function describeK8sForbidden(input) {
    let statusCode = input.statusCode;
    let detail = input.detail ? ' ' + String(input.detail).trim() : '';
    let what = input.intent === 'create-token'
        ? 'The cluster refused to mint a token for service account ' +
            (input.namespace || '?') + '/' + (input.serviceAccount || '?')
        : 'The cluster rejected the request';
    let message = what + ' (HTTP ' + statusCode + ').' + detail;

    if (statusCode === 401) {
        // 401 means the bearer token itself was not accepted — the identity is
        // not mapped at all, which is a different fix from a missing verb.
        return message + ' The base AWS identity is not recognised by the cluster at all: map it in ' +
            'the cluster\'s EKS access entries (or the aws-auth ConfigMap) first.';
    }
    if (input.intent === 'create-token') {
        return message + ' The identity IS mapped in the cluster (listing service accounts works), ' +
            'but it lacks the "create" verb on the "serviceaccounts/token" subresource in namespace "' +
            (input.namespace || '?') + '". Read-only cluster roles such as "view" do not include it. ' +
            'A cluster admin can grant it with a Role in that namespace — apiGroups: [""], resources: ' +
            '["serviceaccounts/token"], verbs: ["create"] (optionally resourceNames: ["' +
            (input.serviceAccount || 'my-service-account') + '"]) — bound to this identity with a RoleBinding.';
    }
    return message + ' The base AWS identity must be mapped in the cluster\'s EKS access entries ' +
        '(or the aws-auth ConfigMap) with permission to read service accounts.';
}

// A Kubernetes API call with a freshly minted EKS bearer token.
function kubernetesCall(credentials, region, clusterName, connection, options, cb) {
    let tokenInfo;
    try {
        tokenInfo = buildEksToken({
            credentials: credentials,
            region: region,
            clusterName: clusterName
        });
    } catch (tokenErr) {
        return cb(tokenErr);
    }
    awsApiClient.callKubernetes({
        host: connection.host,
        caPem: connection.caPem,
        token: tokenInfo.token,
        method: options.method || 'GET',
        path: options.path,
        body: options.body
    }, (err, response) => {
        if (err) {
            return cb(new Error('Could not reach the Kubernetes API server for cluster "' + clusterName +
                '" at ' + connection.host + ': ' + err.message +
                '. If the cluster endpoint is private, SignBridge must run inside the VPC (or on the VPN).'));
        }
        if (response.statusCode === 401 || response.statusCode === 403) {
            let detail = '';
            try {
                let parsed = JSON.parse(response.body);
                detail = parsed.message ? ' ' + parsed.message : '';
            } catch (parseErr) {
                detail = '';
            }
            let authErr = new Error(describeK8sForbidden({
                statusCode: response.statusCode,
                detail: detail,
                intent: options.intent,
                namespace: options.namespace,
                serviceAccount: options.serviceAccount
            }));
            authErr.statusCode = response.statusCode;
            return cb(authErr);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            let message = 'Kubernetes API call failed (HTTP ' + response.statusCode + ')';
            try {
                let parsed = JSON.parse(response.body);
                if (parsed.message) {
                    message += ': ' + parsed.message;
                }
            } catch (parseErr) {
                message += ': ' + String(response.body).slice(0, 300);
            }
            let apiErr = new Error(message);
            apiErr.statusCode = response.statusCode;
            return cb(apiErr);
        }
        let parsed;
        try {
            parsed = JSON.parse(response.body);
        } catch (parseErr) {
            return cb(new Error('The Kubernetes API server returned an unreadable response.'));
        }
        return cb(null, parsed);
    });
}

// Every IRSA-annotated service account in the cluster, across all namespaces.
function listIrsaServiceAccounts(credentials, region, clusterName, connection, cb) {
    let collected = [];
    let fetchPage = (continueToken) => {
        let path = '/api/v1/serviceaccounts?limit=' + K8S_PAGE_LIMIT;
        if (continueToken) {
            path += '&continue=' + encodeURIComponent(continueToken);
        }
        kubernetesCall(credentials, region, clusterName, connection, {
            path: path,
            intent: 'list-service-accounts'
        }, (err, parsed) => {
            if (err) {
                return cb(err);
            }
            collected = collected.concat(serviceAccountsFromK8sItems(parsed.items));
            let next = parsed.metadata && parsed.metadata['continue'];
            if (next) {
                return fetchPage(next);
            }
            return cb(null, collected);
        });
    };
    fetchPage(null);
}

// iam:GetRole -> the URL-decoded trust policy document. Non-fatal: a caller
// without iam:GetRole still gets to assume the role, just without the pre-flight
// explanation, so this reports (err) and lets the caller decide.
function getRoleTrustPolicy(credentials, roleArn, cb) {
    let parsedArn = parseRoleArn(roleArn);
    if (!parsedArn) {
        let err = new Error('"' + roleArn + '" is not an IAM role ARN.');
        err.statusCode = 400;
        return cb(err);
    }
    let body = 'Action=GetRole&Version=' + IAM_API_VERSION +
        '&RoleName=' + awsSigner.encodeRFC3986(parsedArn.roleName);
    awsApiClient.callSigned({
        credentials: credentials,
        // IAM is global and signs against us-east-1.
        region: 'us-east-1',
        service: 'iam',
        host: 'iam.amazonaws.com',
        method: 'POST',
        path: '/',
        body: body
    }, (err, response) => {
        if (err) {
            return cb(err);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            return cb(awsApiClient.toAwsError('iam:GetRole (' + parsedArn.roleName + ')', response));
        }
        awsApiClient.parseXml(response.body, (xmlErr, parsed) => {
            if (xmlErr) {
                return cb(new Error('iam:GetRole returned an unreadable response.'));
            }
            let role = parsed && parsed.GetRoleResponse && parsed.GetRoleResponse.GetRoleResult &&
                parsed.GetRoleResponse.GetRoleResult.Role;
            if (!role || !role.AssumeRolePolicyDocument) {
                return cb(new Error('iam:GetRole did not return a trust policy for ' + parsedArn.roleName + '.'));
            }
            let document;
            try {
                document = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument));
            } catch (parseErr) {
                return cb(new Error('The trust policy for ' + parsedArn.roleName + ' could not be parsed.'));
            }
            return cb(null, {
                roleName: parsedArn.roleName,
                roleArn: role.Arn || roleArn,
                policyDocument: document,
                facts: extractTrustPolicyFacts(document)
            });
        });
    });
}

// `kubectl create token <sa> -n <ns> --audience <aud>` over the API.
function createServiceAccountToken(credentials, region, clusterName, connection, namespace, serviceAccount, audience, durationSeconds, cb) {
    let path = '/api/v1/namespaces/' + encodeURIComponent(namespace) +
        '/serviceaccounts/' + encodeURIComponent(serviceAccount) + '/token';
    kubernetesCall(credentials, region, clusterName, connection, {
        method: 'POST',
        path: path,
        body: buildTokenRequestBody(audience, durationSeconds),
        intent: 'create-token',
        namespace: namespace,
        serviceAccount: serviceAccount
    }, (err, parsed) => {
        if (err) {
            return cb(err);
        }
        let token = parsed && parsed.status && parsed.status.token;
        if (!token) {
            return cb(new Error('The cluster did not return a token for service account ' +
                namespace + '/' + serviceAccount + '.'));
        }
        return cb(null, {
            token: token,
            expirationTimestamp: parsed.status.expirationTimestamp || null
        });
    });
}

// Unsigned sts:AssumeRoleWithWebIdentity — the web identity token is the
// credential here, which is the whole point of IRSA.
function assumeRoleWithWebIdentity(region, roleArn, sessionName, webIdentityToken, durationSeconds, cb) {
    let form = [
        'Action=AssumeRoleWithWebIdentity',
        'Version=' + STS_API_VERSION,
        'RoleArn=' + awsSigner.encodeRFC3986(roleArn),
        'RoleSessionName=' + awsSigner.encodeRFC3986(sessionName),
        'DurationSeconds=' + (durationSeconds || DEFAULT_SESSION_DURATION_SECONDS),
        'WebIdentityToken=' + awsSigner.encodeRFC3986(webIdentityToken)
    ].join('&');
    awsApiClient.callUnsigned({
        region: region,
        service: 'sts',
        method: 'POST',
        path: '/',
        body: form
    }, (err, response) => {
        if (err) {
            return cb(err);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            let stsErr = awsApiClient.toAwsError('sts:AssumeRoleWithWebIdentity', response);
            if (/InvalidIdentityToken|IDPRejectedClaim/i.test(stsErr.awsErrorCode || '')) {
                stsErr.message += ' The audience in the service-account token must match the role\'s trust policy ' +
                    'condition (usually sts.amazonaws.com).';
            }
            if (/AccessDenied/i.test(stsErr.awsErrorCode || '')) {
                stsErr.message += ' The role\'s trust policy must allow this cluster\'s OIDC provider and the ' +
                    'service-account subject.';
            }
            return cb(stsErr);
        }
        awsApiClient.parseXml(response.body, (xmlErr, parsed) => {
            if (xmlErr) {
                return cb(new Error('sts:AssumeRoleWithWebIdentity returned an unreadable response.'));
            }
            let result = parsed && parsed.AssumeRoleWithWebIdentityResponse &&
                parsed.AssumeRoleWithWebIdentityResponse.AssumeRoleWithWebIdentityResult;
            let stsCredentials = result && result.Credentials;
            if (!stsCredentials || !stsCredentials.AccessKeyId) {
                return cb(new Error('sts:AssumeRoleWithWebIdentity returned no credentials.'));
            }
            return cb(null, toRoleCredentials(stsCredentials, {
                assumedRoleArn: result.AssumedRoleUser && result.AssumedRoleUser.Arn,
                subjectFromWebIdentityToken: result.SubjectFromWebIdentityToken || null,
                audience: result.Audience || null
            }));
        });
    });
}

// ---------------------------------------------------------------------------
// The credential seam
// ---------------------------------------------------------------------------

function validateIrsaProfile(profile) {
    if (!profile || !profile.irsaEnabled) {
        let err = new Error('Profile "' + ((profile && profile.profileName) || '?') + '" is not an IRSA profile.');
        err.statusCode = 400;
        return err;
    }
    let missing = [];
    if (!profile.irsaBaseProfileName) { missing.push('base AWS profile'); }
    if (!profile.irsaClusterName) { missing.push('cluster'); }
    if (!profile.irsaNamespace) { missing.push('namespace'); }
    if (!profile.irsaServiceAccount) { missing.push('service account'); }
    if (!profile.irsaRoleArn) { missing.push('role ARN'); }
    if (missing.length) {
        let err = new Error('IRSA profile "' + profile.profileName + '" is incomplete — missing: ' +
            missing.join(', ') + '. Edit the profile and pick a cluster and service account.');
        err.statusCode = 400;
        return err;
    }
    return null;
}

// Mint credentials end to end: base creds -> describe cluster -> SA token ->
// AssumeRoleWithWebIdentity. cb(err, { roleCredentials, cluster, tokenExpiration })
function mintCredentials(userName, profile, cb) {
    let region = profile.irsaRegion || profile.region || DEFAULT_REGION;
    resolveBaseCredentials(userName, profile, (baseErr, base) => {
        if (baseErr) {
            return cb(baseErr);
        }
        describeCluster(base.credentials, region, profile.irsaClusterName, (describeErr, connection) => {
            if (describeErr) {
                return cb(describeErr);
            }
            let audience = profile.irsaAudience || DEFAULT_AUDIENCE;
            createServiceAccountToken(base.credentials, region, profile.irsaClusterName, connection,
                profile.irsaNamespace, profile.irsaServiceAccount, audience,
                profile.irsaTokenDurationSeconds || DEFAULT_TOKEN_DURATION_SECONDS,
                (tokenErr, tokenInfo) => {
                    if (tokenErr) {
                        return cb(tokenErr);
                    }
                    let sessionName = profile.irsaSessionName ||
                        ('signbridge-' + profile.irsaServiceAccount).slice(0, 64);
                    assumeRoleWithWebIdentity(region, profile.irsaRoleArn, sessionName, tokenInfo.token,
                        profile.irsaSessionDurationSeconds || DEFAULT_SESSION_DURATION_SECONDS,
                        (assumeErr, roleCredentials) => {
                            if (assumeErr) {
                                return cb(assumeErr);
                            }
                            return cb(null, {
                                roleCredentials: roleCredentials,
                                cluster: connection.cluster,
                                tokenExpiration: tokenInfo.expirationTimestamp
                            });
                        });
                });
        });
    });
}

function persistCredentials(profile, roleCredentials, cb) {
    let update = {
        profileName: profile.profileName,
        userName: profile.userName || authConfig.getDefaultUserName(),
        irsaRoleCredentials: roleCredentials
    };
    profileUtils.updateProfile(update, (updateErr) => {
        if (updateErr) {
            log.warn('irsaUtils: could not cache IRSA credentials on profile ' +
                profile.profileName + ': ' + updateErr.message);
        }
        return cb(null);
    });
}

// Same contract as ssoUtils.getSecurityToken / ec2Utils.getSecurityToken.
function getSecurityToken(profile, cb) {
    let invalid = validateIrsaProfile(profile);
    if (invalid) {
        return cb(invalid);
    }
    if (expiryUtils.isSsoCredentialFresh(profile.irsaRoleCredentials, Date.now(), CREDENTIAL_REFRESH_BUFFER_MS)) {
        return cb(null, profile.irsaRoleCredentials);
    }
    mintCredentials(profile.userName, profile, (mintErr, minted) => {
        if (mintErr) {
            let err = new Error('Could not obtain IRSA credentials for profile "' + profile.profileName + '". ' +
                mintErr.message);
            err.statusCode = mintErr.statusCode || 502;
            // Preserve an SSO authorize link from the base profile so the UI can
            // still offer the Authorize button.
            if (mintErr.verificationUriComplete) {
                err.verificationUriComplete = mintErr.verificationUriComplete;
            }
            err.irsaCredentialFailure = true;
            return cb(err);
        }
        profile.irsaRoleCredentials = minted.roleCredentials;
        persistCredentials(profile, minted.roleCredentials, () => {
            return cb(null, minted.roleCredentials);
        });
    });
}

// ---------------------------------------------------------------------------
// Express handlers (discovery, used by the profile form / MCP)
// ---------------------------------------------------------------------------

function respondError(res, err, fallbackStatus) {
    return res.status(err.statusCode || fallbackStatus || 400).json({
        success: false,
        message: err.message,
        verificationUriComplete: err.verificationUriComplete
    });
}

// POST listIrsaClusters { baseProfileName, baseAuthnMode, region }
function listIrsaClustersHandler(req, res) {
    let userName = authConfig.resolveUserName();
    let body = req.body || {};
    let region = body.region || DEFAULT_REGION;
    let baseProfileName = body.baseProfileName || body.profileName;
    if (!baseProfileName) {
        return res.status(400).json({ success: false, message: 'baseProfileName is required.' });
    }
    let credentialProvider = require('./credentialProvider');
    credentialProvider.resolveByProfileName(userName, baseProfileName, body.baseAuthnMode, (credErr, resolved) => {
        if (credErr) {
            return respondError(res, credErr, 401);
        }
        listClusters(resolved.credentials, region, (listErr, clusters) => {
            if (listErr) {
                return respondError(res, listErr, 502);
            }
            return res.status(200).json({ success: true, region: region, clusters: clusters });
        });
    });
}

// POST listIrsaServiceAccounts { baseProfileName, baseAuthnMode, region, clusterName }
function listIrsaServiceAccountsHandler(req, res) {
    let userName = authConfig.resolveUserName();
    let body = req.body || {};
    let region = body.region || DEFAULT_REGION;
    let baseProfileName = body.baseProfileName || body.profileName;
    if (!baseProfileName || !body.clusterName) {
        return res.status(400).json({ success: false, message: 'baseProfileName and clusterName are required.' });
    }
    let credentialProvider = require('./credentialProvider');
    credentialProvider.resolveByProfileName(userName, baseProfileName, body.baseAuthnMode, (credErr, resolved) => {
        if (credErr) {
            return respondError(res, credErr, 401);
        }
        describeCluster(resolved.credentials, region, body.clusterName, (describeErr, connection) => {
            if (describeErr) {
                return respondError(res, describeErr, 502);
            }
            listIrsaServiceAccounts(resolved.credentials, region, body.clusterName, connection, (listErr, serviceAccounts) => {
                if (listErr) {
                    return respondError(res, listErr, 502);
                }
                return res.status(200).json({
                    success: true,
                    region: region,
                    cluster: connection.cluster,
                    serviceAccounts: serviceAccounts
                });
            });
        });
    });
}

// POST describeIrsaRole { baseProfileName, baseAuthnMode, roleArn, namespace, serviceAccount }
//
// Reads the trust policy so the form can show the audience the role actually
// requires, and warn when the chosen service account is not the one it trusts.
function describeIrsaRoleHandler(req, res) {
    let userName = authConfig.resolveUserName();
    let body = req.body || {};
    let baseProfileName = body.baseProfileName || body.profileName;
    if (!baseProfileName || !body.roleArn) {
        return res.status(400).json({ success: false, message: 'baseProfileName and roleArn are required.' });
    }
    let credentialProvider = require('./credentialProvider');
    credentialProvider.resolveByProfileName(userName, baseProfileName, body.baseAuthnMode, (credErr, resolved) => {
        if (credErr) {
            return respondError(res, credErr, 401);
        }
        getRoleTrustPolicy(resolved.credentials, body.roleArn, (policyErr, policy) => {
            if (policyErr) {
                // Not fatal — surface the default audience and say why we could not
                // confirm it, rather than blocking profile creation on iam:GetRole.
                return res.status(200).json({
                    success: true,
                    trustPolicyReadable: false,
                    message: 'Could not read the role\'s trust policy: ' + policyErr.message +
                        ' Defaulting the audience to ' + DEFAULT_AUDIENCE + '.',
                    audience: DEFAULT_AUDIENCE,
                    roleArn: body.roleArn
                });
            }
            let audience = resolveAudience(policy.facts, null);
            let subjectCheck = (body.namespace && body.serviceAccount)
                ? checkSubjectTrusted(policy.facts, body.namespace, body.serviceAccount)
                : null;
            return res.status(200).json({
                success: true,
                trustPolicyReadable: true,
                roleArn: policy.roleArn,
                audience: audience,
                audiences: policy.facts.audiences,
                subjects: policy.facts.subjects,
                oidcProviders: policy.facts.oidcProviders,
                subjectCheck: subjectCheck
            });
        });
    });
}

// POST testIrsaConnection { profileName } or { profile: {...} }
//
// Runs the whole chain and reports what happened at each step, so a failure says
// which link broke rather than just "assume failed".
function testIrsaConnection(req, res) {
    let userName = authConfig.resolveUserName();
    let body = req.body || {};
    let inlineProfile = body.profile;
    let profileName = body.profileName || (inlineProfile && inlineProfile.profileName);

    let runTest = (profile) => {
        let invalid = validateIrsaProfile(profile);
        if (invalid) {
            return respondError(res, invalid, 400);
        }
        mintCredentials(userName, profile, (mintErr, minted) => {
            if (mintErr) {
                return respondError(res, mintErr, 502);
            }
            return res.status(200).json({
                success: true,
                message: 'Minted a service-account token for ' + profile.irsaNamespace + '/' +
                    profile.irsaServiceAccount + ' on cluster "' + profile.irsaClusterName +
                    '" and assumed ' + profile.irsaRoleArn + '.',
                cluster: minted.cluster,
                subjectFromWebIdentityToken: minted.roleCredentials.subjectFromWebIdentityToken,
                audience: minted.roleCredentials.audience,
                credentials: maskCredentials(minted.roleCredentials)
            });
        });
    };

    if (inlineProfile && (inlineProfile.irsaClusterName || !profileName)) {
        let candidate = Object.assign({}, inlineProfile);
        candidate.userName = userName;
        candidate.irsaEnabled = true;
        return runTest(candidate);
    }
    if (!profileName) {
        return res.status(400).json({
            success: false,
            message: 'profileName (or an inline profile) is required to test an IRSA profile.'
        });
    }
    profileUtils.searchProfile(userName, profileName, (searchErr, profile) => {
        if (searchErr) {
            return respondError(res, searchErr, 400);
        }
        return runTest(profile);
    });
}

module.exports = {
    DEFAULT_REGION: DEFAULT_REGION,
    DEFAULT_AUDIENCE: DEFAULT_AUDIENCE,
    EKS_TOKEN_PREFIX: EKS_TOKEN_PREFIX,
    CLUSTER_NAME_HEADER: CLUSTER_NAME_HEADER,
    IRSA_ROLE_ANNOTATION: IRSA_ROLE_ANNOTATION,
    CREDENTIAL_REFRESH_BUFFER_MS: CREDENTIAL_REFRESH_BUFFER_MS,
    // pure helpers (unit-tested)
    base64UrlEncode: base64UrlEncode,
    buildEksToken: buildEksToken,
    parseRoleArn: parseRoleArn,
    extractTrustPolicyFacts: extractTrustPolicyFacts,
    resolveAudience: resolveAudience,
    serviceAccountSubject: serviceAccountSubject,
    checkSubjectTrusted: checkSubjectTrusted,
    buildTokenRequestBody: buildTokenRequestBody,
    describeK8sForbidden: describeK8sForbidden,
    serviceAccountsFromK8sItems: serviceAccountsFromK8sItems,
    toRoleCredentials: toRoleCredentials,
    maskCredentials: maskCredentials,
    endpointHost: endpointHost,
    decodeCertificateAuthority: decodeCertificateAuthority,
    validateIrsaProfile: validateIrsaProfile,
    // AWS / Kubernetes operations
    listClusters: listClusters,
    describeCluster: describeCluster,
    fetchIrsaServiceAccounts: listIrsaServiceAccounts,
    getRoleTrustPolicy: getRoleTrustPolicy,
    createServiceAccountToken: createServiceAccountToken,
    assumeRoleWithWebIdentity: assumeRoleWithWebIdentity,
    mintCredentials: mintCredentials,
    getSecurityToken: getSecurityToken,
    // express handlers
    listIrsaClusters: listIrsaClustersHandler,
    listIrsaServiceAccounts: listIrsaServiceAccountsHandler,
    describeIrsaRole: describeIrsaRoleHandler,
    testIrsaConnection: testIrsaConnection
};

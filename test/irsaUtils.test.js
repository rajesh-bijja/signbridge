"use strict";

// Tests for the pure half of the IRSA (EKS service account) profile type.
//
// The manual recipe for IRSA is: `aws eks list-clusters`, write a kubeconfig,
// `kubectl get sa -A -o json | jq ...`, `kubectl create token`, then
// `aws sts assume-role-with-web-identity`. SignBridge does all of it over HTTPS
// with no kubectl, no jq and no kubeconfig, which means the parts kubectl and jq
// used to do are now our code — and that code is what this file pins:
//
//   * buildEksToken must produce exactly what `aws eks get-token` produces,
//     including the signed x-k8s-aws-id header. It is the only reason the
//     Kubernetes API server accepts us at all.
//   * serviceAccountsFromK8sItems is the jq filter.
//   * extractTrustPolicyFacts / checkSubjectTrusted turn "assume failed" into
//     "this role trusts a different service account", which is the difference
//     between a five-second fix and an afternoon.

const test = require('node:test');
const assert = require('node:assert/strict');

const irsaUtils = require('../lib/irsaUtils');

const FIXED_NOW = Date.UTC(2026, 8, 2, 12, 34, 56); // 2026-09-02T12:34:56Z

const BASE_CREDENTIALS = {
    accessKeyId: 'ASIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    sessionToken: 'IQoJb3JpZ2luX2VjEXAMPLE'
};

const OIDC_PROVIDER =
    'arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABCDEF0123456789ABCDEF0123456789';
const OIDC_KEY_PREFIX = 'oidc.eks.us-east-1.amazonaws.com/id/ABCDEF0123456789ABCDEF0123456789';

// ---------------------------------------------------------------------------
// base64UrlEncode
// ---------------------------------------------------------------------------

test('base64UrlEncode: URL-safe alphabet, no padding', () => {
    // The token travels in an Authorization header, so + / = would be mangled.
    const encoded = irsaUtils.base64UrlEncode('https://sts.amazonaws.com/?a=b&c=d+e/f');
    assert.ok(encoded.indexOf('+') < 0);
    assert.ok(encoded.indexOf('/') < 0);
    assert.ok(encoded.indexOf('=') < 0);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
});

test('base64UrlEncode: round-trips', () => {
    const original = 'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15';
    const decoded = Buffer.from(irsaUtils.base64UrlEncode(original), 'base64url').toString('utf8');
    assert.equal(decoded, original);
});

// ---------------------------------------------------------------------------
// buildEksToken — the `aws eks get-token` equivalent
// ---------------------------------------------------------------------------

function eksToken(overrides) {
    return irsaUtils.buildEksToken(Object.assign({
        credentials: BASE_CREDENTIALS,
        region: 'us-east-1',
        clusterName: 'my-cluster',
        now: FIXED_NOW
    }, overrides || {}));
}

test('buildEksToken: has the k8s-aws-v1. prefix the API server expects', () => {
    const result = eksToken();
    assert.equal(irsaUtils.EKS_TOKEN_PREFIX, 'k8s-aws-v1.');
    assert.ok(result.token.startsWith('k8s-aws-v1.'), result.token.slice(0, 20));
    // Everything after the prefix must be URL-safe base64 of the presigned URL.
    const payload = result.token.slice('k8s-aws-v1.'.length);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(payload, 'base64url').toString('utf8'), result.presignedUrl);
});

test('buildEksToken: presigns sts:GetCallerIdentity', () => {
    const url = eksToken().presignedUrl;
    assert.ok(url.startsWith('https://sts.us-east-1.amazonaws.com/?'), url);
    assert.ok(url.indexOf('Action=GetCallerIdentity') > 0);
    assert.ok(url.indexOf('Version=2011-06-15') > 0);
    assert.match(url, /&X-Amz-Signature=[0-9a-f]{64}$/);
});

test('buildEksToken: the cluster name is SIGNED, not merely sent', () => {
    // If x-k8s-aws-id ever fell out of the signature the URL would still look
    // correct and the API server would answer 401 with nothing to point at. This
    // assertion is the whole safety net for that.
    const url = eksToken().presignedUrl;
    assert.ok(url.indexOf('X-Amz-SignedHeaders=host%3B' + irsaUtils.CLUSTER_NAME_HEADER) > 0, url);
    assert.equal(irsaUtils.CLUSTER_NAME_HEADER, 'x-k8s-aws-id');
});

test('buildEksToken: a different cluster name gives a different token', () => {
    assert.notEqual(eksToken({ clusterName: 'cluster-a' }).token,
        eksToken({ clusterName: 'cluster-b' }).token);
});

test('buildEksToken: X-Amz-Expires is 60 seconds, like aws eks get-token', () => {
    // A cluster bearer token is presented immediately; a long-lived one would be
    // a credential sitting in a header for no reason.
    assert.ok(eksToken().presignedUrl.indexOf('X-Amz-Expires=60') > 0);
});

test('buildEksToken: carries the session token for temporary base credentials', () => {
    assert.ok(eksToken().presignedUrl.indexOf('X-Amz-Security-Token=') > 0);
});

test('buildEksToken: signs against the regional STS endpoint', () => {
    assert.ok(eksToken({ region: 'eu-west-1' }).presignedUrl
        .startsWith('https://sts.eu-west-1.amazonaws.com/'));
});

test('buildEksToken: defaults the region to us-east-1', () => {
    // The user asked for us-east-1 as the form default; the backend agrees so a
    // profile saved before the region field existed still works.
    assert.equal(irsaUtils.DEFAULT_REGION, 'us-east-1');
    assert.ok(eksToken({ region: null }).presignedUrl
        .startsWith('https://sts.us-east-1.amazonaws.com/'));
});

test('buildEksToken: is clock-injected and deterministic', () => {
    assert.equal(eksToken().token, eksToken().token);
    assert.notEqual(eksToken().token, eksToken({ now: FIXED_NOW + 60000 }).token);
});

test('buildEksToken: does not leak the secret access key', () => {
    const result = eksToken();
    assert.ok(result.token.indexOf(BASE_CREDENTIALS.secretAccessKey) < 0);
    assert.ok(Buffer.from(result.token.slice('k8s-aws-v1.'.length), 'base64url').toString('utf8')
        .indexOf(BASE_CREDENTIALS.secretAccessKey) < 0);
});

// ---------------------------------------------------------------------------
// parseRoleArn
// ---------------------------------------------------------------------------

test('parseRoleArn: splits account and role name', () => {
    assert.deepEqual(irsaUtils.parseRoleArn('arn:aws:iam::123456789012:role/my-irsa-role'), {
        accountId: '123456789012',
        roleName: 'my-irsa-role',
        rolePath: '/',
        arn: 'arn:aws:iam::123456789012:role/my-irsa-role'
    });
});

test('parseRoleArn: a path is stripped from the name iam:GetRole receives', () => {
    // iam:GetRole takes RoleName without the path; passing the path produces a
    // confusing NoSuchEntity.
    const parsed = irsaUtils.parseRoleArn('arn:aws:iam::123456789012:role/service-role/eks/my-role');
    assert.equal(parsed.roleName, 'my-role');
    assert.equal(parsed.rolePath, '/service-role/eks/');
});

test('parseRoleArn: handles non-commercial partitions', () => {
    assert.equal(irsaUtils.parseRoleArn('arn:aws-us-gov:iam::123456789012:role/r').roleName, 'r');
});

test('parseRoleArn: null for anything that is not a role ARN', () => {
    assert.equal(irsaUtils.parseRoleArn(null), null);
    assert.equal(irsaUtils.parseRoleArn(''), null);
    assert.equal(irsaUtils.parseRoleArn('my-irsa-role'), null);
    // A user ARN is not a role ARN.
    assert.equal(irsaUtils.parseRoleArn('arn:aws:iam::123456789012:user/me'), null);
    assert.equal(irsaUtils.parseRoleArn({ roleArn: 'x' }), null);
});

// ---------------------------------------------------------------------------
// extractTrustPolicyFacts
// ---------------------------------------------------------------------------

function trustPolicy(overrides) {
    const condition = {};
    condition[OIDC_KEY_PREFIX + ':sub'] = 'system:serviceaccount:assistants:api-service';
    condition[OIDC_KEY_PREFIX + ':aud'] = 'sts.amazonaws.com';
    return Object.assign({
        Version: '2012-10-17',
        Statement: [{
            Effect: 'Allow',
            Principal: { Federated: OIDC_PROVIDER },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: { StringEquals: condition }
        }]
    }, overrides || {});
}

test('extractTrustPolicyFacts: reads audience, subject and OIDC provider', () => {
    const facts = irsaUtils.extractTrustPolicyFacts(trustPolicy());
    assert.equal(facts.hasWebIdentityStatement, true);
    assert.deepEqual(facts.audiences, ['sts.amazonaws.com']);
    assert.deepEqual(facts.subjects, ['system:serviceaccount:assistants:api-service']);
    assert.deepEqual(facts.oidcProviders, [OIDC_PROVIDER]);
});

test('extractTrustPolicyFacts: matches condition keys by suffix, not full key', () => {
    // The keys are qualified with the cluster's own OIDC issuer, so they differ
    // per cluster and can never be compared literally.
    const condition = {};
    condition['oidc.eks.eu-west-1.amazonaws.com/id/DEADBEEF:aud'] = 'sts.amazonaws.com';
    condition['oidc.eks.eu-west-1.amazonaws.com/id/DEADBEEF:sub'] = 'system:serviceaccount:ns:sa';
    const facts = irsaUtils.extractTrustPolicyFacts({
        Statement: [{
            Effect: 'Allow',
            Principal: { Federated: 'arn:aws:iam::1:oidc-provider/x' },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: { StringEquals: condition }
        }]
    });
    assert.deepEqual(facts.audiences, ['sts.amazonaws.com']);
    assert.deepEqual(facts.subjects, ['system:serviceaccount:ns:sa']);
});

test('extractTrustPolicyFacts: reads StringLike as well as StringEquals', () => {
    const like = {};
    like[OIDC_KEY_PREFIX + ':sub'] = 'system:serviceaccount:assistants:*';
    const facts = irsaUtils.extractTrustPolicyFacts({
        Statement: [{
            Effect: 'Allow',
            Principal: { Federated: OIDC_PROVIDER },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: { StringLike: like }
        }]
    });
    assert.deepEqual(facts.subjects, ['system:serviceaccount:assistants:*']);
});

test('extractTrustPolicyFacts: collects list-valued conditions and multiple statements', () => {
    const condA = {};
    condA[OIDC_KEY_PREFIX + ':sub'] = ['system:serviceaccount:a:one', 'system:serviceaccount:a:two'];
    const condB = {};
    condB[OIDC_KEY_PREFIX + ':sub'] = 'system:serviceaccount:b:three';
    const facts = irsaUtils.extractTrustPolicyFacts({
        Statement: [
            {
                Effect: 'Allow', Principal: { Federated: OIDC_PROVIDER },
                Action: ['sts:AssumeRoleWithWebIdentity'], Condition: { StringEquals: condA }
            },
            {
                Effect: 'Allow', Principal: { Federated: OIDC_PROVIDER },
                Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: condB }
            }
        ]
    });
    assert.deepEqual(facts.subjects, [
        'system:serviceaccount:a:one',
        'system:serviceaccount:a:two',
        'system:serviceaccount:b:three'
    ]);
});

test('extractTrustPolicyFacts: ignores Deny statements', () => {
    const facts = irsaUtils.extractTrustPolicyFacts(Object.assign(trustPolicy(), {
        Statement: [Object.assign({}, trustPolicy().Statement[0], { Effect: 'Deny' })]
    }));
    assert.equal(facts.hasWebIdentityStatement, false);
    assert.deepEqual(facts.subjects, []);
});

test('extractTrustPolicyFacts: ignores statements for other actions', () => {
    // An EC2-assumable role is not an IRSA role, and saying so is the point.
    const facts = irsaUtils.extractTrustPolicyFacts({
        Statement: [{
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole'
        }]
    });
    assert.equal(facts.hasWebIdentityStatement, false);
    assert.deepEqual(facts.oidcProviders, []);
});

test('extractTrustPolicyFacts: a wildcard action still counts', () => {
    for (const action of ['sts:*', '*']) {
        const facts = irsaUtils.extractTrustPolicyFacts({
            Statement: [{
                Effect: 'Allow', Principal: { Federated: OIDC_PROVIDER }, Action: action
            }]
        });
        assert.equal(facts.hasWebIdentityStatement, true, action + ' should count');
    }
});

test('extractTrustPolicyFacts: never throws on junk', () => {
    for (const input of [null, undefined, {}, { Statement: null }, { Statement: [null] },
        { Statement: 'nope' }]) {
        const facts = irsaUtils.extractTrustPolicyFacts(input);
        assert.deepEqual(facts.audiences, []);
        assert.deepEqual(facts.subjects, []);
    }
});

// ---------------------------------------------------------------------------
// resolveAudience
// ---------------------------------------------------------------------------

test('resolveAudience: an explicit override always wins', () => {
    assert.equal(irsaUtils.resolveAudience({ audiences: ['other'] }, 'my-audience'), 'my-audience');
});

test('resolveAudience: the trust policy is authoritative', () => {
    assert.equal(irsaUtils.resolveAudience({ audiences: ['my.custom.audience'] }, null),
        'my.custom.audience');
});

test('resolveAudience: prefers sts.amazonaws.com when the policy allows several', () => {
    assert.equal(
        irsaUtils.resolveAudience({ audiences: ['other.audience', 'sts.amazonaws.com'] }, null),
        'sts.amazonaws.com'
    );
});

test('resolveAudience: falls back to sts.amazonaws.com when nothing is pinned', () => {
    assert.equal(irsaUtils.DEFAULT_AUDIENCE, 'sts.amazonaws.com');
    assert.equal(irsaUtils.resolveAudience({ audiences: [] }, null), 'sts.amazonaws.com');
    assert.equal(irsaUtils.resolveAudience(null, null), 'sts.amazonaws.com');
});

// ---------------------------------------------------------------------------
// serviceAccountSubject / checkSubjectTrusted
// ---------------------------------------------------------------------------

test('serviceAccountSubject: the Kubernetes subject format', () => {
    assert.equal(irsaUtils.serviceAccountSubject('assistants', 'api-service'),
        'system:serviceaccount:assistants:api-service');
});

test('checkSubjectTrusted: ok when the subject matches exactly', () => {
    const facts = irsaUtils.extractTrustPolicyFacts(trustPolicy());
    const check = irsaUtils.checkSubjectTrusted(facts, 'assistants', 'api-service');
    assert.equal(check.ok, true);
    assert.equal(check.unknown, undefined);
    assert.match(check.message, /trusts system:serviceaccount:assistants:api-service/);
});

test('checkSubjectTrusted: names the subjects the role DOES trust on a mismatch', () => {
    // The mismatch message is the reason this pre-flight exists at all.
    const facts = irsaUtils.extractTrustPolicyFacts(trustPolicy());
    const check = irsaUtils.checkSubjectTrusted(facts, 'default', 'my-sa');
    assert.equal(check.ok, false);
    assert.equal(check.subject, 'system:serviceaccount:default:my-sa');
    assert.deepEqual(check.expectedSubjects, ['system:serviceaccount:assistants:api-service']);
    assert.match(check.message, /does not trust system:serviceaccount:default:my-sa/);
    assert.match(check.message, /system:serviceaccount:assistants:api-service/);
});

test('checkSubjectTrusted: honours a StringLike wildcard', () => {
    const facts = { subjects: ['system:serviceaccount:assistants:*'] };
    assert.equal(irsaUtils.checkSubjectTrusted(facts, 'assistants', 'anything').ok, true);
    assert.equal(irsaUtils.checkSubjectTrusted(facts, 'other', 'anything').ok, false);
});

test('checkSubjectTrusted: a wildcard pattern is not a regex injection', () => {
    // '.' in a pattern must match a literal dot, not any character.
    const facts = { subjects: ['system:serviceaccount:ns:a.b'] };
    assert.equal(irsaUtils.checkSubjectTrusted(facts, 'ns', 'a.b').ok, true);
    assert.equal(irsaUtils.checkSubjectTrusted(facts, 'ns', 'axb').ok, false);
});

test('checkSubjectTrusted: an unreadable policy is unknown, never a blocker', () => {
    // iam:GetRole is frequently not granted. Refusing to create the profile over
    // that would be worse than attempting the assume and reporting the result.
    const check = irsaUtils.checkSubjectTrusted({ subjects: [] }, 'ns', 'sa');
    assert.equal(check.ok, true);
    assert.equal(check.unknown, true);
    assert.match(check.message, /not verified/);
    assert.equal(irsaUtils.checkSubjectTrusted(null, 'ns', 'sa').ok, true);
});

// ---------------------------------------------------------------------------
// buildTokenRequestBody — the `kubectl create token` equivalent
// ---------------------------------------------------------------------------

test('buildTokenRequestBody: a valid TokenRequest for the given audience', () => {
    const body = JSON.parse(irsaUtils.buildTokenRequestBody('sts.amazonaws.com', 3600));
    assert.equal(body.apiVersion, 'authentication.k8s.io/v1');
    assert.equal(body.kind, 'TokenRequest');
    assert.deepEqual(body.spec.audiences, ['sts.amazonaws.com']);
    assert.equal(body.spec.expirationSeconds, 3600);
});

test('buildTokenRequestBody: defaults audience and duration', () => {
    const body = JSON.parse(irsaUtils.buildTokenRequestBody(null, null));
    assert.deepEqual(body.spec.audiences, ['sts.amazonaws.com']);
    assert.equal(body.spec.expirationSeconds, 3600);
});

// ---------------------------------------------------------------------------
// serviceAccountsFromK8sItems — the jq filter
// ---------------------------------------------------------------------------

function saItem(namespace, name, roleArn) {
    const annotations = {};
    if (roleArn) {
        annotations[irsaUtils.IRSA_ROLE_ANNOTATION] = roleArn;
    }
    annotations['kubectl.kubernetes.io/last-applied-configuration'] = '{}';
    return { metadata: { namespace: namespace, name: name, annotations: annotations } };
}

test('serviceAccountsFromK8sItems: keeps only IRSA-annotated accounts', () => {
    const items = [
        saItem('default', 'default', null),
        saItem('assistants', 'api-service', 'arn:aws:iam::123456789012:role/api-role'),
        saItem('kube-system', 'coredns', null)
    ];
    assert.deepEqual(irsaUtils.serviceAccountsFromK8sItems(items), [
        { namespace: 'assistants', name: 'api-service', roleArn: 'arn:aws:iam::123456789012:role/api-role' }
    ]);
});

test('serviceAccountsFromK8sItems: the annotation is the documented EKS one', () => {
    assert.equal(irsaUtils.IRSA_ROLE_ANNOTATION, 'eks.amazonaws.com/role-arn');
});

test('serviceAccountsFromK8sItems: sorted by namespace then name', () => {
    const items = [
        saItem('zeta', 'b', 'arn:aws:iam::1:role/x'),
        saItem('alpha', 'z', 'arn:aws:iam::1:role/x'),
        saItem('zeta', 'a', 'arn:aws:iam::1:role/x'),
        saItem('alpha', 'a', 'arn:aws:iam::1:role/x')
    ];
    assert.deepEqual(
        irsaUtils.serviceAccountsFromK8sItems(items).map((sa) => sa.namespace + '/' + sa.name),
        ['alpha/a', 'alpha/z', 'zeta/a', 'zeta/b']
    );
});

test('serviceAccountsFromK8sItems: tolerates missing metadata and junk input', () => {
    assert.deepEqual(irsaUtils.serviceAccountsFromK8sItems(null), []);
    assert.deepEqual(irsaUtils.serviceAccountsFromK8sItems([]), []);
    assert.deepEqual(irsaUtils.serviceAccountsFromK8sItems([null, {}, { metadata: {} }]), []);
});

// ---------------------------------------------------------------------------
// toRoleCredentials / maskCredentials
// ---------------------------------------------------------------------------

const STS_CREDENTIALS = {
    AccessKeyId: 'ASIAEXAMPLEKEYID1234',
    SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    SessionToken: 'IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKEN',
    Expiration: '2026-09-02T13:34:56Z'
};

test('toRoleCredentials: same shape as SSO and EC2, expiration in epoch ms', () => {
    const creds = irsaUtils.toRoleCredentials(STS_CREDENTIALS, { assumedRoleArn: 'arn:aws:iam::1:role/r' });
    assert.equal(creds.accessKeyId, STS_CREDENTIALS.AccessKeyId);
    assert.equal(creds.sessionToken, STS_CREDENTIALS.SessionToken);
    assert.equal(creds.expiration, Date.parse('2026-09-02T13:34:56Z'));
    assert.equal(creds.source, 'irsa');
    assert.equal(creds.assumedRoleArn, 'arn:aws:iam::1:role/r');
});

test('toRoleCredentials: an unparseable Expiration becomes null, not NaN', () => {
    const creds = irsaUtils.toRoleCredentials(
        Object.assign({}, STS_CREDENTIALS, { Expiration: '' }), null);
    assert.equal(creds.expiration, null);
});

test('maskCredentials: never reveals the secret key or session token', () => {
    const masked = irsaUtils.maskCredentials(irsaUtils.toRoleCredentials(STS_CREDENTIALS, null));
    const serialised = JSON.stringify(masked);
    assert.ok(serialised.indexOf(STS_CREDENTIALS.SecretAccessKey) < 0, 'secret key leaked');
    assert.ok(serialised.indexOf(STS_CREDENTIALS.SessionToken) < 0, 'session token leaked');
    assert.equal(masked.accessKeyId, 'ASIA****1234');
    assert.equal(irsaUtils.maskCredentials(null), null);
});

// ---------------------------------------------------------------------------
// endpointHost / decodeCertificateAuthority
// ---------------------------------------------------------------------------

test('endpointHost: strips the scheme and any path from an EKS endpoint', () => {
    assert.equal(
        irsaUtils.endpointHost('https://ABCDEF0123.gr7.us-east-1.eks.amazonaws.com'),
        'ABCDEF0123.gr7.us-east-1.eks.amazonaws.com'
    );
    assert.equal(irsaUtils.endpointHost('https://host.example.com/api/v1'), 'host.example.com');
    assert.equal(irsaUtils.endpointHost('host.example.com'), 'host.example.com');
    assert.equal(irsaUtils.endpointHost(null), null);
});

test('decodeCertificateAuthority: base64 -> PEM', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n';
    assert.equal(
        irsaUtils.decodeCertificateAuthority(Buffer.from(pem, 'utf8').toString('base64')),
        pem
    );
    assert.equal(irsaUtils.decodeCertificateAuthority(null), null);
});

// ---------------------------------------------------------------------------
// validateIrsaProfile
// ---------------------------------------------------------------------------

function irsaProfile(overrides) {
    return Object.assign({
        profileName: 'my-irsa',
        irsaEnabled: true,
        irsaBaseProfileName: 'my-sso-profile',
        irsaRegion: 'us-east-1',
        irsaClusterName: 'my-cluster',
        irsaNamespace: 'assistants',
        irsaServiceAccount: 'api-service',
        irsaRoleArn: 'arn:aws:iam::123456789012:role/api-role'
    }, overrides || {});
}

test('validateIrsaProfile: a complete profile is valid', () => {
    assert.equal(irsaUtils.validateIrsaProfile(irsaProfile()), null);
});

test('validateIrsaProfile: lists every missing field at once', () => {
    const err = irsaUtils.validateIrsaProfile({ profileName: 'p', irsaEnabled: true });
    assert.match(err.message, /base AWS profile/);
    assert.match(err.message, /cluster/);
    assert.match(err.message, /namespace/);
    assert.match(err.message, /service account/);
    assert.match(err.message, /role ARN/);
    assert.equal(err.statusCode, 400);
});

test('validateIrsaProfile: rejects a profile that is not an IRSA profile', () => {
    assert.match(irsaUtils.validateIrsaProfile({ profileName: 'p' }).message, /not an IRSA profile/);
    assert.match(irsaUtils.validateIrsaProfile(null).message, /not an IRSA profile/);
});

test('validateIrsaProfile: the region is optional — it defaults', () => {
    // The user asked for us-east-1 as the default rather than a required field.
    assert.equal(irsaUtils.validateIrsaProfile(irsaProfile({ irsaRegion: null })), null);
});

test('validateIrsaProfile: returns an Error rather than throwing', () => {
    assert.ok(irsaUtils.validateIrsaProfile({}) instanceof Error);
});

// --- describeK8sForbidden -------------------------------------------------
// The two Kubernetes calls SignBridge makes need *different* RBAC verbs, and a
// bare "forbidden" sends users to fix an access entry that is already correct.

test('describeK8sForbidden: a 401 means the identity is not mapped at all', () => {
    const message = irsaUtils.describeK8sForbidden({
        statusCode: 401,
        intent: 'list-service-accounts'
    });
    assert.match(message, /not recognised by the cluster at all/);
    assert.match(message, /access entries|aws-auth/);
    // It must NOT talk about a missing verb — nothing is mapped yet.
    assert.doesNotMatch(message, /serviceaccounts\/token/);
});

test('describeK8sForbidden: a create-token 403 names the exact missing verb', () => {
    const message = irsaUtils.describeK8sForbidden({
        statusCode: 403,
        intent: 'create-token',
        namespace: 'identity',
        serviceAccount: 'cleansing-service',
        detail: 'serviceaccounts "cleansing-service" is forbidden'
    });
    assert.match(message, /identity\/cleansing-service/);
    assert.match(message, /"create"/);
    assert.match(message, /serviceaccounts\/token/);
    assert.match(message, /namespace "identity"/);
    // The point of the message: listing worked, so the mapping is fine.
    assert.match(message, /IS mapped in the cluster/);
    // And it must be actionable — a rule a cluster admin can paste.
    assert.match(message, /RoleBinding/);
    assert.match(message, /serviceaccounts "cleansing-service" is forbidden/);
});

test('describeK8sForbidden: a list 403 points at the cluster mapping instead', () => {
    const message = irsaUtils.describeK8sForbidden({
        statusCode: 403,
        intent: 'list-service-accounts'
    });
    assert.match(message, /must be mapped in the cluster/);
    assert.match(message, /read service accounts/);
    assert.doesNotMatch(message, /serviceaccounts\/token/);
});

test('describeK8sForbidden: always reports the HTTP status', () => {
    assert.match(irsaUtils.describeK8sForbidden({ statusCode: 403, intent: 'create-token' }), /HTTP 403/);
    assert.match(irsaUtils.describeK8sForbidden({ statusCode: 401 }), /HTTP 401/);
});

test('describeK8sForbidden: survives missing namespace/service account', () => {
    const message = irsaUtils.describeK8sForbidden({ statusCode: 403, intent: 'create-token' });
    assert.ok(message.length > 0);
    assert.doesNotMatch(message, /undefined|null/);
});

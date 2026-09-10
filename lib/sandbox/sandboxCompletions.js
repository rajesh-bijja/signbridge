"use strict";

/**
 * sandboxCompletions.js
 *
 * The intelligence behind Sandbox autocomplete. When a user types `boto3.` or
 * `ec2.` we want the real operations for that service — not a hand-maintained
 * list that rots the moment AWS ships an API.
 *
 * Where the data comes from
 *   SignBridge already ships the botocore service index (lib/aws-service-index.json)
 *   and already fetches + caches full botocore service models for the Templates
 *   page (lib/awsCatalog.js). Those models are the same source of truth boto3
 *   itself uses, so we build the completion index from them. That means:
 *     - every operation of every AWS service, with its real parameters
 *     - the actual API documentation as hover text
 *     - correct on the day AWS adds an API, with no code change here
 *
 * Language-correct naming
 *   One model, three naming conventions. A botocore operation `DescribeRegions`
 *   is `describe_regions` in boto3, `describeRegions` / `DescribeRegionsCommand`
 *   in the AWS SDK for JavaScript v3, and `describeRegions` in the AWS SDK for
 *   Java v2. We derive all of them, using botocore's own `xform_name` algorithm
 *   for Python so the snake_case matches boto3 exactly (including its quirks).
 *
 * Purity
 *   Everything except `getServiceIndex` is pure: model object in, index out. The
 *   naming transforms and index building are unit tested against real botocore
 *   shapes in test/sandboxCompletions.test.js. Only `getServiceIndex` touches
 *   the cache/network, and it does so through awsCatalog.
 */

const awsCatalog = require('../awsCatalog');

// ---------------------------------------------------------------------------
// Naming transforms
// ---------------------------------------------------------------------------

// botocore's xform_name regexes and its trailing-acronym-plural special case,
// ported verbatim from botocore/__init__.py. Reproducing the algorithm rather
// than approximating it is the whole point: every deviation makes the editor
// suggest a boto3 method that does not exist.
const FIRST_CAP_REGEX = /(.)([A-Z][a-z]+)/g;
const END_CAP_REGEX = /([a-z0-9])([A-Z])/g;
// "ARNs", "ACLs", "VPCs" at the end of a name are treated as one word, so
// DescribeVPCs becomes describe_vpcs and not describe_vp_cs.
const SPECIAL_CASE_REGEX = /[A-Z]{2,}s$/;

// botocore ships a hardcoded table of names the regexes get wrong (`_xform_cache`
// in botocore/__init__.py). Ported as-is, because these ARE the boto3 method
// names — a derived one would be a method that doesn't exist. With this table,
// xformName matches boto3 on all ~15k operations in botocore's models; see
// test/sandboxCompletions.test.js.
//
// botocore keys its table on (name, separator) and carries a second copy of every
// entry for the '-' separator. Those copies are all the underscore form with the
// separator substituted, so one table plus a substitution reproduces both.
const XFORM_OVERRIDES = {
    AssociateWhatsAppBusinessAccount: 'associate_whatsapp_business_account',
    CreateCachediSCSIVolume: 'create_cached_iscsi_volume',
    CreateOAuth2Token: 'create_oauth2_token',
    CreateOAuth2TokenWithIAM: 'create_oauth2_token_with_iam',
    CreateStorediSCSIVolume: 'create_stored_iscsi_volume',
    CreateWhatsAppDataset: 'create_whatsapp_dataset',
    CreateWhatsAppFlow: 'create_whatsapp_flow',
    CreateWhatsAppMessageTemplate: 'create_whatsapp_message_template',
    CreateWhatsAppMessageTemplateFromLibrary: 'create_whatsapp_message_template_from_library',
    CreateWhatsAppMessageTemplateMedia: 'create_whatsapp_message_template_media',
    DeleteWhatsAppFlow: 'delete_whatsapp_flow',
    DeleteWhatsAppMessageMedia: 'delete_whatsapp_message_media',
    DeleteWhatsAppMessageTemplate: 'delete_whatsapp_message_template',
    DeprecateWhatsAppFlow: 'deprecate_whatsapp_flow',
    DescribeCachediSCSIVolumes: 'describe_cached_iscsi_volumes',
    DescribeStorediSCSIVolumes: 'describe_stored_iscsi_volumes',
    DisassociateWhatsAppBusinessAccount: 'disassociate_whatsapp_business_account',
    ExecutePartiQLBatch: 'execute_partiql_batch',
    ExecutePartiQLStatement: 'execute_partiql_statement',
    ExecutePartiQLTransaction: 'execute_partiql_transaction',
    GetLinkedWhatsAppBusinessAccount: 'get_linked_whatsapp_business_account',
    GetLinkedWhatsAppBusinessAccountPhoneNumber: 'get_linked_whatsapp_business_account_phone_number',
    GetOTelEnrichment: 'get_otel_enrichment',
    GetWhatsAppFlow: 'get_whatsapp_flow',
    GetWhatsAppFlowPreview: 'get_whatsapp_flow_preview',
    GetWhatsAppMessageMedia: 'get_whatsapp_message_media',
    GetWhatsAppMessageTemplate: 'get_whatsapp_message_template',
    IntrospectOAuth2TokenWithIAM: 'introspect_oauth2_token_with_iam',
    ListHITsForQualificationType: 'list_hits_for_qualification_type',
    ListLinkedWhatsAppBusinessAccounts: 'list_linked_whatsapp_business_accounts',
    ListWhatsAppFlowAssets: 'list_whatsapp_flow_assets',
    ListWhatsAppFlows: 'list_whatsapp_flows',
    ListWhatsAppMessageTemplates: 'list_whatsapp_message_templates',
    ListWhatsAppTemplateLibrary: 'list_whatsapp_template_library',
    PostWhatsAppMessageMedia: 'post_whatsapp_message_media',
    PublishWhatsAppFlow: 'publish_whatsapp_flow',
    PutWhatsAppBusinessAccountEventDestinations: 'put_whatsapp_business_account_event_destinations',
    RevokeOAuth2TokenWithIAM: 'revoke_oauth2_token_with_iam',
    SendWhatsAppConversionEvent: 'send_whatsapp_conversion_event',
    SendWhatsAppMessage: 'send_whatsapp_message',
    StartOTelEnrichment: 'start_otel_enrichment',
    StopOTelEnrichment: 'stop_otel_enrichment',
    UpdateWhatsAppFlow: 'update_whatsapp_flow',
    UpdateWhatsAppFlowAssets: 'update_whatsapp_flow_assets',
    UpdateWhatsAppMessageTemplate: 'update_whatsapp_message_template'
};

/**
 * botocore.xform_name: the PascalCase API operation name as boto3 exposes it.
 *   DescribeRegions     -> describe_regions
 *   GetCallerIdentity   -> get_caller_identity
 *   DescribeVPCs        -> describe_vpcs
 *   AssignIpv6Addresses -> assign_ipv6_addresses
 *   ListHITs            -> list_hi_ts   (yes, really — this is boto3's behaviour)
 *
 * Note there is deliberately NO digit-splitting step. boto3 produces
 * `assign_ipv6_addresses`, so inserting a separator before the digits (as an
 * earlier version did) named a method that isn't there.
 */
function xformName(name, sep) {
    sep = sep || '_';
    let value = String(name || '');
    if (Object.prototype.hasOwnProperty.call(XFORM_OVERRIDES, value)) {
        return XFORM_OVERRIDES[value].split('_').join(sep);
    }
    if (value.indexOf(sep) !== -1) {
        return value.toLowerCase();
    }
    let matched = SPECIAL_CASE_REGEX.exec(value);
    if (matched) {
        value = value.slice(0, value.length - matched[0].length) + sep + matched[0].toLowerCase();
    }
    let s1 = value.replace(FIRST_CAP_REGEX, '$1' + sep + '$2');
    return s1.replace(END_CAP_REGEX, '$1' + sep + '$2').toLowerCase();
}

/**
 * PascalCase -> camelCase, as the JavaScript and Java SDKs name their methods.
 * A leading acronym is lowercased as a unit, except for its last letter when a
 * lowercase letter follows it (so `DBInstance` -> `dbInstance`, not `dBInstance`).
 */
function toCamelCase(name) {
    let value = String(name || '');
    if (value.length === 0) {
        return value;
    }
    let upperRun = 0;
    while (upperRun < value.length && /[A-Z0-9]/.test(value[upperRun])) {
        upperRun += 1;
    }
    if (upperRun <= 1) {
        return value[0].toLowerCase() + value.slice(1);
    }
    // The run is followed by a lowercase letter: that last capital starts the
    // next word, so keep it capitalised.
    if (upperRun < value.length) {
        return value.slice(0, upperRun - 1).toLowerCase() + value.slice(upperRun - 1);
    }
    return value.toLowerCase();
}

/**
 * Split an AWS serviceId into words, handling spaces, hyphens, and
 * acronym/camel boundaries.
 *   'DynamoDB'    -> ['Dynamo', 'DB']
 *   'EC2'         -> ['EC2']
 *   'API Gateway' -> ['API', 'Gateway']
 */
function splitWords(value) {
    let words = [];
    for (let chunk of String(value || '').split(/[\s\-_]+/)) {
        if (!chunk) {
            continue;
        }
        let matches = chunk.match(/[A-Z]+(?![a-z])[0-9]*|[A-Z][a-z0-9]*|[a-z0-9]+/g);
        if (matches) {
            for (let match of matches) {
                words.push(match);
            }
        } else {
            words.push(chunk);
        }
    }
    return words;
}

function capitalizeWord(word) {
    if (!word) {
        return word;
    }
    return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * AWS SDK for Java v2 client class name.
 *   'EC2'      -> 'Ec2Client'
 *   'STS'      -> 'StsClient'
 *   'DynamoDB' -> 'DynamoDbClient'
 *   'S3'       -> 'S3Client'
 */
function javaClientName(serviceId, serviceName) {
    let words = splitWords(serviceId || serviceName || '');
    if (words.length === 0) {
        return null;
    }
    return words.map(capitalizeWord).join('') + 'Client';
}

/**
 * AWS SDK for JavaScript v3 client class name. The v3 packages keep the
 * serviceId's own casing with the spaces removed: 'EC2' -> 'EC2Client',
 * 'API Gateway' -> 'APIGatewayClient'.
 */
function jsClientName(serviceId, serviceName) {
    let source = serviceId || serviceName || '';
    let condensed = String(source).replace(/[\s\-_]+/g, '');
    if (!condensed) {
        return null;
    }
    return condensed[0].toUpperCase() + condensed.slice(1) + 'Client';
}

// ---------------------------------------------------------------------------
// Documentation cleanup
// ---------------------------------------------------------------------------

const MAX_DOC_LENGTH = 600;

/**
 * botocore documentation is HTML. Monaco hovers render Markdown, so strip the
 * tags, decode the handful of entities that actually appear, and truncate — a
 * hover is a hint, not a manual.
 */
function stripDocumentation(html) {
    if (!html) {
        return '';
    }
    let text = String(html)
        .replace(/<\/(p|li|div|h\d)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    if (text.length > MAX_DOC_LENGTH) {
        text = text.slice(0, MAX_DOC_LENGTH).replace(/\s+\S*$/, '') + '…';
    }
    return text;
}

// ---------------------------------------------------------------------------
// Shape / parameter extraction
// ---------------------------------------------------------------------------

// Keep parameter lists useful rather than exhaustive: some EC2 operations take
// 80+ optional filters, and a completion popup listing all of them is noise.
const MAX_PARAMS_PER_OPERATION = 40;

/**
 * A short, human-readable type for a shape reference — enough to know whether a
 * parameter wants a string, a list, or a nested structure.
 */
function describeShapeType(model, shapeName, depth) {
    depth = depth || 0;
    let shapes = (model && model.shapes) || {};
    let shape = shapes[shapeName];
    if (!shape) {
        return 'unknown';
    }
    switch (shape.type) {
        case 'list':
            if (depth > 1) {
                return 'list';
            }
            return 'list<' + describeShapeType(model, shape.member && shape.member.shape, depth + 1) + '>';
        case 'map':
            if (depth > 1) {
                return 'map';
            }
            return 'map<' + describeShapeType(model, shape.key && shape.key.shape, depth + 1) + ', ' +
                describeShapeType(model, shape.value && shape.value.shape, depth + 1) + '>';
        case 'structure':
            return shapeName;
        case 'timestamp':
            return 'timestamp';
        case 'blob':
            return 'blob';
        default:
            return shape.type;
    }
}

/**
 * The parameters of an operation, derived from its input structure shape.
 * Required parameters are listed first — that is the order a user needs them in.
 */
function extractParams(model, operation) {
    let inputShapeName = operation && operation.input && operation.input.shape;
    if (!inputShapeName) {
        return [];
    }
    let shapes = (model && model.shapes) || {};
    let inputShape = shapes[inputShapeName];
    if (!inputShape || inputShape.type !== 'structure' || !inputShape.members) {
        return [];
    }
    let required = inputShape.required || [];
    let params = [];
    for (let memberName of Object.keys(inputShape.members)) {
        let member = inputShape.members[memberName];
        params.push({
            name: memberName,
            // Python uses the member name as the keyword argument verbatim;
            // JS/Java use the same key in the request object/builder setter.
            pythonName: memberName,
            type: describeShapeType(model, member.shape),
            required: required.indexOf(memberName) !== -1,
            documentation: stripDocumentation(member.documentation)
        });
    }
    params.sort(function (a, b) {
        if (a.required !== b.required) {
            return a.required ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
    return params.slice(0, MAX_PARAMS_PER_OPERATION);
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/**
 * Build the completion index for one AWS service from its botocore model.
 *
 * PURE: model object in, plain JSON out. This is the function the tests target.
 *
 * @param {object} model  a parsed botocore service-2.json
 * @param {object} entry  { service, label, apiVersion } from the bundled index
 * @param {object} [options] { includeParams: boolean (default true) }
 */
function buildIndexFromModel(model, entry, options) {
    options = options || {};
    let includeParams = options.includeParams !== false;
    let metadata = (model && model.metadata) || {};
    let serviceName = (entry && entry.service) || metadata.endpointPrefix || '';
    let serviceId = metadata.serviceId || (entry && entry.label) || serviceName;

    let operations = [];
    let modelOperations = (model && model.operations) || {};
    for (let opName of Object.keys(modelOperations).sort()) {
        let operation = modelOperations[opName] || {};
        let record = {
            name: opName,
            python: xformName(opName),
            javascript: toCamelCase(opName),
            command: opName + 'Command',
            java: toCamelCase(opName),
            http: operation.http
                ? ((operation.http.method || '') + ' ' + (operation.http.requestUri || '')).trim()
                : null,
            documentation: stripDocumentation(operation.documentation)
        };
        if (includeParams) {
            record.params = extractParams(model, operation);
            record.requiredParams = record.params
                .filter(function (p) { return p.required; })
                .map(function (p) { return p.name; });
        }
        operations.push(record);
    }

    return {
        service: serviceName,
        label: (entry && entry.label) || serviceId,
        serviceId: serviceId,
        apiVersion: metadata.apiVersion || (entry && entry.apiVersion) || null,
        protocol: metadata.protocol || null,
        signingName: metadata.signingName || metadata.endpointPrefix || serviceName,
        clients: {
            // boto3.client('<service>') uses the botocore service directory name.
            python: serviceName,
            pythonModule: 'boto3',
            javascript: jsClientName(serviceId, serviceName),
            javascriptPackage: '@aws-sdk/client-' + serviceName,
            java: javaClientName(serviceId, serviceName),
            javaPackage: 'software.amazon.awssdk.services.' + serviceName
        },
        operationCount: operations.length,
        operations: operations
    };
}

// ---------------------------------------------------------------------------
// Language globals — the "boto3." case, and its equivalents
// ---------------------------------------------------------------------------

// Module-level members that a language server would give us for free but which
// we supply ourselves for Python and Java (Monaco has no language server for
// them). JavaScript/TypeScript get real IntelliSense from Monaco's own
// TypeScript worker, so their entry here only covers what the worker can't know.
//
// `detail` is the signature shown to the right of the name; `documentation` is
// the hover body; `insertText` may contain a snippet placeholder ($1, $0).
const LANGUAGE_GLOBALS = {
    python: {
        boto3: {
            kind: 'module',
            documentation: 'The AWS SDK for Python. Credentials for the selected SignBridge ' +
                'profile are already in the environment, so no configuration is needed.',
            members: [
                {
                    name: 'client',
                    kind: 'function',
                    detail: "client(service_name, region_name=None, **kwargs) -> BaseClient",
                    documentation: 'Create a low-level service client. Every AWS API operation is a ' +
                        'method on the returned object, in snake_case.',
                    insertText: "client('${1:sts}')"
                },
                {
                    name: 'resource',
                    kind: 'function',
                    detail: 'resource(service_name, region_name=None, **kwargs) -> ServiceResource',
                    documentation: 'Create a higher-level, object-oriented resource interface. ' +
                        'Available for a subset of services (s3, ec2, dynamodb, sqs, sns, iam, ...).',
                    insertText: "resource('${1:s3}')"
                },
                {
                    name: 'Session',
                    kind: 'class',
                    detail: 'Session(region_name=None, profile_name=None, ...)',
                    documentation: 'An isolated configuration/credential scope. Use this to work ' +
                        'with more than one region in a single script.',
                    insertText: 'Session(${1:region_name="us-east-1"})'
                },
                {
                    name: 'setup_default_session',
                    kind: 'function',
                    detail: 'setup_default_session(**kwargs) -> None',
                    documentation: 'Configure the module-level default session used by boto3.client() ' +
                        'and boto3.resource().'
                },
                {
                    name: 'set_stream_logger',
                    kind: 'function',
                    detail: "set_stream_logger(name='boto3', level=DEBUG) -> None",
                    documentation: 'Turn on SDK logging — useful for seeing the exact signed request ' +
                        'boto3 sends.'
                },
                {
                    name: 'DEFAULT_SESSION',
                    kind: 'variable',
                    detail: 'Session | None',
                    documentation: 'The module-level default session, or None until one is created.'
                },
                {
                    name: '__version__',
                    kind: 'variable',
                    detail: 'str',
                    documentation: 'The installed boto3 version.'
                }
            ]
        },
        botocore: {
            kind: 'module',
            documentation: 'The low-level core that boto3 is built on: models, signing, and exceptions.',
            members: [
                { name: 'exceptions', kind: 'module', detail: 'botocore.exceptions', documentation: 'ClientError, NoCredentialsError, EndpointConnectionError, and friends.' },
                { name: 'session', kind: 'module', detail: 'botocore.session', documentation: 'Low-level session and credential resolution.' },
                { name: 'config', kind: 'module', detail: 'botocore.config', documentation: 'Config(retries=..., signature_version=..., ...) for a client.' },
                { name: '__version__', kind: 'variable', detail: 'str', documentation: 'The installed botocore version.' }
            ]
        },
        requests: {
            kind: 'module',
            documentation: 'HTTP for humans. Use this for non-AWS REST APIs, or to call a ' +
                'presigned URL generated on the SignBridge dashboard.',
            members: [
                { name: 'get', kind: 'function', detail: 'get(url, params=None, **kwargs) -> Response', insertText: "get('${1:https://httpbin.org/get}', timeout=15)" },
                { name: 'post', kind: 'function', detail: 'post(url, data=None, json=None, **kwargs) -> Response', insertText: "post('${1:url}', json=${2:{}}, timeout=15)" },
                { name: 'put', kind: 'function', detail: 'put(url, data=None, **kwargs) -> Response' },
                { name: 'patch', kind: 'function', detail: 'patch(url, data=None, **kwargs) -> Response' },
                { name: 'delete', kind: 'function', detail: 'delete(url, **kwargs) -> Response' },
                { name: 'head', kind: 'function', detail: 'head(url, **kwargs) -> Response' },
                { name: 'request', kind: 'function', detail: 'request(method, url, **kwargs) -> Response' },
                { name: 'Session', kind: 'class', detail: 'Session()', documentation: 'Connection pooling and persistent headers/cookies across requests.' },
                { name: 'HTTPError', kind: 'class', detail: 'HTTPError', documentation: 'Raised by Response.raise_for_status().' }
            ]
        },
        json: {
            kind: 'module',
            documentation: 'Standard-library JSON support.',
            members: [
                { name: 'dumps', kind: 'function', detail: 'dumps(obj, indent=None, default=None) -> str', insertText: 'dumps(${1:obj}, indent=2, default=str)' },
                { name: 'loads', kind: 'function', detail: 'loads(s) -> Any' },
                { name: 'dump', kind: 'function', detail: 'dump(obj, fp, **kwargs) -> None' },
                { name: 'load', kind: 'function', detail: 'load(fp) -> Any' }
            ]
        },
        os: {
            kind: 'module',
            documentation: 'Standard-library OS interface. The AWS credentials injected by ' +
                'SignBridge are visible through os.environ.',
            members: [
                { name: 'environ', kind: 'variable', detail: 'os.environ', documentation: 'Process environment. AWS_REGION, AWS_ACCESS_KEY_ID, and friends live here.' },
                { name: 'getenv', kind: 'function', detail: 'getenv(key, default=None) -> str | None', insertText: "getenv('${1:AWS_REGION}', '${2:us-east-1}')" },
                { name: 'path', kind: 'module', detail: 'os.path' }
            ]
        }
    },

    java: {
        // Java completions are namespace hints: the package roots a user needs to
        // import, plus the SDK entry points.
        'software.amazon.awssdk': {
            kind: 'module',
            documentation: 'AWS SDK for Java v2. Service clients live under ' +
                'software.amazon.awssdk.services.<service>.',
            members: [
                { name: 'regions.Region', kind: 'class', detail: 'Region.of(String)', documentation: 'Region constants, e.g. Region.US_EAST_1 or Region.of("eu-west-1").' },
                { name: 'auth.credentials.DefaultCredentialsProvider', kind: 'class', detail: 'DefaultCredentialsProvider.create()', documentation: 'Resolves credentials from the environment — which is how the SignBridge profile reaches your code.' },
                { name: 'core.SdkBytes', kind: 'class', detail: 'SdkBytes.fromUtf8String(String)' },
                { name: 'services', kind: 'module', detail: 'software.amazon.awssdk.services.<service>', documentation: 'One package per service: sts, ec2, s3, dynamodb, lambda, ...' }
            ]
        },
        System: {
            kind: 'class',
            documentation: 'JDK System class.',
            members: [
                { name: 'out', kind: 'variable', detail: 'PrintStream', insertText: 'out.println(${1:""})' },
                { name: 'err', kind: 'variable', detail: 'PrintStream' },
                { name: 'getenv', kind: 'function', detail: 'getenv(String) -> String', insertText: 'getenv("${1:AWS_REGION}")' }
            ]
        }
    },

    javascript: {
        process: {
            kind: 'variable',
            documentation: 'Node process object.',
            members: [
                { name: 'env', kind: 'variable', detail: 'process.env', documentation: 'AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and (for SSO) AWS_SESSION_TOKEN are set by SignBridge.' },
                { name: 'argv', kind: 'variable', detail: 'string[]' },
                { name: 'exit', kind: 'function', detail: 'exit(code?: number): never' }
            ]
        }
    }
};

// TypeScript shares JavaScript's globals; Monaco's TypeScript worker supplies
// the rest for both.
LANGUAGE_GLOBALS.typescript = LANGUAGE_GLOBALS.javascript;

/**
 * The module-member completions for a language. Returns {} for a language we
 * have nothing extra to add for.
 */
function getLanguageGlobals(runtimeId) {
    return LANGUAGE_GLOBALS[String(runtimeId || '').toLowerCase()] || {};
}

// ---------------------------------------------------------------------------
// Service list + on-demand index loading
// ---------------------------------------------------------------------------

/**
 * The lightweight service list for the editor: enough to complete the string
 * inside `boto3.client('...')` without downloading a single model.
 */
function listServiceNames() {
    return awsCatalog.listServices().map(function (entry) {
        return { service: entry.service, label: entry.label };
    });
}

// Built indexes are cached in memory: a model is a few MB of JSON and parsing
// plus transforming it is not something to repeat per keystroke. Bounded, with
// least-recently-used eviction, so a curious user browsing every AWS service
// cannot grow the heap without limit.
const MAX_CACHED_SERVICES = 12;
const indexCache = new Map();

function cacheGet(key) {
    if (!indexCache.has(key)) {
        return null;
    }
    let value = indexCache.get(key);
    // Re-insert to mark as most recently used.
    indexCache.delete(key);
    indexCache.set(key, value);
    return value;
}

function cacheSet(key, value) {
    if (indexCache.has(key)) {
        indexCache.delete(key);
    }
    indexCache.set(key, value);
    while (indexCache.size > MAX_CACHED_SERVICES) {
        indexCache.delete(indexCache.keys().next().value);
    }
}

function clearCache() {
    indexCache.clear();
}

/**
 * Get (and cache) the completion index for one AWS service.
 *
 * @param {string} userName    owns the on-disk model cache
 * @param {string} serviceName botocore service name, e.g. 'ec2'
 * @param {object} [options]   { includeParams }
 * @returns {Promise<object>}  the index from buildIndexFromModel
 */
async function getServiceIndex(userName, serviceName, options) {
    options = options || {};
    let normalized = String(serviceName || '').trim().toLowerCase();
    let entry = awsCatalog.getServiceEntry(normalized);
    if (!entry) {
        let error = new Error('Unknown AWS service: "' + serviceName + '"');
        error.statusCode = 404;
        throw error;
    }
    let cacheKey = normalized + '|' + (options.includeParams === false ? 'noparams' : 'params');
    let cached = cacheGet(cacheKey);
    if (cached) {
        return cached;
    }
    let model = await awsCatalog.loadModel(userName, entry.service, entry.apiVersion);
    let index = buildIndexFromModel(model, entry, options);
    cacheSet(cacheKey, index);
    return index;
}

module.exports = {
    MAX_PARAMS_PER_OPERATION: MAX_PARAMS_PER_OPERATION,
    MAX_CACHED_SERVICES: MAX_CACHED_SERVICES,
    listServiceNames: listServiceNames,
    getLanguageGlobals: getLanguageGlobals,
    getServiceIndex: getServiceIndex,
    buildIndexFromModel: buildIndexFromModel,
    clearCache: clearCache,
    // Pure transforms, exported for tests and reuse.
    xformName: xformName,
    toCamelCase: toCamelCase,
    splitWords: splitWords,
    javaClientName: javaClientName,
    jsClientName: jsClientName,
    stripDocumentation: stripDocumentation,
    describeShapeType: describeShapeType,
    extractParams: extractParams
};

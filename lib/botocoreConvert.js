"use strict";

/**
 * botocoreConvert.js
 *
 * Convert an AWS botocore service model (`service-2.json`) into a Postman v2.1
 * collection object that SignBridge can import. Every operation becomes one
 * request, pre-filled with the correct HTTP method, endpoint, headers, and a
 * skeleton body for the service's wire protocol.
 *
 * The botocore models are the open (Apache-2.0), authoritative definition of
 * every AWS service's API:
 *   https://github.com/boto/botocore/tree/develop/botocore/data/<service>/<apiVersion>/service-2.json
 *
 * This is the single source of truth for the conversion, shared by:
 *   - lib/awsCatalog.js          (backend on-demand import)
 *   - scripts/botocore-to-collection.mjs (CLI, via a thin ESM re-export)
 *
 * No credentials are ever written into the collection — SignBridge attaches
 * real SigV4 credentials at invoke time.
 */

// Host for a service in a region. Most services follow
// <endpointPrefix>.<region>.amazonaws.com; a few are global and drop the region.
const GLOBAL_ENDPOINT_PREFIXES = new Set(['iam', 'route53', 'cloudfront']);

function endpointHost(endpointPrefix, region) {
    if (GLOBAL_ENDPOINT_PREFIXES.has(endpointPrefix)) {
        return endpointPrefix + '.amazonaws.com';
    }
    return endpointPrefix + '.' + region + '.amazonaws.com';
}

// Fill path placeholders like {Bucket}, {Key+}, {VersionNumber} with a readable
// token the user replaces before sending (rest-json / rest-xml services).
function fillPathPlaceholders(requestUri) {
    return requestUri.replace(/\{([^}]+)\}/g, function (_, name) {
        const clean = name.replace(/\+$/, '');
        return ':' + clean;
    });
}

// Build the per-operation request skeleton for a given wire protocol. Returns
// { headers: [{key,value}], body: {mode, raw|urlencoded} | null }.
function buildRequestForProtocol(protocol, op, meta) {
    const headers = [];
    const apiVersion = meta.apiVersion || '';

    switch (protocol) {
        case 'json': {
            // AWS JSON RPC (DynamoDB, etc.): X-Amz-Target + json content type.
            const jsonVersion = meta.jsonVersion || '1.0';
            headers.push({ key: 'Content-Type', value: 'application/x-amz-json-' + jsonVersion });
            if (meta.targetPrefix) {
                headers.push({ key: 'X-Amz-Target', value: meta.targetPrefix + '.' + op.name });
            }
            return { headers: headers, body: { mode: 'raw', raw: '{}' } };
        }
        case 'rest-json': {
            // REST JSON (Lambda, etc.): method + templated path, json body for writes.
            headers.push({ key: 'Content-Type', value: 'application/json' });
            const hasJsonBody = ['POST', 'PUT', 'PATCH'].includes((op.method || 'GET').toUpperCase());
            return { headers: headers, body: hasJsonBody ? { mode: 'raw', raw: '{}' } : null };
        }
        case 'rest-xml': {
            // REST XML (S3, etc.): method + templated path; body only for writes.
            const hasXmlBody = ['POST', 'PUT'].includes((op.method || 'GET').toUpperCase());
            if (hasXmlBody) headers.push({ key: 'Content-Type', value: 'application/xml' });
            return { headers: headers, body: hasXmlBody ? { mode: 'raw', raw: '' } : null };
        }
        case 'query':
        case 'ec2':
        default: {
            // AWS Query / EC2 (STS, EC2, etc.): POST /, form-urlencoded Action+Version.
            headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' });
            const urlencoded = [{ key: 'Action', value: op.name }];
            if (apiVersion) urlencoded.push({ key: 'Version', value: apiVersion });
            return { headers: headers, body: { mode: 'urlencoded', urlencoded: urlencoded } };
        }
    }
}

/**
 * Convert a parsed botocore model into a Postman v2.1 collection object.
 * @param {object} model  parsed service-2.json
 * @param {object} opts   { region?: string, only?: string[]|null }
 * @returns {object} Postman collection { info, item }
 */
function convert(model, opts) {
    opts = opts || {};
    const region = opts.region || 'us-east-1';
    const only = opts.only || null;

    const meta = model.metadata || {};
    const protocol = meta.protocol || (meta.protocols && meta.protocols[0]) || 'query';
    const endpointPrefix = meta.endpointPrefix || 'service';
    const serviceName = meta.serviceId || meta.serviceAbbreviation || endpointPrefix;
    const host = endpointHost(endpointPrefix, region);

    const operations = model.operations || {};
    const opNames = Object.keys(operations).sort();
    const selected = only ? opNames.filter(function (n) { return only.includes(n); }) : opNames;

    const items = selected.map(function (name) {
        const op = operations[name];
        const http = op.http || { method: 'POST', requestUri: '/' };
        const method = (http.method || 'POST').toUpperCase();
        const requestUri = fillPathPlaceholders(http.requestUri || '/');
        const rawUrl = 'https://' + host + requestUri;

        const built = buildRequestForProtocol(protocol, { name: name, method: method }, meta);

        // Trim botocore's verbose HTML doc down to a short plain-text description.
        const description = (op.documentation || '')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500);

        const url = new URL(rawUrl);
        const request = {
            method: method,
            header: built.headers,
            // AWS SigV4 — SignBridge attaches real credentials at invoke time.
            auth: { type: 'awsv4' },
            url: {
                raw: rawUrl,
                protocol: 'https',
                host: url.host.split('.'),
                path: url.pathname.split('/').filter(Boolean)
            },
            description: description
        };
        if (built.body) {
            request.body = built.body;
        }
        return { name: name, request: request };
    });

    return {
        info: {
            name: 'AWS ' + serviceName + ' (' + (meta.apiVersion || 'latest') + ')',
            description:
                'Generated from the botocore ' + endpointPrefix + ' model (protocol: ' + protocol + '). ' +
                'Endpoint host: ' + host + '. Fill in parameters before signing/invoking with SignBridge.',
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        item: items
    };
}

module.exports = {
    convert: convert,
    endpointHost: endpointHost
};

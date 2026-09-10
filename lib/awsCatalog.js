"use strict";

/**
 * awsCatalog.js
 *
 * On-demand AWS API catalog for the Templates page. The client sends only a
 * service name; the backend looks up the service in the bundled index, fetches
 * (and caches) the open botocore model, converts it to a Postman collection,
 * and imports it directly. No static per-service files, no rebuild, no restart.
 *
 * Air-gap friendly: models are cached under the user's artifacts dir, and the
 * model source (modelBaseUrl) is configurable so it can point at an internal
 * mirror. The service list itself is bundled, so the picker works offline.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const propertiesReader = require('properties-reader');

const paths = require('./paths');
const botocoreConvert = require('./botocoreConvert');

const props = propertiesReader(path.resolve(__dirname, '../config.properties'));

const MODEL_BASE_URL =
    props.get('awscatalog.modelBaseUrl') ||
    'https://raw.githubusercontent.com/boto/botocore/develop/botocore/data';
const MODEL_CACHE_DIR_NAME = props.get('awscatalog.modelCacheDirName') || 'awsmodelcache';
const DEFAULT_REGION = props.get('awscatalog.defaultRegion') || 'us-east-1';

// Bundled service index: [{ service, label, apiVersion }, ...] for every AWS
// service in botocore. Loaded once at require time.
const SERVICE_INDEX = require('./aws-service-index.json');

const serviceIndexByName = {};
(SERVICE_INDEX.services || []).forEach(function (s) {
    serviceIndexByName[s.service] = s;
});

function listServices() {
    return (SERVICE_INDEX.services || []).slice();
}

function getServiceEntry(serviceName) {
    return serviceIndexByName[serviceName] || null;
}

function modelCachePath(userName, serviceName, apiVersion) {
    const cacheDir = path.join(paths.getUserDir(userName), MODEL_CACHE_DIR_NAME);
    fs.mkdirSync(cacheDir, { recursive: true });
    return path.join(cacheDir, serviceName + '_' + apiVersion + '.json');
}

/**
 * Fetch a botocore service model, using the on-disk cache when present.
 * Returns the parsed model object.
 */
async function loadModel(userName, serviceName, apiVersion) {
    const cacheFile = modelCachePath(userName, serviceName, apiVersion);
    if (fs.existsSync(cacheFile)) {
        try {
            return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        } catch (e) {
            // Corrupt cache — fall through and refetch.
        }
    }
    const url = MODEL_BASE_URL + '/' + serviceName + '/' + apiVersion + '/service-2.json';
    const response = await axios.get(url, { responseType: 'json' });
    const model = response.data;
    try {
        fs.writeFileSync(cacheFile, JSON.stringify(model));
    } catch (e) {
        // Caching is best-effort; ignore write failures (e.g. read-only FS).
    }
    return model;
}

/**
 * Build a Postman collection object for the given service, on demand.
 * @param {string} userName
 * @param {string} serviceName  e.g. 'ec2'
 * @param {object} [opts]       { region?, only? }
 * @returns {Promise<{collection: object, entry: object}>}
 */
async function buildServiceCollection(userName, serviceName, opts) {
    opts = opts || {};
    const entry = getServiceEntry(serviceName);
    if (!entry) {
        throw new Error('Unknown AWS service: ' + serviceName);
    }
    const model = await loadModel(userName, serviceName, entry.apiVersion);
    const collection = botocoreConvert.convert(model, {
        region: opts.region || DEFAULT_REGION,
        only: opts.only || null
    });
    return { collection: collection, entry: entry };
}

module.exports = {
    listServices: listServices,
    getServiceEntry: getServiceEntry,
    buildServiceCollection: buildServiceCollection,
    // Exposed so the Sandbox IDE can build its autocomplete index from the same
    // cached botocore models the Templates page uses (lib/sandbox/sandboxCompletions.js).
    loadModel: loadModel,
    DEFAULT_REGION: DEFAULT_REGION
};

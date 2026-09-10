
/**
 * server.js — SignBridge Express + HTTPS + Socket.IO
 */

try {
    let fs = require('fs');
    // First, so every line below has somewhere to go. The catch at the bottom of
    // this file deliberately still uses console.error: it is the handler for
    // "requiring lib/ threw", where `log` may not exist yet.
    let log = require('./lib/logger').create('server');
    let propertiesReader = require('properties-reader');
    let authConfig = require('./lib/authConfig');
    let appConfig = require('./lib/appConfig');
    let paths = require('./lib/paths');
    let netGuard = require('./lib/netGuard');
    let certUtils = require('./lib/certUtils');
    let coreUtils = require('./lib/coreUtils');
    let https = require('https');
    const { constants } = require('crypto');
    let applicationRoot = __dirname;
    let express = require('express');
    let compression = require('compression');
    let path = require('path');
    let profileUtils = require('./lib/profileUtils');
    let requestSigner = require('./lib/requestSigner');
    let restAuth = require('./lib/restAuth');
    let curlUtils = require('./lib/curlUtils');
    let loadProfilesDaemon = require('./lib/loadProfilesDaemon');
    let ssoUtils = require('./lib/ssoUtils');
    let ec2Utils = require('./lib/ec2Utils');
    let irsaUtils = require('./lib/irsaUtils');
    let awsCliUtils = require('./lib/awsCliUtils');
    let chatService = require('./lib/chat/chatService');
    let sandboxService = require('./lib/sandbox/sandboxService');
    let sandboxRunner = require('./lib/sandbox/sandboxRunner');
    let s3World = require('./lib/s3/s3World');
    let llmService = require('./lib/llm/llmService');
    let propsFileName = 'config.properties';
    let props = propertiesReader(applicationRoot + '/' + propsFileName);
    let port = normalizePort(props.get('server.PORT') || 2443);
    let bindHost = netGuard.resolveBindHost(props, process.env);
    let allowedHosts = netGuard.resolveAllowedHosts(props);
    let routeBase = appConfig.getRouteBase();
    let dashboardPath = appConfig.getDashboardPath();

    let reactDist = path.join(applicationRoot, 'frontend/dist');
    let reactIndex = path.join(reactDist, 'index.html');
    if (!fs.existsSync(reactIndex)) {
        log.error('React build not found at frontend/dist/index.html — run: cd frontend && npm install && npm run build');
        process.exit(1);
    }

    let app = express();
    app.enable('strict routing');

    // Before anything else: this origin holds AWS credentials and has no login, so
    // decide whether we are willing to answer for the name in the Host header at
    // all, and set the headers that keep a browser from doing something with the
    // origin that the user did not ask for. See lib/netGuard.js for why each of
    // these exists — in particular, why binding loopback is not by itself enough.
    let baseSecurityHeaders = netGuard.securityHeaders();
    app.use(function (req, res, next) {
        if (!netGuard.isHostAllowed(req.headers.host, { allowedHosts: allowedHosts })) {
            log.warn('rejected request with unexpected Host header: ', String(req.headers.host));
            return res.status(421).type('text/plain').send(
                'SignBridge does not answer for this host name. It is reachable at '
                + 'https://localhost:' + port + dashboardPath + '. To serve another name, '
                + 'set [server] allowedHosts in config.properties.');
        }
        Object.keys(baseSecurityHeaders).forEach(function (name) {
            res.setHeader(name, baseSecurityHeaders[name]);
        });
        next();
    });

    // gzip all responses (the React bundle + Cloudscape CSS compress ~3-4x,
    // e.g. ~1MB JS -> ~300KB), cutting initial load and asset transfer time.
    app.use(compression());

    // express.json/urlencoded/raw rather than the standalone body-parser package:
    // Express bundles body-parser and re-exports exactly these, so depending on
    // it directly only pinned a second copy at a version of our own choosing.
    app.use(express.json({ limit: '20mb' }));
    app.use(express.urlencoded({
        limit: '20mb',
        extended: true,
        parameterLimit: 50000
    }));

    app.use(routeBase, (req, res, next) => {
        // The MCP endpoint carries raw JSON-RPC bodies; stamping userName onto
        // them would break the strict JSON-RPC schema. The MCP handler injects
        // the local user into each downstream API payload itself.
        if (req.path !== '/mcp') {
            authConfig.applyDefaultUserToRequest(req);
        }
        next();
    });

    let router = express.Router({
        caseSensitive: app.get('case sensitive routing'),
        strict: app.get('strict routing')
    });
    app.use(routeBase, router);

    app.get('/', (req, res) => {
        res.redirect(dashboardPath);
    });

    app.get('/index.html', (req, res) => {
        res.redirect(dashboardPath);
    });

    // No login: expose the single local-user session for the SPA if it asks.
    router.get('/session', (req, res) => {
        res.status(200).json(authConfig.getDefaultUserSession());
    });

    // --- API routes ---
    router.post('/getRoleCredentialsForUser', ssoUtils.getRoleCredentialsForUser);
    router.post('/invokeCommand', awsCliUtils.invokeCommand);

    router.post('/populateProfilesDetails', profileUtils.populateProfilesDetails);
    router.post('/populateHistoryDetails', profileUtils.populateHistoryDetails);
    router.post('/populateFavoriteDetails', profileUtils.populateFavoriteDetails);
    router.post('/populateSettingsDetails', profileUtils.populateSettingsDetails);
    router.post('/updateSettingsDetails', profileUtils.updateSettingsDetails);
    router.post('/addProfileDetails', profileUtils.addProfileDetails);
    router.post('/searchProfilesDetails', profileUtils.searchProfilesDetails);
    router.post('/updateProfileDetails', profileUtils.updateProfileDetails);
    router.post('/deleteProfileDetails', profileUtils.deleteProfileDetails);
    router.post('/deleteHistoryDetailsForTheGivenRequest', coreUtils.deleteHistoryDetailsForTheGivenRequest);
    router.post('/deleteFavoriteDetailsForTheGivenRequest', coreUtils.deleteFavoriteDetailsForTheGivenRequest);
    router.post('/getHistoryDetailsForTheGivenRequest', coreUtils.getHistoryDetailsForTheGivenRequest);
    router.post('/getFavoriteDetailsForTheGivenRequest', coreUtils.getFavoriteDetailsForTheGivenRequest);
    router.post('/addHistoryToFavorites', profileUtils.addHistoryToFavorites);
    router.post('/applyLabelForTheGivenRequest', coreUtils.applyLabelForTheGivenRequest);
    router.post('/applyLabelForTheGivenFavoriteRequest', coreUtils.applyLabelForTheGivenFavoriteRequest);
    router.post('/importCollection', coreUtils.importCollection);
    router.get('/awsCatalogServices', coreUtils.listAwsCatalogServices);
    router.post('/importAwsCatalogService', coreUtils.importAwsCatalogService);
    router.post('/deleteCollection', coreUtils.deleteCollection);
    router.post('/deleteRequestFromCollection', coreUtils.deleteRequestFromCollection);
    router.post('/populateCollectionsDetails', coreUtils.populateCollectionsDetails);
    router.post('/checkProfileExists', profileUtils.checkProfileExists);

    router.post('/generateAuthResponse', requestSigner.generateAuthResponse);
    router.post('/generateAuthResponseAndInvoke', requestSigner.generateAuthResponseAndInvoke);
    router.post('/generateAuthResponseAndInvokeRestBasicAuth', restAuth.generateAuthResponseAndInvokeRestBasicAuth);
    router.post('/generateAuthResponseAndInvokeRestBearerToken', restAuth.generateAuthResponseAndInvokeRestBearerToken);
    router.post('/generateAuthResponseAndInvokeGeneric', restAuth.generateAuthResponseAndInvokeGeneric);
    router.post('/testBearerTokenConnection', restAuth.testBearerTokenConnection);
    router.post('/copyBearerToken', restAuth.copyBearerToken);

    // --- EC2 instance-role profiles ---
    // Test Connection: SSH in with the profile's credentials and read IMDSv2, so
    // the user finds out the login and the instance role work while they are still
    // on the profile form rather than on their first invocation.
    router.post('/testEc2Connection', ec2Utils.testEc2Connection);

    // --- IRSA (EKS service account) profiles ---
    // The profile form is a cascade — base AWS profile, region, cluster, service
    // account — so each step has a discovery route. None of them needs kubectl on
    // this host: see the header comment in lib/irsaUtils.js.
    router.post('/listIrsaClusters', irsaUtils.listIrsaClusters);
    router.post('/listIrsaServiceAccounts', irsaUtils.listIrsaServiceAccounts);
    router.post('/describeIrsaRole', irsaUtils.describeIrsaRole);
    router.post('/testIrsaConnection', irsaUtils.testIrsaConnection);
    // "Copy as curl" — prepares (never invokes / never persists) the exact
    // request so it can be shared for debugging/triaging.
    router.post('/prepareCurlRequest', curlUtils.prepareCurlRequest);
    router.post('/chat', chatService.handleChat);
    router.post('/chatThreads', chatService.handleListThreads);
    router.post('/chatThread', chatService.handleGetThread);
    router.post('/chatNewThread', chatService.handleNewThread);
    router.post('/chatRenameThread', chatService.handleRenameThread);
    router.post('/chatSummarizeThread', chatService.handleSummarizeThread);
    router.post('/chatDeleteThread', chatService.handleDeleteThread);

    // --- LLM configuration: providers, keys, model selection ---
    // The API key comes from here rather than from .env: the user picks a
    // provider, pastes a key they created in that provider's console, verifies
    // it, and chooses a model, all at runtime. SignBridge never creates or
    // exchanges a provider credential itself — see lib/llm/providers.js.
    router.post('/llmProviders', llmService.getLlmProviders);
    router.post('/llmSettings', llmService.getLlmSettings);
    router.post('/updateLlmSettings', llmService.updateLlmSettings);
    router.post('/selectLlmModel', llmService.selectLlmModel);
    router.post('/deleteLlmKey', llmService.deleteLlmKey);
    router.post('/testLlmConnection', llmService.testLlmConnection);
    router.post('/listLlmModels', llmService.listLlmModels);

    // --- Sandbox mode: run user code against the selected profile ---
    router.post('/sandboxRuntimes', sandboxService.getSandboxRuntimes);
    router.post('/sandboxTemplate', sandboxService.getSandboxTemplate);
    router.post('/sandboxCompletions', sandboxService.getSandboxCompletions);
    router.post('/runSandbox', sandboxService.runSandbox);
    router.post('/checkSandbox', sandboxService.checkSandbox);
    router.post('/cancelSandbox', sandboxService.cancelSandbox);
    router.post('/listSandboxScripts', sandboxService.listSandboxScripts);
    router.post('/getSandboxScript', sandboxService.getSandboxScript);
    router.post('/saveSandboxScript', sandboxService.saveSandboxScript);
    router.post('/deleteSandboxScript', sandboxService.deleteSandboxScript);

    // --- S3 World: browse buckets, search recursively, view object contents ---
    router.post('/s3ListBuckets', s3World.listBuckets);
    router.post('/s3BucketRegion', s3World.getBucketRegion);
    router.post('/s3ListObjects', s3World.listObjects);
    router.post('/s3HeadObject', s3World.headObject);
    router.post('/s3PresignView', s3World.presignView);
    router.post('/s3PreviewObject', s3World.previewObject);
    router.post('/s3SearchObjects', s3World.searchObjects);
    router.post('/s3CancelSearch', s3World.cancelSearch);
    router.post('/s3ExplainSearch', s3World.explainSearch);
    router.post('/s3CreateFolder', s3World.createFolder);
    router.post('/s3DeleteObjects', s3World.deleteObjects);
    router.post('/s3CopyObjects', s3World.copyObjects);

    // GET, because this is used as an <img>/<video>/<iframe> source and as a
    // download target — contexts that cannot POST or set request headers. The
    // handler serves untrusted bytes, so it forces `attachment` for anything
    // outside the inline-safe allowlist and sends nosniff + a locked-down CSP.
    router.get('/s3Object', s3World.proxyObject);

    // Uploads arrive as a raw body rather than base64 in JSON, so a 50 MB file
    // does not become a 67 MB string. Parameters ride on the query string
    // because a raw-body route cannot also carry JSON.
    router.put('/s3UploadObject',
        express.raw({ type: function() { return true; }, limit: '100mb' }),
        s3World.uploadObject);

    // --- MCP over HTTP (same process as UI + API) ---
    // The MCP code is ESM; load it lazily via dynamic import and cache the
    // handler. AI clients that speak Streamable HTTP connect to {routeBase}/mcp.
    let mcpHandlerPromise = null;
    function getMcpHandler() {
        if (!mcpHandlerPromise) {
            let apiBase = 'https://localhost:' + port + routeBase;
            mcpHandlerPromise = import('./mcp/mcpHttp.mjs').then(function(mod) {
                return mod.createMcpHttpHandler({
                    apiBase: apiBase,
                    userName: authConfig.getDefaultUserName()
                });
            });
        }
        return mcpHandlerPromise;
    }
    function routeToMcp(req, res) {
        getMcpHandler().then(function(handler) {
            return handler(req, res);
        }).catch(function(err) {
            log.error('failed to initialize MCP HTTP handler: ', err.message);
            if (!res.headersSent) {
                res.status(500).json({ message: 'MCP handler initialization failed' });
            }
        });
    }
    router.post('/mcp', routeToMcp);
    router.get('/mcp', routeToMcp);
    router.delete('/mcp', routeToMcp);

    // --- React SPA static assets + client routes ---
    // Vite emits content-hashed filenames under assets/ (e.g. index-<hash>.js),
    // so those are safe to cache for a year as immutable. index.html itself must
    // never be cached, so the browser always picks up the latest asset hashes.
    router.use(express.static(reactDist, {
        index: false,
        setHeaders: function(res, filePath) {
            if (filePath.endsWith('index.html')) {
                res.setHeader('Cache-Control', 'no-cache');
            } else if (filePath.indexOf(path.sep + 'assets' + path.sep) !== -1) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
        }
    }));

    router.get('/', (req, res) => {
        res.redirect(dashboardPath);
    });

    let spaRoutes = [
        '/dashboard',
        '/chat',
        '/sandbox',
        '/s3world',
        // The standalone object viewer opens in a new tab, so it must survive a
        // direct hit and a refresh. These are exact paths, not prefixes.
        '/s3world/object',
        '/profiles',
        '/history',
        '/favorites',
        '/templates',
        '/settings',
        '/about'
    ];
    spaRoutes.forEach(function(routePath) {
        router.get(routePath, function(req, res) {
            // Never cache the HTML shell — it references hash-named assets, so a
            // stale shell would point at old bundles after a rebuild.
            res.setHeader('Cache-Control', 'no-cache');
            res.sendFile(reactIndex);
        });
    });

    let keyName = props.get('ssl.KEYNAME') || 'signbridge_key.pem';
    let certName = props.get('ssl.CERTNAME') || 'signbridge_cert.pem';
    let keysDir = paths.getKeysDir();
    // Generate a self-signed pair on first run if none exists.
    let tlsPair = certUtils.ensureCerts(keysDir, keyName, certName);
    if (tlsPair.generated) {
        log.info('Generated self-signed TLS certificate in ' + keysDir);
    }

    let sslOptions = {
        key: tlsPair.key,
        cert: tlsPair.cert,
        secureProtocol: 'TLSv1_2_method',
        secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1
    };
    let server = https.createServer(sslOptions, app);
    let sslServerSocketIo = require('socket.io')(server);
    sslServerSocketIo.on('connection', coreUtils.socketEventMgmt);
    server.listen(port, bindHost);
    server.on('error', onError);
    server.on('listening', onListening);

    function normalizePort(val) {
        let parsed = parseInt(val, 10);
        if (isNaN(parsed)) {
            return val;
        }
        if (parsed >= 0) {
            return parsed;
        }
        return false;
    }

    function onError(error) {
        if (error.syscall !== 'listen') {
            throw error;
        }
        let bind = typeof port === 'string' ? 'Pipe ' + port : 'Port ' + port;
        switch (error.code) {
            case 'EACCES':
                log.error(bind + ' requires elevated privileges. Exiting now');
                process.exit(1);
                break;
            case 'EADDRINUSE':
                log.error(bind + ' is already in use. Exiting now.');
                process.exit(1);
                break;
            default:
                throw error;
        }
    }

    function onListening() {
        loadProfilesDaemon.loadHomeProfiles(function(err) {
            if (err) {
                log.warn('AWS profile sync warning: ', err.message);
            } else {
                log.info('profiles loaded from ~/.aws during startup');
            }
            // A crash or restart can leave per-run sandbox workspaces behind;
            // clear the old ones out rather than letting them accumulate.
            try {
                let swept = sandboxRunner.cleanupStaleWorkspaces(authConfig.getDefaultUserName());
                if (swept > 0) {
                    log.info('Sandbox: removed ' + swept + ' stale run workspace(s)');
                }
            } catch (sweepErr) {
                log.warn('Sandbox: workspace cleanup skipped: ', sweepErr.message);
            }
            // Report sandbox readiness once at startup so the setup step is
            // visible in the logs, not just on the first failed Run.
            sandboxRunner.preflight(function(preflightErr, sandboxStatus) {
                if (preflightErr) {
                    log.warn('Sandbox: readiness check failed: ', preflightErr.message);
                } else if (sandboxStatus.ok) {
                    log.info('Sandbox: ready (image ' + sandboxStatus.image + ')');
                } else {
                    log.info('Sandbox: not ready — ' + sandboxStatus.message);
                }
            });
            log.info(appConfig.getDisplayName() + ' is listening on https://localhost:' + port +
                dashboardPath + ' (' + app.settings.env + ' mode, log level ' +
                require('./lib/logger').getLevel() + ', bound to ' + bindHost + ')');
            // There is no login, so a non-loopback bind is worth a line — but what
            // the line should say depends on whether we are in a container, where
            // 0.0.0.0 is mandatory and the host-side port publish is what limits
            // access. netGuard owns that wording; see describeBindExposure.
            let exposure = netGuard.describeBindExposure(bindHost, {
                port: port,
                container: netGuard.isContainer()
            });
            if (exposure) {
                log[exposure.level](exposure.message);
            }
        });
    }
} catch (err) {
    // The one deliberate console.* left in the app: this catch covers a failure to
    // require lib/ at all, in which case the logger is exactly the thing that is
    // not available. Everything else goes through lib/logger.js.
    console.error('error occurred in starting the server:');
    console.error(err);
    throw err;
}

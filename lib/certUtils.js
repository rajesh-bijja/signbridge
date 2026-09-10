"use strict";

/**
 * certUtils.js
 *
 * Ensures a self-signed TLS certificate/key pair exists for the HTTPS server.
 *
 * SignBridge serves HTTPS only. Rather than require a manual pre-step, the
 * server calls ensureCerts() on startup: if the key/cert are missing from the
 * keys directory, a fresh self-signed pair (CN=localhost, SAN localhost +
 * 127.0.0.1) is generated with node-forge and written there. Existing certs
 * are left untouched.
 */

let fs = require('fs');
let path = require('path');
let forge = require('node-forge');

// Generate a self-signed cert/key pair as PEM strings.
function generateSelfSigned(commonName, days) {
    let keys = forge.pki.rsa.generateKeyPair(2048);
    let cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));

    let now = new Date();
    cert.validity.notBefore = now;
    let notAfter = new Date(now.getTime());
    notAfter.setDate(notAfter.getDate() + days);
    cert.validity.notAfter = notAfter;

    let attrs = [{ name: 'commonName', value: commonName }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: 'localhost' }, // DNS
                { type: 7, ip: '127.0.0.1' }      // IP
            ]
        }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}

/**
 * Make sure the key/cert exist in keysDir; generate them if not.
 * Returns { key, cert } as Buffers ready for https.createServer.
 *
 *   keysDir  — directory to hold the pem files
 *   keyName  — key file name (from [ssl] KEYNAME)
 *   certName — cert file name (from [ssl] CERTNAME)
 */
function ensureCerts(keysDir, keyName, certName) {
    let keyPath = path.join(keysDir, keyName);
    let certPath = path.join(keysDir, certName);

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), generated: false };
    }

    fs.mkdirSync(keysDir, { recursive: true });
    let pair = generateSelfSigned('localhost', 825);
    fs.writeFileSync(keyPath, pair.key, { mode: 0o600 });
    fs.writeFileSync(certPath, pair.cert);
    return { key: Buffer.from(pair.key), cert: Buffer.from(pair.cert), generated: true };
}

module.exports = {
    ensureCerts: ensureCerts,
    generateSelfSigned: generateSelfSigned
};

"use strict";

let path = require('path');
let propertiesReader = require('properties-reader');

let props = propertiesReader(path.resolve(__dirname, '../config.properties'));

function getRoutePrefix() {
    return props.get('app.routePrefix') || 'signbridge';
}

function getRouteBase() {
    return '/' + getRoutePrefix();
}

function getDashboardPath() {
    return getRouteBase() + '/dashboard';
}

function getProjectName() {
    return props.get('app.projectName') || 'signbridge';
}

function getDisplayName() {
    return props.get('app.displayName') || 'SignBridge';
}

function getTagline() {
    return props.get('app.tagline') || 'Presign URLs. Invoke APIs. Bridge IAM & SSO roles.';
}

function getEngineName() {
    return props.get('app.engineName') || 'SignBridge';
}

function getAuthModeLabels() {
    return {
        iam_user: props.get('app.authLabel.iamUser') || 'AWS IAM User',
        sso_user: props.get('app.authLabel.ssoUser') || 'AWS SSO / IAM Identity Center',
        ec2_instance: props.get('app.authLabel.ec2Instance') || 'AWS EC2 Instance Role',
        irsa: props.get('app.authLabel.irsa') || 'AWS IRSA (EKS Service Account)',
        rest_basic_auth: props.get('app.authLabel.restBasic') || 'Basic Auth',
        rest_bearer_token: props.get('app.authLabel.restBearer') || 'Bearer Token',
        generic: props.get('app.authLabel.generic') || 'Generic REST (no signing)'
    };
}

module.exports = {
    getRoutePrefix: getRoutePrefix,
    getRouteBase: getRouteBase,
    getDashboardPath: getDashboardPath,
    getProjectName: getProjectName,
    getDisplayName: getDisplayName,
    getTagline: getTagline,
    getEngineName: getEngineName,
    getAuthModeLabels: getAuthModeLabels
};

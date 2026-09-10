"use strict";

// The SSO device-authorization message a user actually reads.
//
// This app used to be an Oracle JET UI that injected error messages as markup, so
// the "authorization is still pending" error was built as an HTML fragment. The
// React UI, the chat agent and MCP clients all render it as *text*, so that markup
// leaked into the error panel as literal `<html><body>` tags. These tests pin the
// message to plain text — the clickable link is a separate field on the error
// (`verificationUriComplete`), not something smuggled into the message.

const test = require('node:test');
const assert = require('node:assert/strict');

const ssoUtils = require('../lib/ssoUtils');

const URI = 'https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH';

test('the pending-authorization message contains no markup', () => {
    let message = ssoUtils.formatAuthorizationPendingMessage(
        'Authorization is still pending', URI);
    for (const fragment of ['<html', '<body', '<a ', '</a>', '<br', '&nbsp;', 'href=']) {
        assert.ok(!message.includes(fragment),
            'message must not contain ' + fragment + ' — got: ' + message);
    }
    // Nothing that looks like a tag at all.
    assert.ok(!/<[^>]+>/.test(message), message);
});

test('it names the URL and tells the user what to do next', () => {
    let message = ssoUtils.formatAuthorizationPendingMessage(
        'Authorization is still pending', URI);
    // Text-only clients (MCP, a terminal) have no other way to reach the link.
    assert.ok(message.includes(URI));
    assert.match(message, /retry/i);
});

test('it reads as one sentence whether or not AWS punctuated its description', () => {
    // AWS sends "Authorization is still pending" with no trailing period, but a
    // duplicated ".." would be the kind of small ugliness this message exists to
    // avoid, so a trailing period is absorbed rather than doubled.
    let withDot = ssoUtils.formatAuthorizationPendingMessage(
        'Authorization is still pending.', URI);
    let withoutDot = ssoUtils.formatAuthorizationPendingMessage(
        'Authorization is still pending', URI);
    assert.equal(withDot, withoutDot);
    assert.ok(!withDot.includes('..'), withDot);
});

test('a missing description still yields a usable sentence', () => {
    // Defensive: the field is AWS-supplied, and an empty message with a bare URL
    // would tell the user nothing.
    let message = ssoUtils.formatAuthorizationPendingMessage(undefined, URI);
    assert.match(message, /^Authorization is still pending\./);
    assert.ok(message.includes(URI));
});

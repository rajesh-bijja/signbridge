"use strict";

/**
 * sandboxRuntimes.js
 *
 * The language registry for Sandbox mode — the third invocation mode alongside
 * Rest_Api and Cli. Each runtime describes everything the rest of the sandbox
 * needs to know about a language:
 *
 *   - where the user's code is written inside the container workspace
 *   - the argv that RUNS it
 *   - the argv that only SYNTAX/TYPE-CHECKS it (for the "Validate" action and
 *     the red squiggles in the editor)
 *   - which diagnostics parser turns that checker's stderr into editor markers
 *   - the Monaco language id for syntax highlighting / IntelliSense
 *   - starter templates
 *
 * This module is intentionally PURE data + pure functions (no fs, no child
 * process, no network) so the registry and the argv it produces are unit
 * testable without Docker. All execution lives in sandboxRunner.js.
 *
 * Paths are container-absolute: the runner bind-mounts the per-run workspace at
 * WORKSPACE_DIR, so `/workspace/main.py` is valid inside the sandbox image
 * regardless of where the host directory actually lives.
 */

// Where the per-run workspace is mounted inside the sandbox container.
const WORKSPACE_DIR = '/workspace';

// Java's single-file source launcher requires the public class name to match the
// file name, so the sandbox fixes both. Surfaced to the UI so the editor can
// warn instead of letting the run fail with a confusing compiler error.
const JAVA_CLASS_NAME = 'Main';

function workspacePath(fileName) {
    return WORKSPACE_DIR + '/' + fileName;
}

const PYTHON_AWS_TEMPLATE = `"""
SignBridge Sandbox - Python (boto3)

The AWS credentials for the profile you selected are already in this
environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN /
AWS_REGION), so boto3 picks them up with no configuration. For an SSO profile
these are freshly minted, short-lived role credentials.

Press Run (or Ctrl/Cmd+Enter) to execute.
"""

import json
import os

import boto3

region = os.environ.get("AWS_REGION", "us-east-1")

# Who am I? A good first call to confirm the injected identity.
sts = boto3.client("sts", region_name=region)
identity = sts.get_caller_identity()
print("Caller identity:")
print(json.dumps({k: v for k, v in identity.items() if k != "ResponseMetadata"}, indent=2))

# Any AWS API is available. Type "ec2." below to see the operations boto3
# exposes for the service.
ec2 = boto3.client("ec2", region_name=region)
regions = ec2.describe_regions()["Regions"]
print(f"\\n{len(regions)} enabled regions:")
for entry in sorted(r["RegionName"] for r in regions):
    print(f"  - {entry}")
`;

const PYTHON_REST_TEMPLATE = `"""
SignBridge Sandbox - Python (generic REST)

requests and urllib are available. Use this for non-AWS APIs, or to call an
AWS endpoint with a presigned URL you generated on the Dashboard.
"""

import json

import requests

response = requests.get("https://httpbin.org/get", timeout=15)
print("status:", response.status_code)
print(json.dumps(response.json(), indent=2))
`;

const JAVASCRIPT_AWS_TEMPLATE = `/**
 * SignBridge Sandbox - JavaScript (AWS SDK v3)
 *
 * Credentials for the selected profile are already in process.env
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_REGION),
 * so the SDK's default provider chain finds them with no configuration.
 *
 * Top-level await works - this runs as an ES module.
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2'

const region = process.env.AWS_REGION || 'us-east-1'

const sts = new STSClient({ region })
const identity = await sts.send(new GetCallerIdentityCommand({}))
console.log('Caller identity:')
console.log(JSON.stringify({ Account: identity.Account, Arn: identity.Arn }, null, 2))

const ec2 = new EC2Client({ region })
const { Regions } = await ec2.send(new DescribeRegionsCommand({}))
console.log(\`\\n\${Regions.length} enabled regions:\`)
for (const entry of Regions.map(r => r.RegionName).sort()) {
  console.log('  -', entry)
}
`;

const JAVASCRIPT_REST_TEMPLATE = `/**
 * SignBridge Sandbox - JavaScript (generic REST)
 *
 * axios and the built-in fetch are both available.
 */

const response = await fetch('https://httpbin.org/get')
console.log('status:', response.status)
console.log(JSON.stringify(await response.json(), null, 2))
`;

const TYPESCRIPT_AWS_TEMPLATE = `/**
 * SignBridge Sandbox - TypeScript (AWS SDK v3)
 *
 * Fully typed: hover any SDK symbol for its signature, and the editor
 * type-checks as you type. Credentials for the selected profile are already in
 * process.env, so the SDK's default provider chain finds them.
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { EC2Client, DescribeRegionsCommand } from '@aws-sdk/client-ec2'

const region: string = process.env.AWS_REGION || 'us-east-1'

const sts = new STSClient({ region })
const identity = await sts.send(new GetCallerIdentityCommand({}))
console.log('Caller identity:', identity.Arn)

const ec2 = new EC2Client({ region })
const { Regions = [] } = await ec2.send(new DescribeRegionsCommand({}))
console.log(\`\\n\${Regions.length} enabled regions:\`)
for (const name of Regions.map(r => r.RegionName!).sort()) {
  console.log('  -', name)
}
`;

const TYPESCRIPT_REST_TEMPLATE = `/**
 * SignBridge Sandbox - TypeScript (generic REST)
 */

interface HttpBinResponse {
  url: string
  headers: Record<string, string>
}

const response = await fetch('https://httpbin.org/get')
const body = (await response.json()) as HttpBinResponse
console.log('status:', response.status)
console.log('url:', body.url)
`;

const JAVA_AWS_TEMPLATE = `/**
 * SignBridge Sandbox - Java (AWS SDK v2)
 *
 * Credentials for the selected profile are in the environment, so
 * DefaultCredentialsProvider picks them up with no configuration.
 *
 * The class MUST be named ${JAVA_CLASS_NAME} - the sandbox runs this file with
 * Java's single-file source launcher.
 */

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.sts.StsClient;
import software.amazon.awssdk.services.sts.model.GetCallerIdentityResponse;
import software.amazon.awssdk.services.ec2.Ec2Client;
import software.amazon.awssdk.services.ec2.model.DescribeRegionsResponse;

public class ${JAVA_CLASS_NAME} {
    public static void main(String[] args) {
        Region region = Region.of(System.getenv().getOrDefault("AWS_REGION", "us-east-1"));

        try (StsClient sts = StsClient.builder().region(region).build()) {
            GetCallerIdentityResponse identity = sts.getCallerIdentity();
            System.out.println("Caller identity:");
            System.out.println("  account: " + identity.account());
            System.out.println("  arn:     " + identity.arn());
        }

        try (Ec2Client ec2 = Ec2Client.builder().region(region).build()) {
            DescribeRegionsResponse response = ec2.describeRegions();
            List<String> names = new ArrayList<>();
            response.regions().forEach(r -> names.add(r.regionName()));
            Collections.sort(names);
            System.out.println("\\n" + names.size() + " enabled regions:");
            names.forEach(name -> System.out.println("  - " + name));
        }
    }
}
`;

const JAVA_REST_TEMPLATE = `/**
 * SignBridge Sandbox - Java (generic REST)
 *
 * Uses the JDK's built-in HttpClient - no extra dependency needed.
 */

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class ${JAVA_CLASS_NAME} {
    public static void main(String[] args) throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("https://httpbin.org/get"))
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        System.out.println("status: " + response.statusCode());
        System.out.println(response.body());
    }
}
`;

/**
 * The runtime registry. Keys are the stable runtime ids used on the wire (the
 * UI, the API payloads, and the MCP tool all speak these).
 */
const RUNTIMES = {
    python: {
        id: 'python',
        label: 'Python',
        // Monaco's language id, used for highlighting + our AWS completion provider.
        monacoLanguage: 'python',
        fileName: 'main.py',
        // Shown in the UI so users know what's preinstalled.
        libraries: ['boto3', 'botocore', 'requests', 'urllib3'],
        // -u: unbuffered, so print() output streams live instead of arriving in
        // one chunk when the process exits.
        runArgv: ['python3', '-u', workspacePath('main.py')],
        // py_compile reports syntax errors only (no type checking), which is the
        // honest limit of what we can check without a full language server.
        checkArgv: ['python3', '-m', 'py_compile', workspacePath('main.py')],
        checkKind: 'syntax',
        diagnosticsParser: 'python',
        templates: [
            { id: 'aws', label: 'AWS (boto3)', code: PYTHON_AWS_TEMPLATE },
            { id: 'rest', label: 'Generic REST', code: PYTHON_REST_TEMPLATE }
        ]
    },

    javascript: {
        id: 'javascript',
        label: 'JavaScript',
        monacoLanguage: 'javascript',
        // .mjs so Node always treats it as an ES module and top-level await works.
        fileName: 'main.mjs',
        libraries: ['@aws-sdk/* (v3)', 'aws-sdk (v2)', 'axios', 'fetch'],
        runArgv: ['node', workspacePath('main.mjs')],
        checkArgv: ['node', '--check', workspacePath('main.mjs')],
        checkKind: 'syntax',
        diagnosticsParser: 'node',
        templates: [
            { id: 'aws', label: 'AWS SDK v3', code: JAVASCRIPT_AWS_TEMPLATE },
            { id: 'rest', label: 'Generic REST', code: JAVASCRIPT_REST_TEMPLATE }
        ]
    },

    typescript: {
        id: 'typescript',
        label: 'TypeScript',
        monacoLanguage: 'typescript',
        // .mts for the same reason JavaScript uses .mjs, and it matters more here:
        // tsx picks its output format from the nearest package.json, and the
        // read-only workspace deliberately has none, so a plain .ts was
        // transpiled to CommonJS and every `await` at the top level of the
        // starter template died with "Top-level await is currently not supported
        // with the cjs output format". The extension settles it with no extra
        // file to mount.
        fileName: 'main.mts',
        libraries: ['@aws-sdk/* (v3)', 'aws-sdk (v2)', 'axios', 'tsx', 'typescript'],
        // tsx transpiles and runs in one step, and understands top-level await.
        runArgv: ['tsx', workspacePath('main.mts')],
        // A real type check (not just syntax): this is what surfaces "Property
        // 'foo' does not exist on type ..." as an editor marker.
        checkArgv: [
            'tsc',
            '--noEmit',
            '--skipLibCheck',
            '--target', 'es2022',
            '--module', 'esnext',
            '--moduleResolution', 'bundler',
            '--types', 'node',
            workspacePath('main.mts')
        ],
        checkKind: 'types',
        diagnosticsParser: 'typescript',
        templates: [
            { id: 'aws', label: 'AWS SDK v3', code: TYPESCRIPT_AWS_TEMPLATE },
            { id: 'rest', label: 'Generic REST', code: TYPESCRIPT_REST_TEMPLATE }
        ]
    },

    java: {
        id: 'java',
        label: 'Java',
        monacoLanguage: 'java',
        fileName: JAVA_CLASS_NAME + '.java',
        requiredClassName: JAVA_CLASS_NAME,
        libraries: ['AWS SDK v2 (sts, ec2, s3, dynamodb, lambda, ...)', 'java.net.http'],
        // Single-file source launcher (Java 11+): compiles in memory and runs
        // main() without a build file. CLASSPATH in the image supplies the SDK.
        //
        // The tuning flags keep the JVM inside the container's memory cap and cut
        // startup time (a user script is short-lived, so the JIT's top tier never
        // pays for itself). They are passed here rather than as JAVA_TOOL_OPTIONS
        // in the image, because that environment variable makes the JVM print a
        // "Picked up ..." line to stderr on every run — noise in the user's
        // console that looks like it came from their own code.
        runArgv: [
            'java',
            '-XX:+UseSerialGC',
            '-XX:TieredStopAtLevel=1',
            '-XX:MaxRAMPercentage=75',
            workspacePath(JAVA_CLASS_NAME + '.java')
        ],
        // -d to a scratch dir so javac writes classes nowhere the user sees;
        // -proc:none skips annotation processing for a faster check.
        checkArgv: [
            'javac',
            '-proc:none',
            '-nowarn',
            '-d', '/tmp/javac-out',
            workspacePath(JAVA_CLASS_NAME + '.java')
        ],
        checkKind: 'compile',
        diagnosticsParser: 'java',
        templates: [
            { id: 'aws', label: 'AWS SDK v2', code: JAVA_AWS_TEMPLATE },
            { id: 'rest', label: 'Generic REST', code: JAVA_REST_TEMPLATE }
        ]
    }
};

// Stable display order for the language picker.
const RUNTIME_ORDER = ['python', 'javascript', 'typescript', 'java'];

function listRuntimeIds() {
    return RUNTIME_ORDER.slice();
}

function getRuntime(runtimeId) {
    if (!runtimeId) {
        return null;
    }
    return RUNTIMES[String(runtimeId).toLowerCase()] || null;
}

function isSupportedRuntime(runtimeId) {
    return !!getRuntime(runtimeId);
}

/**
 * The runtime list for the UI / MCP: everything a client needs to render the
 * language picker and the template menu, with no execution details leaked.
 */
function describeRuntimes() {
    return RUNTIME_ORDER.map(function (id) {
        let runtime = RUNTIMES[id];
        return {
            id: runtime.id,
            label: runtime.label,
            monacoLanguage: runtime.monacoLanguage,
            fileName: runtime.fileName,
            libraries: runtime.libraries.slice(),
            checkKind: runtime.checkKind,
            requiredClassName: runtime.requiredClassName || null,
            templates: runtime.templates.map(function (template) {
                return { id: template.id, label: template.label };
            })
        };
    });
}

/**
 * Starter code for a runtime. Falls back to the runtime's first template when
 * the requested template id is unknown, so a stale client can't 404 the editor.
 */
function getTemplate(runtimeId, templateId) {
    let runtime = getRuntime(runtimeId);
    if (!runtime) {
        return null;
    }
    let templates = runtime.templates;
    let match = null;
    if (templateId) {
        match = templates.filter(function (t) { return t.id === templateId; })[0] || null;
    }
    if (!match) {
        match = templates[0];
    }
    return {
        runtimeId: runtime.id,
        templateId: match.id,
        label: match.label,
        fileName: runtime.fileName,
        code: match.code
    };
}

module.exports = {
    WORKSPACE_DIR: WORKSPACE_DIR,
    JAVA_CLASS_NAME: JAVA_CLASS_NAME,
    RUNTIME_ORDER: RUNTIME_ORDER,
    listRuntimeIds: listRuntimeIds,
    getRuntime: getRuntime,
    isSupportedRuntime: isSupportedRuntime,
    describeRuntimes: describeRuntimes,
    getTemplate: getTemplate,
    workspacePath: workspacePath
};

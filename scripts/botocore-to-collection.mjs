#!/usr/bin/env node
// botocore-to-collection.mjs
//
// CLI wrapper around the shared conversion logic in lib/botocoreConvert.js.
// Convert an AWS botocore service model (`service-2.json`) into a Postman v2.1
// collection that SignBridge can import via the Templates page.
//
// For most users this CLI is unnecessary — the Templates page can import any AWS
// service on demand (no file needed). This stays useful for scripting, offline
// generation, or exporting an exhaustive per-service collection to a file.
//
// The botocore models are the closest thing to a "complete AWS REST API" spec:
//   https://github.com/boto/botocore/tree/develop/botocore/data/<service>/<apiVersion>/service-2.json
//
// Usage:
//   node scripts/botocore-to-collection.mjs <service-2.json> [--region us-east-1] [--out collection.json]
//   node scripts/botocore-to-collection.mjs <service-2.json> --only DescribeInstances,RunInstances
//
// Example:
//   curl -sL https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/ec2/2016-11-15/service-2.json -o ec2.json
//   node scripts/botocore-to-collection.mjs ec2.json --only DescribeInstances --out ec2-collection.json

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { convert } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'botocoreConvert.js'))

const USAGE = `Convert an AWS botocore service-2.json into a SignBridge-importable Postman collection.

Usage:
  node scripts/botocore-to-collection.mjs <service-2.json> [options]

Options:
  --region <region>   AWS region for the endpoint host (default: us-east-1)
  --only <Op,Op,...>  Only include these operations (default: all)
  --out <file>        Write collection to file (default: stdout)
  -h, --help          Show this help
`

function parseArgs(argv) {
  const args = { region: 'us-east-1', out: null, only: null, input: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--region') args.region = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--only') args.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.input) args.input = a
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.input) {
    process.stdout.write(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  let model
  try {
    model = JSON.parse(readFileSync(args.input, 'utf8'))
  } catch (err) {
    process.stderr.write(`Failed to read/parse model file "${args.input}": ${err.message}\n`)
    process.exit(1)
  }

  if (!model.operations || !model.metadata) {
    process.stderr.write(
      `"${basename(args.input)}" does not look like a botocore service-2.json ` +
      `(missing metadata/operations).\n`
    )
    process.exit(1)
  }

  const collection = convert(model, { region: args.region, only: args.only })
  const output = JSON.stringify(collection, null, 2)

  if (args.out) {
    writeFileSync(args.out, output)
    process.stderr.write(
      `Wrote ${collection.item.length} request(s) to ${args.out}\n` +
      `Import it via SignBridge → Templates → Import Collection.\n`
    )
  } else {
    process.stdout.write(output + '\n')
  }
}

// Only run the CLI when this file is executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

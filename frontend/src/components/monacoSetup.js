/**
 * monacoSetup.js
 *
 * Boots the Monaco editor for Sandbox mode and teaches it about AWS.
 *
 * Two things happen here that are worth understanding:
 *
 * 1. Monaco is BUNDLED, not loaded from a CDN.
 *    @monaco-editor/react defaults to pulling Monaco from jsDelivr at runtime.
 *    SignBridge is meant to be self-hostable and air-gapped, so that default is
 *    replaced with the locally installed `monaco-editor` package and its web
 *    workers are imported through Vite. The IDE works with no internet access.
 *
 * 2. AWS autocomplete without a language server.
 *    Monaco ships a real TypeScript worker (so JS/TS get genuine IntelliSense),
 *    but Python and Java get only syntax highlighting. Rather than ship a
 *    language server per language, the completion providers below are driven by
 *    the botocore API models the backend already has (lib/sandbox/sandboxCompletions.js).
 *    That means `boto3.` lists boto3's real members, and a client built from
 *    `boto3.client('ec2')` lists EC2's real operations with their real
 *    parameters and documentation — for every AWS service, without a hardcoded
 *    list to maintain.
 */

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

// Worker specifiers go through monaco-editor's exports map ("./*.js" ->
// "./esm/vs/*.js"), so they are written without the esm/vs prefix.
//
// The TypeScript worker is named by its 0.56 location under languages/features/.
// The old language/typescript/ path still resolves, but only by re-exporting this
// one, so name the real thing.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'

import { getSandboxCompletions } from './presignApi'

let initialized = false

/**
 * Ambient declarations for the TypeScript worker.
 *
 * The sandbox image has the real @aws-sdk packages, but the browser does not
 * have their .d.ts files. Without these declarations every SDK import would be
 * underlined with "Cannot find module" — a false error on correct code, which is
 * far worse than missing type information. The wildcard declarations make those
 * imports resolve (as `any`), so the type checker flags real mistakes only.
 *
 * Node globals are declared for the same reason: Monaco's default libs cover the
 * browser, not Node.
 */
const AMBIENT_TYPES = `
declare module '@aws-sdk/*';
declare module 'aws-sdk';
declare module 'aws-sdk/*';
declare module 'axios';

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
  version: string
}
declare const Buffer: {
  from(input: any, encoding?: string): any
  isBuffer(input: any): boolean
}
declare const __dirname: string
declare const __filename: string
declare function require(id: string): any
`

/**
 * Configure Monaco once. Safe to call repeatedly (the IDE calls it on mount).
 */
export function initMonaco() {
  if (initialized) return
  initialized = true

  // Vite-bundled workers. Only the editor worker and the TypeScript worker are
  // needed: python and java have no worker-backed language service.
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }

  // Use the bundled Monaco instead of the CDN default.
  loader.config({ monaco })

  // monaco-editor 0.56 moved the TypeScript language service off the core
  // `languages` namespace onto its own top-level export, so the long-standing
  // `monaco.languages.typescript` is now undefined there. Accept both locations:
  // package.json carries a caret range, so the installed tree can be either side
  // of that move.
  const ts = monaco.typescript || monaco.languages.typescript
  if (!ts) {
    // Configuring the type checker is an enhancement, not a prerequisite. Losing
    // it costs TS/JS diagnostics in the editor (the container still type-checks
    // on Validate), so warn and carry on — never take the page down over it,
    // which is exactly what an unguarded property access did here before.
    console.warn(
      'SignBridge sandbox: Monaco TypeScript service not found; TS/JS editor diagnostics are disabled.'
    )
    registerAwsProviders()
    return monaco
  }
  const compilerOptions = {
    // ESNext, not ES2022: Monaco's copy of the ScriptTarget enum stops at ES2020
    // (plus ESNext), so `ts.ScriptTarget.ES2022` is undefined — and an undefined
    // target silently falls back to ES3, which made the checker reject the
    // top-level `await` in every JS/TS starter template. ESNext exists in every
    // version of the enum.
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // Top-level await is valid in the sandbox (code runs as an ES module), and
    // ESNext target + ESNext module is what makes the checker agree.
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    noEmit: true
  }
  ts.typescriptDefaults.setCompilerOptions(compilerOptions)
  ts.javascriptDefaults.setCompilerOptions(compilerOptions)
  ts.typescriptDefaults.addExtraLib(AMBIENT_TYPES, 'file:///signbridge-sandbox-ambient.d.ts')
  ts.javascriptDefaults.addExtraLib(AMBIENT_TYPES, 'file:///signbridge-sandbox-ambient.d.ts')
  // Semantic validation on: that is what surfaces "Property 'x' does not exist".
  // Suggestion diagnostics off: those are style nudges ("Parameter 'r' implicitly
  // has an 'any' type, but a better type may be inferred from usage") on code that
  // is perfectly valid here, and the sandbox deliberately runs non-strict. The
  // container's tsc is the authority on what counts as a real problem.
  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true
  }
  ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

  registerAwsProviders()
  return monaco
}

// One entry per language: JavaScript and TypeScript are served by SEPARATE worker
// instances with separate defaults, so each pays its own startup cost.
const tsWarmUps = new Map()

/**
 * Build the TypeScript program in the background, before the user types.
 *
 * The first call into Monaco's TypeScript worker is the expensive one: it parses
 * the whole default lib set to construct the program. Later calls answer in a
 * fraction of the time.
 *
 * That matters because Monaco's suggest widget waits for EVERY registered
 * provider to resolve before it renders anything. In a JS/TS editor the built-in
 * TypeScript provider is one of them, so a cold worker meant the first `ec2.`
 * showed nothing at all: the user typed another character, the session was
 * cancelled and restarted, and the cold cost was paid again. Autocomplete looked
 * broken when it was only late.
 *
 * So pay that cost once, on mount, while the user is still reading the template.
 * Fire-and-forget by design — nothing waits on the result, and a failure only
 * means the old behaviour (the first completion is slow), never a broken editor.
 */
export function warmUpTypeScript(model) {
  if (!model) return null
  const language = model.getLanguageId()
  // Nothing to warm for python/java — their completions are ours, and fast.
  if (language !== 'javascript' && language !== 'typescript') return null
  if (tsWarmUps.has(language)) return tsWarmUps.get(language)
  const ts = monaco.typescript || monaco.languages.typescript
  if (!ts) return null
  const getWorkerFor = language === 'javascript' ? ts.getJavaScriptWorker : ts.getTypeScriptWorker
  const warmUp = (async () => {
    const getWorker = await getWorkerFor()
    const client = await getWorker(model.uri)
    // The same call the editor makes for a diagnostics pass; any language-service
    // entry point builds the program, which is the part worth pre-paying.
    await client.getSemanticDiagnostics(model.uri.toString())
  })().catch(() => {
    // Allow a later mount to retry: this failing is not a permanent condition.
    tsWarmUps.delete(language)
  })
  tsWarmUps.set(language, warmUp)
  return warmUp
}

export { monaco }

// ---------------------------------------------------------------------------
// Completion data cache
// ---------------------------------------------------------------------------

// Per-language globals (the `boto3.` case) and the AWS service list.
const globalsCache = new Map()
// Per-service operation index.
const serviceCache = new Map()
const servicePending = new Map()
let serviceNames = null

async function loadGlobals(runtimeId) {
  if (globalsCache.has(runtimeId)) return globalsCache.get(runtimeId)
  try {
    const data = await getSandboxCompletions(runtimeId)
    globalsCache.set(runtimeId, data.globals || {})
    if (Array.isArray(data.services)) serviceNames = data.services
    return globalsCache.get(runtimeId)
  } catch (e) {
    globalsCache.set(runtimeId, {})
    return {}
  }
}

/**
 * The operation index for one AWS service. Cached, and de-duplicated while a
 * fetch is in flight so a burst of keystrokes triggers one request.
 */
async function loadService(service) {
  if (!service) return null
  const key = String(service).toLowerCase()
  if (serviceCache.has(key)) return serviceCache.get(key)
  if (servicePending.has(key)) return servicePending.get(key)
  const pending = getSandboxCompletions(null, key)
    .then(index => {
      serviceCache.set(key, index)
      servicePending.delete(key)
      return index
    })
    .catch(() => {
      // Cache the miss: an unknown or unreachable service should not be retried
      // on every keystroke.
      serviceCache.set(key, null)
      servicePending.delete(key)
      return null
    })
  servicePending.set(key, pending)
  return pending
}

/**
 * Warm the cache for the services a file actually mentions, so the first `.`
 * after a client feels instant instead of waiting on a model download.
 */
export function prefetchServices(services) {
  for (const service of services || []) {
    if (service) loadService(service)
  }
}

// ---------------------------------------------------------------------------
// Source scanning: which variable holds which service client?
// ---------------------------------------------------------------------------

// Python:  ec2 = boto3.client('ec2')   /  s3 = boto3.resource("s3")
const PY_CLIENT_ASSIGN = /(\w+)\s*=\s*(?:boto3|session)\s*\.\s*(?:client|resource)\s*\(\s*['"]([\w.\-]+)['"]/g
// JS/TS:   const ec2 = new EC2Client({ region })
const JS_CLIENT_ASSIGN = /(?:const|let|var)\s+(\w+)\s*=\s*new\s+([A-Za-z0-9_]+)Client\s*\(/g
// JS/TS imports:  from '@aws-sdk/client-ec2'
const JS_SDK_IMPORT = /['"]@aws-sdk\/client-([\w-]+)['"]/g
// Java:    Ec2Client ec2 = Ec2Client.builder()...  /  var ec2 = Ec2Client.builder()
const JAVA_CLIENT_ASSIGN = /(?:([A-Za-z0-9_]+)Client|var)\s+(\w+)\s*=\s*([A-Za-z0-9_]+)Client\s*\.\s*builder\s*\(/g

/**
 * Turn an SDK client class name into a botocore service name.
 *   EC2Client -> ec2, DynamoDbClient -> dynamodb, SecretsManagerClient -> secretsmanager
 * Best-effort by design: an unrecognised name simply yields no completions
 * rather than wrong ones.
 */
function clientClassToService(className) {
  if (!className) return null
  return String(className).replace(/Client$/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()
}

/**
 * Map local variables to AWS service names for the whole file. Cheap enough to
 * redo on each completion request, and always current — no incremental state to
 * get out of sync with the buffer.
 */
function scanClientVariables(text, runtimeId) {
  const variables = new Map()
  const services = new Set()
  let match

  if (runtimeId === 'python') {
    PY_CLIENT_ASSIGN.lastIndex = 0
    while ((match = PY_CLIENT_ASSIGN.exec(text)) !== null) {
      variables.set(match[1], match[2].toLowerCase())
      services.add(match[2].toLowerCase())
    }
  } else if (runtimeId === 'java') {
    JAVA_CLIENT_ASSIGN.lastIndex = 0
    while ((match = JAVA_CLIENT_ASSIGN.exec(text)) !== null) {
      const service = clientClassToService(match[3])
      if (service) {
        variables.set(match[2], service)
        services.add(service)
      }
    }
  } else {
    JS_CLIENT_ASSIGN.lastIndex = 0
    while ((match = JS_CLIENT_ASSIGN.exec(text)) !== null) {
      const service = clientClassToService(match[2])
      if (service) {
        variables.set(match[1], service)
        services.add(service)
      }
    }
    JS_SDK_IMPORT.lastIndex = 0
    while ((match = JS_SDK_IMPORT.exec(text)) !== null) {
      services.add(match[1].toLowerCase())
    }
  }

  return { variables, services: Array.from(services) }
}

/**
 * The services referenced by a file — used to prefetch their models.
 */
export function detectServices(text, runtimeId) {
  return scanClientVariables(text || '', runtimeId).services
}

// ---------------------------------------------------------------------------
// Completion item construction
// ---------------------------------------------------------------------------

function kindOf(kind) {
  const k = monaco.languages.CompletionItemKind
  switch (kind) {
    case 'function': return k.Function
    case 'method': return k.Method
    case 'class': return k.Class
    case 'module': return k.Module
    case 'variable': return k.Variable
    case 'constant': return k.Constant
    case 'property': return k.Property
    default: return k.Field
  }
}

function wordRange(model, position) {
  const word = model.getWordUntilPosition(position)
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn
  }
}

function snippetRule() {
  return monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
}

/**
 * Documentation for an operation: the AWS API description, then its parameters.
 * This is the part that turns autocomplete into "I no longer need the AWS docs
 * open in another tab".
 */
function operationDocs(operation, index) {
  const parts = []
  if (operation.documentation) parts.push(operation.documentation)
  const params = operation.params || []
  if (params.length) {
    const required = params.filter(p => p.required)
    const optional = params.filter(p => !p.required)
    if (required.length) {
      parts.push(
        '**Required**\n\n' +
          required.map(p => `- \`${p.name}\` — ${p.type}`).join('\n')
      )
    }
    if (optional.length) {
      const shown = optional.slice(0, 12)
      parts.push(
        '**Optional**\n\n' +
          shown.map(p => `- \`${p.name}\` — ${p.type}`).join('\n') +
          (optional.length > shown.length ? `\n- …${optional.length - shown.length} more` : '')
      )
    }
  }
  if (operation.http) parts.push('`' + operation.http + '`')
  if (index && index.label) parts.push('_' + index.label + '_')
  return { value: parts.join('\n\n'), isTrusted: false }
}

/**
 * Snippet body for calling an operation, pre-filled with its required
 * parameters so the signature is visible without opening the docs.
 */
function pythonCallSnippet(operation) {
  const required = (operation.params || []).filter(p => p.required)
  if (!required.length) return `${operation.python}()`
  const args = required.map((p, i) => `\${${i + 1}:${p.name}=}`).join(', ')
  return `${operation.python}(${args})`
}

function operationItems(index, position, model, runtimeId) {
  const range = wordRange(model, position)
  return (index.operations || []).map(operation => {
    const isPython = runtimeId === 'python'
    const label = isPython ? operation.python : operation.javascript
    return {
      label,
      kind: kindOf('method'),
      // The original API name, so a user searching for "DescribeRegions" still
      // finds it after the name has been transformed for their language.
      filterText: `${label} ${operation.name}`,
      detail: operation.name,
      documentation: operationDocs(operation, index),
      insertText: isPython ? pythonCallSnippet(operation) : `${label}(`,
      insertTextRules: isPython ? snippetRule() : undefined,
      range
    }
  })
}

function memberItems(members, position, model) {
  const range = wordRange(model, position)
  return (members || []).map(member => ({
    label: member.name,
    kind: kindOf(member.kind),
    detail: member.detail || '',
    documentation: member.documentation ? { value: member.documentation } : undefined,
    insertText: member.insertText || member.name,
    insertTextRules: member.insertText && member.insertText.includes('$') ? snippetRule() : undefined,
    range
  }))
}

function serviceNameItems(position, model) {
  const range = wordRange(model, position)
  return (serviceNames || []).map(entry => ({
    label: entry.service,
    kind: kindOf('constant'),
    detail: entry.label,
    insertText: entry.service,
    range
  }))
}

/**
 * The text on the current line up to the cursor — all the context the providers
 * below need to decide what to offer.
 */
function linePrefix(model, position) {
  return model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  })
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

let providersRegistered = false

function registerAwsProviders() {
  if (providersRegistered) return
  providersRegistered = true

  // --- Python -------------------------------------------------------------
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '(', "'", '"'],
    async provideCompletionItems(model, position) {
      const prefix = linePrefix(model, position)
      const text = model.getValue()

      // Inside boto3.client('…') / boto3.resource("…") — offer service names.
      if (/(?:boto3|session)\s*\.\s*(?:client|resource)\s*\(\s*['"][\w.\-]*$/.test(prefix)) {
        await loadGlobals('python')
        return { suggestions: serviceNameItems(position, model) }
      }

      const dotMatch = /([A-Za-z_][\w]*)\s*\.\s*[\w]*$/.exec(prefix)
      if (!dotMatch) return { suggestions: [] }
      const receiver = dotMatch[1]

      // A variable holding a service client: offer that service's operations.
      const { variables } = scanClientVariables(text, 'python')
      if (variables.has(receiver)) {
        const index = await loadService(variables.get(receiver))
        if (index) return { suggestions: operationItems(index, position, model, 'python') }
        return { suggestions: [] }
      }

      // A known module: boto3., requests., json., os., botocore.
      const globals = await loadGlobals('python')
      if (globals[receiver]) {
        return { suggestions: memberItems(globals[receiver].members, position, model) }
      }
      return { suggestions: [] }
    }
  })

  // --- Java ---------------------------------------------------------------
  monaco.languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const prefix = linePrefix(model, position)
      const text = model.getValue()
      const dotMatch = /([A-Za-z_][\w]*)\s*\.\s*[\w]*$/.exec(prefix)
      if (!dotMatch) return { suggestions: [] }
      const receiver = dotMatch[1]

      const { variables } = scanClientVariables(text, 'java')
      if (variables.has(receiver)) {
        const index = await loadService(variables.get(receiver))
        if (index) return { suggestions: operationItems(index, position, model, 'java') }
        return { suggestions: [] }
      }

      const globals = await loadGlobals('java')
      if (globals[receiver]) {
        return { suggestions: memberItems(globals[receiver].members, position, model) }
      }
      return { suggestions: [] }
    }
  })

  // --- JavaScript / TypeScript --------------------------------------------
  // Monaco's TypeScript worker already provides real IntelliSense here. This
  // provider adds only what the worker cannot know, because the SDK types are
  // not present in the browser: the package names, and the Command classes for
  // whichever services the file imports.
  for (const language of ['javascript', 'typescript']) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['-', ' ', '.'],
      async provideCompletionItems(model, position) {
        const prefix = linePrefix(model, position)
        const text = model.getValue()

        // Completing the package name in an import.
        if (/['"]@aws-sdk\/client-[\w-]*$/.test(prefix)) {
          await loadGlobals(language)
          const range = wordRange(model, position)
          return {
            suggestions: (serviceNames || []).map(entry => ({
              label: `@aws-sdk/client-${entry.service}`,
              kind: kindOf('module'),
              detail: entry.label,
              insertText: entry.service,
              range
            }))
          }
        }

        // `new …` — offer the Command classes of the imported services.
        if (/\bnew\s+[A-Za-z0-9_]*$/.test(prefix)) {
          const { services } = scanClientVariables(text, language)
          if (!services.length) return { suggestions: [] }
          const indexes = await Promise.all(services.slice(0, 4).map(loadService))
          const range = wordRange(model, position)
          const suggestions = []
          for (const index of indexes) {
            if (!index) continue
            suggestions.push({
              label: index.clients.javascript,
              kind: kindOf('class'),
              detail: index.clients.javascriptPackage,
              insertText: `${index.clients.javascript}({ region })`,
              range
            })
            for (const operation of index.operations || []) {
              suggestions.push({
                label: operation.command,
                kind: kindOf('class'),
                filterText: `${operation.command} ${operation.name}`,
                detail: index.label,
                documentation: operationDocs(operation, index),
                insertText: `${operation.command}({$1})`,
                insertTextRules: snippetRule(),
                range
              })
            }
          }
          return { suggestions }
        }

        // `client.` — the SDK v3 client only really exposes send(), so point at
        // it rather than pretending to know more.
        const dotMatch = /([A-Za-z_][\w]*)\s*\.\s*[\w]*$/.exec(prefix)
        if (dotMatch) {
          const { variables } = scanClientVariables(text, language)
          if (variables.has(dotMatch[1])) {
            const range = wordRange(model, position)
            return {
              suggestions: [
                {
                  label: 'send',
                  kind: kindOf('method'),
                  detail: 'send(command) => Promise<Output>',
                  documentation: {
                    value: 'AWS SDK v3 sends every operation as a command object:\n\n' +
                      '```js\nawait client.send(new DescribeRegionsCommand({}))\n```'
                  },
                  insertText: 'send(new ${1:Command}({$2}))',
                  insertTextRules: snippetRule(),
                  range
                }
              ]
            }
          }
          const globals = await loadGlobals(language)
          if (globals[dotMatch[1]]) {
            return { suggestions: memberItems(globals[dotMatch[1]].members, position, model) }
          }
        }

        return { suggestions: [] }
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Diagnostics + quick fixes
// ---------------------------------------------------------------------------

const OWNER = 'signbridge-sandbox'

/**
 * Push backend diagnostics into the editor as markers.
 *
 * These come from the real compiler run inside the container (py_compile,
 * node --check, tsc --noEmit, javac), so a squiggle here means the toolchain
 * that will actually execute the code objected to it.
 */
export function applyDiagnostics(monacoInstance, model, diagnostics) {
  if (!monacoInstance || !model) return
  const markers = (diagnostics || []).map(diagnostic => ({
    severity:
      diagnostic.severity === 'warning'
        ? monacoInstance.MarkerSeverity.Warning
        : monacoInstance.MarkerSeverity.Error,
    message: diagnostic.remedy
      ? `${diagnostic.message}\n\n→ ${diagnostic.remedy.title}\n${diagnostic.remedy.detail}`
      : diagnostic.message,
    startLineNumber: diagnostic.line,
    startColumn: diagnostic.column,
    endLineNumber: diagnostic.endLine || diagnostic.line,
    endColumn: diagnostic.endColumn || diagnostic.column + 1,
    code: diagnostic.code || undefined,
    source: diagnostic.source || 'sandbox'
  }))
  monacoInstance.editor.setModelMarkers(model, OWNER, markers)
}

export function clearDiagnostics(monacoInstance, model) {
  if (!monacoInstance || !model) return
  monacoInstance.editor.setModelMarkers(model, OWNER, [])
}

let codeActionDisposables = []

/**
 * Register quick fixes for our diagnostics.
 *
 * A remedy that carries `replaceWord` becomes a real one-click fix: the
 * identifier under the marker is rewritten. Everything else is offered as a
 * non-editing action whose title explains what to do — visible in the lightbulb
 * menu, where a user already looks for help.
 */
export function registerQuickFixes(monacoInstance, getDiagnostics) {
  codeActionDisposables.forEach(d => d.dispose())
  codeActionDisposables = []

  for (const language of ['python', 'javascript', 'typescript', 'java']) {
    codeActionDisposables.push(
      monacoInstance.languages.registerCodeActionProvider(language, {
        provideCodeActions(model, range) {
          const diagnostics = getDiagnostics() || []
          const actions = []
          for (const diagnostic of diagnostics) {
            if (!diagnostic.remedy) continue
            if (diagnostic.line < range.startLineNumber || diagnostic.line > range.endLineNumber) {
              continue
            }
            const remedy = diagnostic.remedy
            if (remedy.replaceWord) {
              const word = model.getWordAtPosition({
                lineNumber: diagnostic.line,
                column: diagnostic.column
              })
              if (word) {
                actions.push({
                  title: remedy.title,
                  kind: 'quickfix',
                  isPreferred: true,
                  edit: {
                    edits: [
                      {
                        resource: model.uri,
                        textEdit: {
                          range: {
                            startLineNumber: diagnostic.line,
                            endLineNumber: diagnostic.line,
                            startColumn: word.startColumn,
                            endColumn: word.endColumn
                          },
                          text: remedy.replaceWord
                        },
                        versionId: model.getVersionId()
                      }
                    ]
                  }
                })
                continue
              }
            }
            actions.push({
              title: remedy.title,
              kind: 'quickfix',
              // No edit: the fix is advice, not a mechanical substitution. The
              // detail is already in the hover; this keeps it one click away.
              diagnostics: []
            })
          }
          return { actions, dispose() {} }
        }
      })
    )
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Configure at IMPORT time, not from a React effect — this ordering is the whole
 * ballgame.
 *
 * `@monaco-editor/loader` latches on the first `init()` call: it flips an
 * `isInitialized` flag and only adopts a preconfigured instance if `config()`
 * already ran. `<Editor>` calls `init()` from its own mount effect, and child
 * effects fire before the parent's — so calling `initMonaco()` from SandboxIde's
 * effect was always too late. The loader fell back to fetching Monaco from
 * jsDelivr, which broke two things at once: the air-gapped/self-hosted promise,
 * and *every AWS completion*, because the providers above were registered on the
 * local instance while the editor ran on the CDN's.
 *
 * This call belongs at the very BOTTOM of the module, not next to initMonaco's
 * definition: it runs immediately, and the caches and `providersRegistered` flag
 * it reaches through registerAwsProviders() are `let`/`const` bindings declared
 * further up the file — touching them any earlier is a temporal-dead-zone error.
 */
initMonaco()

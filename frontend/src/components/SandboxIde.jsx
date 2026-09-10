import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Form, ListGroup, Spinner } from 'react-bootstrap'
import { useSearchParams } from 'react-router-dom'
import Editor from '@monaco-editor/react'

import ApiErrorAlert from './ApiErrorAlert.jsx'
import { useConfirm, usePrompt } from './ConfirmDialog.jsx'
// Importing monacoSetup points the Monaco loader at the locally bundled editor
// and registers the AWS completion providers. That happens at import time on
// purpose — see the note above initMonaco()'s call there; doing it from an effect
// in here runs after <Editor> has already booted the loader, which is too late.
import {
  applyDiagnostics,
  clearDiagnostics,
  detectServices,
  prefetchServices,
  registerQuickFixes,
  warmUpTypeScript
} from './monacoSetup'
import {
  cancelSandbox,
  checkSandbox,
  deleteSandboxScript,
  getSandboxScript,
  getSandboxTemplate,
  getSandboxRuntimes,
  listSandboxScripts,
  populateProfilesDetails,
  runSandbox,
  saveSandboxScript
} from './presignApi'
import { getSocket, getUserName } from './presignSocket'
import { AWS_MODES, authnLabel } from '../authnModes'

/**
 * SandboxIde — the editor half of Sandbox mode.
 *
 * The user writes Python / JavaScript / TypeScript / Java, presses Run, and the
 * code executes in a throwaway Docker container that already has the SDKs
 * installed and the selected profile's AWS credentials in its environment. No
 * local toolchain, no `pip install`, no credential wrangling.
 *
 * What makes it feel like an IDE rather than a text box:
 *   - Real autocomplete. `boto3.` lists boto3's members; a client built from
 *     boto3.client('ec2') lists EC2's actual operations with their parameters
 *     and documentation, for any of the ~429 AWS services (see monacoSetup.js).
 *   - Real diagnostics. Errors come from the language's own checker running in
 *     the container (py_compile / node --check / tsc / javac), mapped back to the
 *     line and column, with a suggested fix on the lightbulb.
 *   - Live output. stdout/stderr stream over Socket.IO while the code runs, so a
 *     long call shows progress instead of a spinner.
 */

// Auth-mechanism labels and the list of mechanisms that put AWS credentials into
// the container both come from src/authnModes.js — see the note there.

// What each language's Validate action actually proves. Said plainly so the
// check is not mistaken for more than it is.
const CHECK_KIND_LABEL = {
  syntax: 'syntax checked',
  types: 'types checked',
  compile: 'compiled'
}

// Delay after the last keystroke before an automatic Validate. Long enough that
// typing never queues up container starts, short enough to feel live.
const AUTO_CHECK_DELAY_MS = 1800

// Console output is flushed on a timer rather than per socket event: a chatty
// script can emit hundreds of chunks a second, and one React render each would
// make the editor stutter.
const OUTPUT_FLUSH_MS = 90

function formatDuration(ms) {
  if (ms == null) return ''
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

/**
 * Two ways in, one component:
 *
 *  - **Embedded** (`embedded`, the dashboard's Sandbox invocation mode): the
 *    dashboard already has a profile and auth mechanism selected above the
 *    editor, so it passes them down and this component hides its own pickers.
 *    Asking for the same profile twice on one screen would be absurd.
 *  - **Standalone** (the /sandbox page): no parent selection exists, so the
 *    pickers are shown and an optional `?profile=&authnMode=` query seeds them.
 */
export default function SandboxIde({
  profileName: profileNameProp = '',
  authnMode: authnModeProp = '',
  embedded = false
}) {
  const [searchParams] = useSearchParams()

  // --- Environment / registry -------------------------------------------
  const [runtimes, setRuntimes] = useState([])
  const [limits, setLimits] = useState(null)
  const [preflight, setPreflight] = useState(null)
  const [streamEvent, setStreamEvent] = useState(null)
  const [loading, setLoading] = useState(true)

  // --- Editor state -----------------------------------------------------
  const [runtimeId, setRuntimeId] = useState('python')
  const [templateId, setTemplateId] = useState(null)
  const [code, setCode] = useState('')

  // --- Credentials ------------------------------------------------------
  const [profiles, setProfiles] = useState([])
  const [profileName, setProfileName] = useState('')
  const [authnMode, setAuthnMode] = useState('')
  const [region, setRegion] = useState('')

  // --- Run state --------------------------------------------------------
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState(null)
  const [output, setOutput] = useState([]) // [{ stream, text }]
  const [result, setResult] = useState(null)
  const [diagnostics, setDiagnostics] = useState([])
  const [remedies, setRemedies] = useState([])
  const [runMeta, setRunMeta] = useState(null) // live info from the 'start' event
  const [checking, setChecking] = useState(false)
  const [checkStatus, setCheckStatus] = useState(null) // { ok, message }
  const [autoCheck, setAutoCheck] = useState(true)
  const [error, setError] = useState('')

  // --- Saved scripts ----------------------------------------------------
  const [scripts, setScripts] = useState([])
  const [scriptId, setScriptId] = useState(null)
  const [scriptName, setScriptName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const { confirm, confirmDialog } = useConfirm()
  const { prompt, promptDialog } = usePrompt()

  const editorRef = useRef(null)
  const monacoRef = useRef(null)
  const diagnosticsRef = useRef([])
  const runIdRef = useRef(null)
  const consoleRef = useRef(null)
  const pendingOutputRef = useRef([])
  const flushTimerRef = useRef(null)
  const autoCheckTimerRef = useRef(null)
  const abortRef = useRef(null)
  const codeRef = useRef('')
  // Monaco actions are registered once on mount; these refs let them call the
  // current handlers instead of the ones captured at registration time.
  const runActionRef = useRef(() => {})
  const saveActionRef = useRef(() => {})

  const runtime = useMemo(
    () => runtimes.find(entry => entry.id === runtimeId) || null,
    [runtimes, runtimeId]
  )

  const selectedProfile = useMemo(
    () => profiles.find(entry => entry.profileName === profileName) || null,
    [profiles, profileName]
  )

  const authnMechanisms = useMemo(() => {
    if (!selectedProfile) return []
    return selectedProfile.supportedAuthnMechanisms || []
  }, [selectedProfile])

  const usesAwsCredentials = AWS_MODES.includes(authnMode)

  // Keep refs current: the Monaco keybindings and the quick-fix provider are
  // registered once and would otherwise close over stale values.
  useEffect(() => {
    diagnosticsRef.current = diagnostics
  }, [diagnostics])

  /**
   * Replace the editor's contents (template load, opening a saved script).
   *
   * The editor's own buffer is the single source of truth for the code;
   * `codeRef` mirrors it synchronously and the `code` state only exists for the
   * UI that has to re-render (the dirty flag, the disabled Run button, the
   * debounced background check). Text deliberately flows ONE way — out of
   * Monaco — and comes back in only through this function.
   *
   * Feeding it back through `<Editor value={code}>` looked tidier and quietly
   * broke autocomplete: @monaco-editor/react treats a `value` prop that differs
   * from the buffer as a correction and replaces the whole document. React can
   * be a keystroke behind a fast typist, so that "correction" landed in the
   * middle of a word, and a full-document replacement cancels Monaco's
   * in-flight suggest session. The completion popup opened and was destroyed a
   * few milliseconds later, every single time.
   */
  const setEditorCode = useCallback(text => {
    const next = text || ''
    codeRef.current = next
    setCode(next)
    const editor = editorRef.current
    if (editor && editor.getValue() !== next) editor.setValue(next)
  }, [])

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  const refreshEnvironment = useCallback(async () => {
    try {
      const data = await getSandboxRuntimes()
      setRuntimes(data.runtimes || [])
      setLimits(data.limits || null)
      setPreflight(data.preflight || null)
      setStreamEvent(data.streamEvent || null)
      return data
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Failed to load the sandbox environment')
      return null
    }
  }, [])

  const refreshScripts = useCallback(async () => {
    try {
      const data = await listSandboxScripts()
      setScripts(data.scripts || [])
    } catch {
      setScripts([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [, profileData] = await Promise.all([
        refreshEnvironment(),
        populateProfilesDetails().catch(() => []),
        refreshScripts()
      ])
      if (cancelled) return
      const loaded = Array.isArray(profileData) ? profileData : []
      setProfiles(loaded)
      // Standalone only: seed from the query string, and only if the named
      // profile still exists — a stale link must not leave an unselectable name
      // in the dropdown. Embedded, the parent owns this (see the effect below).
      if (!embedded) {
        const handoff = searchParams.get('profile')
        const match = handoff ? loaded.find(entry => entry.profileName === handoff) : null
        if (match) {
          setProfileName(match.profileName)
          const mode = searchParams.get('authnMode')
          if (mode && (match.supportedAuthnMechanisms || []).includes(mode)) {
            setAuthnMode(mode)
          }
        }
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
    // searchParams is deliberately not a dependency: the hand-off is a one-time
    // bootstrap, and re-running it would fight the user's own profile choice.
  }, [refreshEnvironment, refreshScripts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the starter template for the selected language, but never over the
  // user's own work: only when the buffer is empty or untouched template code.
  const loadTemplate = useCallback(
    async (targetRuntimeId, targetTemplateId) => {
      try {
        const template = await getSandboxTemplate(targetRuntimeId, targetTemplateId)
        setTemplateId(template.templateId)
        setEditorCode(template.code)
        setDirty(false)
        return template
      } catch (e) {
        setError(e.response?.data?.message || e.message)
        return null
      }
    },
    [setEditorCode]
  )

  // First template once the registry is known.
  const bootstrappedRef = useRef(false)
  useEffect(() => {
    if (bootstrappedRef.current || !runtimes.length) return
    bootstrappedRef.current = true
    loadTemplate(runtimeId, null)
  }, [runtimes, runtimeId, loadTemplate])

  // Embedded: the parent's selection is authoritative. This runs on every change
  // to it, so changing the profile on the dashboard retargets the editor's next
  // run — and it deliberately overrides the profile stored in a saved script,
  // because the selector the user can actually see should win.
  useEffect(() => {
    if (!embedded) return
    setProfileName(profileNameProp || '')
    setAuthnMode(authnModeProp || '')
  }, [embedded, profileNameProp, authnModeProp])

  // Default to the profile's only mechanism; otherwise make the user choose,
  // exactly as the dashboard does. Skipped when embedded: the parent supplies
  // the mechanism, and clearing it here would fight the effect above.
  useEffect(() => {
    if (embedded) return
    if (authnMechanisms.length === 1) {
      setAuthnMode(authnMechanisms[0])
    } else if (!authnMechanisms.includes(authnMode)) {
      setAuthnMode('')
    }
  }, [authnMechanisms, embedded]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------
  // Live output over Socket.IO
  // ---------------------------------------------------------------------

  const flushOutput = useCallback(() => {
    flushTimerRef.current = null
    const pending = pendingOutputRef.current
    if (!pending.length) return
    pendingOutputRef.current = []
    setOutput(previous => previous.concat(pending))
  }, [])

  const queueOutput = useCallback(
    entry => {
      pendingOutputRef.current.push(entry)
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(flushOutput, OUTPUT_FLUSH_MS)
      }
    },
    [flushOutput]
  )

  useEffect(() => {
    if (!streamEvent) return
    const socket = getSocket()
    const eventName = streamEvent || `event_sandbox_stream_${getUserName()}`

    function onSandboxEvent(payload) {
      if (!payload) return
      if (payload.type === 'start') {
        runIdRef.current = payload.runId
        setRunId(payload.runId)
        setRunMeta(payload)
        return
      }
      if (payload.type === 'output') {
        // Ignore output from a run this client is no longer showing (e.g. an
        // older run finishing after the user started a new one).
        if (runIdRef.current && payload.runId !== runIdRef.current) return
        queueOutput({ stream: payload.stream, text: payload.chunk })
        return
      }
      if (payload.type === 'error') {
        queueOutput({ stream: 'stderr', text: `${payload.message}\n` })
      }
      // 'end' carries the same fields as the HTTP response, which is what the
      // run handler uses — nothing extra to do here.
    }

    socket.on(eventName, onSandboxEvent)
    return () => {
      socket.off(eventName, onSandboxEvent)
    }
  }, [streamEvent, queueOutput])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      if (autoCheckTimerRef.current) clearTimeout(autoCheckTimerRef.current)
    }
  }, [])

  // Follow the tail of the output, unless the user has scrolled up to read.
  useEffect(() => {
    const element = consoleRef.current
    if (!element) return
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 80
    if (nearBottom) element.scrollTop = element.scrollHeight
  }, [output])

  // ---------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------

  const showDiagnostics = useCallback(list => {
    setDiagnostics(list || [])
    diagnosticsRef.current = list || []
    const model = editorRef.current?.getModel()
    if (monacoRef.current && model) {
      applyDiagnostics(monacoRef.current, model, list || [])
    }
  }, [])

  const resetDiagnostics = useCallback(() => {
    setDiagnostics([])
    diagnosticsRef.current = []
    const model = editorRef.current?.getModel()
    if (monacoRef.current && model) clearDiagnostics(monacoRef.current, model)
  }, [])

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  const doCheck = useCallback(
    async ({ silent } = {}) => {
      const source = codeRef.current
      if (!source || !source.trim()) {
        resetDiagnostics()
        setCheckStatus(null)
        return null
      }
      if (!silent) setChecking(true)
      try {
        const data = await checkSandbox(runtimeId, source)
        showDiagnostics(data.diagnostics || [])
        const kind = CHECK_KIND_LABEL[data.checkKind] || 'checked'
        setCheckStatus(
          (data.diagnostics || []).length === 0 && data.exitCode === 0
            ? { ok: true, message: `No problems found — ${kind}.` }
            : {
                ok: false,
                message: `${(data.diagnostics || []).length || 1} problem${
                  (data.diagnostics || []).length === 1 ? '' : 's'
                } found — ${kind}.`
              }
        )
        return data
      } catch (e) {
        // A failed check is worth saying out loud only when the user asked for
        // it; an automatic one failing (e.g. Docker busy) should stay quiet.
        if (!silent) {
          setError(e.response?.data?.message || e.message || 'The check could not run')
        }
        return null
      } finally {
        if (!silent) setChecking(false)
      }
    },
    [runtimeId, resetDiagnostics, showDiagnostics]
  )

  // Automatic validation while typing. JS/TS already get live errors from
  // Monaco's own TypeScript worker, but Python and Java have no in-browser
  // checker — for them this is the only way to see a mistake before running.
  useEffect(() => {
    if (!autoCheck || running || !preflight?.ok) return
    if (autoCheckTimerRef.current) clearTimeout(autoCheckTimerRef.current)
    if (!code || !code.trim()) return
    autoCheckTimerRef.current = setTimeout(() => {
      doCheck({ silent: true })
    }, AUTO_CHECK_DELAY_MS)
    return () => {
      if (autoCheckTimerRef.current) clearTimeout(autoCheckTimerRef.current)
    }
  }, [code, autoCheck, running, preflight, doCheck])

  const doRun = useCallback(async () => {
    const source = codeRef.current
    if (!source || !source.trim()) {
      setError('There is no code to run.')
      return
    }
    if (running) return

    setError('')
    setResult(null)
    setRunMeta(null)
    setRemedies([])
    setCheckStatus(null)
    resetDiagnostics()
    pendingOutputRef.current = []
    setOutput([])
    setRunning(true)
    runIdRef.current = null

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const data = await runSandbox(
        {
          runtimeId,
          code: source,
          profileName: profileName || null,
          authnMode: authnMode || null,
          region: region || null,
          scriptId
        },
        controller.signal
      )
      flushOutput()
      setResult(data)
      setRemedies(data.remedies || [])
      if (data.diagnostics && data.diagnostics.length) showDiagnostics(data.diagnostics)
      // The HTTP response is authoritative: if socket events were missed, fall
      // back to the complete captured output.
      if (!pendingOutputRef.current.length) {
        setOutput(previous =>
          previous.length ? previous : [{ stream: 'stdout', text: data.output || '' }]
        )
      }
      refreshScripts()
    } catch (e) {
      if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') {
        // Client-side abort: the container is stopped separately by Stop.
      } else {
        const payload = e.response?.data
        // Keep the whole payload, not just its message: a credential failure
        // carries `verificationUriComplete` / `ssoSessionExpired`, and the alert
        // turns those into an Authorize button and a Run-again button. Folding the
        // URL into "Suggested fixes" (as this used to) made the user copy a link
        // and then re-run by hand.
        setError(payload?.message ? payload : e.message || 'The run failed')
        if (payload?.diagnostics) showDiagnostics(payload.diagnostics)
        if (payload?.remedies) setRemedies(payload.remedies)
        if (payload?.preflight) setPreflight(payload.preflight)
      }
    } finally {
      abortRef.current = null
      setRunning(false)
      flushOutput()
    }
  }, [
    running,
    runtimeId,
    profileName,
    authnMode,
    region,
    scriptId,
    resetDiagnostics,
    showDiagnostics,
    flushOutput,
    refreshScripts
  ])

  const doStop = useCallback(async () => {
    const activeRunId = runIdRef.current
    if (!activeRunId) {
      // Nothing started yet (still resolving credentials): drop the request.
      if (abortRef.current) abortRef.current.abort()
      setRunning(false)
      return
    }
    try {
      await cancelSandbox(activeRunId)
    } catch (e) {
      setError(e.response?.data?.message || e.message)
    }
  }, [])

  // ---------------------------------------------------------------------
  // Saved scripts
  // ---------------------------------------------------------------------

  const doSave = useCallback(async () => {
    const source = codeRef.current
    let name = scriptName
    if (!scriptId) {
      const chosen = await prompt({
        title: 'Save script',
        label: 'Name',
        placeholder: `${runtime?.label || 'Sandbox'} script`,
        confirmLabel: 'Save',
        initialValue: scriptName || ''
      })
      if (chosen == null) return
      name = chosen
    }
    setSaving(true)
    try {
      const saved = await saveSandboxScript({
        scriptId: scriptId || undefined,
        name,
        runtimeId,
        code: source,
        profileName: profileName || null,
        authnMode: authnMode || null
      })
      setScriptId(saved.scriptId)
      setScriptName(saved.name)
      setDirty(false)
      refreshScripts()
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'The script could not be saved')
    } finally {
      setSaving(false)
    }
  }, [scriptId, scriptName, runtime, runtimeId, profileName, authnMode, prompt, refreshScripts])

  const openScript = useCallback(
    async id => {
      try {
        const script = await getSandboxScript(id)
        setScriptId(script.scriptId)
        setScriptName(script.name)
        setRuntimeId(script.runtimeId)
        setEditorCode(script.code || '')
        if (script.profileName) setProfileName(script.profileName)
        if (script.authnMode) setAuthnMode(script.authnMode)
        setDirty(false)
        setResult(null)
        setRemedies([])
        setCheckStatus(null)
        setOutput([])
        resetDiagnostics()
      } catch (e) {
        setError(e.response?.data?.message || e.message)
      }
    },
    [resetDiagnostics, setEditorCode]
  )

  const removeScript = useCallback(
    async script => {
      const ok = await confirm({
        title: 'Delete script',
        message: `Delete "${script.name}"? This cannot be undone.`,
        confirmLabel: 'Delete'
      })
      if (!ok) return
      try {
        await deleteSandboxScript(script.scriptId)
        if (script.scriptId === scriptId) {
          setScriptId(null)
          setScriptName('')
        }
        refreshScripts()
      } catch (e) {
        setError(e.response?.data?.message || e.message)
      }
    },
    [confirm, scriptId, refreshScripts]
  )

  const startNew = useCallback(async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard changes?',
        message: 'The current script has unsaved changes. Start a new one anyway?',
        confirmLabel: 'Discard',
        danger: false
      })
      if (!ok) return
    }
    setScriptId(null)
    setScriptName('')
    setResult(null)
    setRemedies([])
    setCheckStatus(null)
    setOutput([])
    resetDiagnostics()
    loadTemplate(runtimeId, templateId)
  }, [dirty, confirm, resetDiagnostics, loadTemplate, runtimeId, templateId])

  // ---------------------------------------------------------------------
  // Language / template switching
  // ---------------------------------------------------------------------

  const changeRuntime = useCallback(
    async nextRuntimeId => {
      if (nextRuntimeId === runtimeId) return
      if (dirty) {
        const ok = await confirm({
          title: 'Switch language?',
          message:
            'Switching language replaces the editor contents with that language\'s starter template. Your unsaved changes will be lost.',
          confirmLabel: 'Switch',
          danger: false
        })
        if (!ok) return
      }
      setRuntimeId(nextRuntimeId)
      setResult(null)
      setRemedies([])
      setCheckStatus(null)
      resetDiagnostics()
      // A saved script belongs to its language; switching starts a new buffer.
      setScriptId(null)
      setScriptName('')
      loadTemplate(nextRuntimeId, null)
    },
    [runtimeId, dirty, confirm, resetDiagnostics, loadTemplate]
  )

  const changeTemplate = useCallback(
    async nextTemplateId => {
      if (dirty) {
        const ok = await confirm({
          title: 'Replace the editor contents?',
          message: 'Loading a template replaces what is in the editor. Continue?',
          confirmLabel: 'Load template',
          danger: false
        })
        if (!ok) return
      }
      loadTemplate(runtimeId, nextTemplateId)
    },
    [dirty, confirm, loadTemplate, runtimeId]
  )

  // ---------------------------------------------------------------------
  // Editor wiring
  // ---------------------------------------------------------------------

  // JS/TS completions come from Monaco's TypeScript worker, whose first call boots
  // a 7 MB worker and builds the whole program. Kick that off as soon as a JS/TS
  // buffer exists — on mount, and again when the language changes — so the cost
  // lands while the user is reading the template instead of swallowing their first
  // completion. No-op for python/java.
  useEffect(() => {
    warmUpTypeScript(editorRef.current?.getModel())
  }, [runtimeId])

  const handleEditorMount = useCallback(
    (editor, monacoInstance) => {
      editorRef.current = editor
      monacoRef.current = monacoInstance

      // The starter template is fetched in parallel with the editor loading, so
      // whichever finishes second has to do the hand-off. setEditorCode covers
      // the template-last case; this covers template-first.
      if (codeRef.current && editor.getValue() !== codeRef.current) {
        editor.setValue(codeRef.current)
      }

      // Quick fixes read the live diagnostics through a ref, so this registers
      // once and still sees the latest markers.
      registerQuickFixes(monacoInstance, () => diagnosticsRef.current)

      warmUpTypeScript(editor.getModel())

      editor.addAction({
        id: 'signbridge.sandbox.run',
        label: 'Run in sandbox',
        keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Enter],
        run: () => {
          runActionRef.current()
        }
      })
      editor.addAction({
        id: 'signbridge.sandbox.save',
        label: 'Save script',
        keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS],
        run: () => {
          saveActionRef.current()
        }
      })
    },
    []
  )

  useEffect(() => {
    runActionRef.current = doRun
  }, [doRun])
  useEffect(() => {
    saveActionRef.current = doSave
  }, [doSave])

  // Warm the API models for the services this file mentions, so the first
  // completion after a client variable appears instantly.
  useEffect(() => {
    if (!code) return
    const timer = setTimeout(() => {
      prefetchServices(detectServices(code, runtimeId))
    }, 600)
    return () => clearTimeout(timer)
  }, [code, runtimeId])

  const handleCodeChange = useCallback(value => {
    // codeRef is updated synchronously so Run / Validate / Save always send the
    // characters currently on screen, even if React has not re-rendered yet.
    codeRef.current = value ?? ''
    setCode(value ?? '')
    setDirty(true)
  }, [])

  // The editor's own file name for the buffer, which is NOT the file the sandbox
  // runs (that is runtime.fileName — main.mts / main.mjs, whose .m* extensions are
  // what make tsx and Node treat the code as an ES module).
  //
  // Monaco's TypeScript worker decides TypeScript-vs-JavaScript from the model
  // URI's extension and its map knows only ts/tsx/js/jsx: anything else — including
  // the default `inmemory://model/1` and, awkwardly, `.mts` — falls through to
  // JavaScript while allowJs is on. That is what underlined every type annotation
  // in the TypeScript template with "Type annotations can only be used in
  // TypeScript files": a false error on correct code. Naming the model `main.ts`
  // settles the classification; the runtime's real file name is unaffected.
  const editorModelPath = useMemo(() => {
    const names = {
      python: 'main.py',
      javascript: 'main.js',
      typescript: 'main.ts',
      java: 'Main.java'
    }
    return `file:///${names[runtimeId] || 'main.txt'}`
  }, [runtimeId])

  // Monaco reconfigures itself whenever this object's identity changes, so it is
  // memoised rather than rebuilt on every keystroke.
  const editorOptions = useMemo(
    () => ({
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: runtimeId === 'python' ? 4 : 2,
      insertSpaces: true,
      renderWhitespace: 'selection',
      lightbulb: { enabled: true },
      // Suggestions on a plain word (not just after a trigger character), so
      // typing `desc` inside an AWS client offers its operations.
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      suggestSelection: 'first',
      // The editor sits inside scrolling cards; without this the completion
      // popup is clipped by the container instead of floating above it.
      fixedOverflowWidgets: true
    }),
    [runtimeId]
  )

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  const notReady = preflight && preflight.ok === false
  const runDisabled = running || loading || notReady || !code.trim()

  // An SSO session that expired between writing the code and running it is the
  // one error whose fix is "approve it, then run the same thing again" — so that
  // error, and only that error, gets a Run-again button next to Authorize.
  const errorNeedsAuth = !!(
    error &&
    typeof error === 'object' &&
    (error.verificationUriComplete || error.ssoSessionExpired)
  )

  const statusBadge = () => {
    if (running) {
      return (
        <Badge bg="primary" className="d-inline-flex align-items-center gap-1">
          <Spinner animation="border" size="sm" style={{ width: 12, height: 12 }} /> Running
        </Badge>
      )
    }
    if (!result) return null
    if (result.timedOut) return <Badge bg="warning" text="dark">Timed out</Badge>
    if (result.cancelled) return <Badge bg="secondary">Stopped</Badge>
    if (result.exitCode === 0) return <Badge bg="success">Exit 0</Badge>
    return <Badge bg="danger">Exit {result.exitCode}</Badge>
  }

  return (
    <>
      <div className="d-flex gap-3 align-items-start">
        {/* ---------------- Saved scripts ---------------- */}
        <Card style={{ width: 240, flex: '0 0 240px' }}>
          <Card.Header className="d-flex justify-content-between align-items-center py-2">
            <span className="fw-semibold small">Saved scripts</span>
            <Button size="sm" variant="outline-secondary" onClick={startNew} title="New script">
              +
            </Button>
          </Card.Header>
          <ListGroup variant="flush" style={{ maxHeight: 520, overflowY: 'auto' }}>
            {scripts.length === 0 ? (
              <ListGroup.Item className="text-muted small">
                Nothing saved yet. Write some code and press Save.
              </ListGroup.Item>
            ) : (
              scripts.map(script => (
                <ListGroup.Item
                  key={script.scriptId}
                  action
                  active={script.scriptId === scriptId}
                  onClick={() => openScript(script.scriptId)}
                  className="d-flex justify-content-between align-items-start gap-2"
                >
                  <span className="text-truncate">
                    <span className="d-block text-truncate small fw-semibold">{script.name}</span>
                    <span
                      className={`d-block small ${
                        script.scriptId === scriptId ? 'text-white-50' : 'text-muted'
                      }`}
                    >
                      {script.runtimeId}
                      {script.lastExitCode != null ? ` · exit ${script.lastExitCode}` : ''}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="link"
                    className={`p-0 ${script.scriptId === scriptId ? 'text-white' : 'text-danger'}`}
                    title="Delete"
                    onClick={event => {
                      event.stopPropagation()
                      removeScript(script)
                    }}
                  >
                    ✕
                  </Button>
                </ListGroup.Item>
              ))
            )}
          </ListGroup>
        </Card>

        {/* ---------------- Editor + console ---------------- */}
        <div className="flex-grow-1" style={{ minWidth: 0 }}>
          {notReady ? (
            <Alert variant="warning" className="mb-3">
              <Alert.Heading className="h6">Sandbox mode is not ready yet</Alert.Heading>
              <p className="mb-2 small">{preflight.message}</p>
              <div className="small">
                <div>
                  Build the execution image once:{' '}
                  <code>./sandbox/build-sandbox-image.sh</code>
                </div>
                <div>
                  If SignBridge itself runs in a container, mount the Docker socket:{' '}
                  <code>-v /var/run/docker.sock:/var/run/docker.sock</code>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline-dark"
                className="mt-2"
                onClick={refreshEnvironment}
              >
                Re-check
              </Button>
            </Alert>
          ) : null}

          {/* A credential error gets Authorize + Run again; anything else is a
              plain dismissible message, as before. */}
          <ApiErrorAlert
            error={error}
            profileName={profileName}
            onRetry={errorNeedsAuth && !running ? doRun : null}
            retryLabel="Run again"
            onDismiss={() => setError('')}
            className="mb-3"
          />

          <Card className="mb-3">
            <Card.Body className="py-2">
              <div className="d-flex flex-wrap align-items-end gap-3">
                <Form.Group>
                  <Form.Label className="small mb-1">Language</Form.Label>
                  <Form.Select
                    size="sm"
                    style={{ width: 150 }}
                    value={runtimeId}
                    onChange={event => changeRuntime(event.target.value)}
                  >
                    {runtimes.map(entry => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>

                <Form.Group>
                  <Form.Label className="small mb-1">Template</Form.Label>
                  <Form.Select
                    size="sm"
                    style={{ width: 170 }}
                    value={templateId || ''}
                    onChange={event => changeTemplate(event.target.value)}
                  >
                    {(runtime?.templates || []).map(template => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
                    ))}
                  </Form.Select>
                </Form.Group>

                {embedded ? (
                  // The dashboard's own Profile / Auth Mechanism selectors sit
                  // directly above this editor, so repeat the choice as read-only
                  // context instead of a second pair of dropdowns.
                  <Form.Group>
                    <Form.Label className="small mb-1">Credentials</Form.Label>
                    <div>
                      {profileName ? (
                        <Badge bg={usesAwsCredentials ? 'success' : 'secondary'}>
                          {profileName}
                          {authnMode ? ` · ${authnLabel(authnMode)}` : ''}
                        </Badge>
                      ) : (
                        <Badge bg="secondary">No credentials</Badge>
                      )}
                    </div>
                  </Form.Group>
                ) : (
                  <>
                    <Form.Group>
                      <Form.Label className="small mb-1">Profile</Form.Label>
                      <Form.Select
                        size="sm"
                        style={{ width: 200 }}
                        value={profileName}
                        onChange={event => setProfileName(event.target.value)}
                      >
                        <option value="">No credentials</option>
                        {profiles.map(profile => (
                          <option key={profile.profileName} value={profile.profileName}>
                            {profile.profileName}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>

                    <Form.Group>
                      <Form.Label className="small mb-1">Auth mechanism</Form.Label>
                      <Form.Select
                        size="sm"
                        style={{ width: 240 }}
                        value={authnMode}
                        disabled={!profileName}
                        onChange={event => setAuthnMode(event.target.value)}
                      >
                        <option value="">Select…</option>
                        {authnMechanisms.map(mode => (
                          <option key={mode} value={mode}>
                            {authnLabel(mode)}
                          </option>
                        ))}
                      </Form.Select>
                    </Form.Group>
                  </>
                )}

                <Form.Group>
                  <Form.Label className="small mb-1">Region</Form.Label>
                  <Form.Control
                    size="sm"
                    style={{ width: 130 }}
                    placeholder="us-east-1"
                    value={region}
                    onChange={event => setRegion(event.target.value)}
                  />
                </Form.Group>

                <div className="d-flex align-items-center gap-2 ms-auto">
                  {running ? (
                    <Button size="sm" variant="danger" onClick={doStop}>
                      ■ Stop
                    </Button>
                  ) : (
                    <Button size="sm" variant="success" disabled={runDisabled} onClick={doRun}>
                      ▶ Run
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    disabled={checking || running || notReady}
                    onClick={() => doCheck()}
                  >
                    {checking ? 'Checking…' : 'Validate'}
                  </Button>
                  <Button size="sm" variant="outline-primary" disabled={saving} onClick={doSave}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>

              <div className="d-flex flex-wrap align-items-center gap-3 mt-2 small text-muted">
                <span>
                  {runtime ? (
                    <>
                      <code>{runtime.fileName}</code>
                      {scriptName ? ` · ${scriptName}${dirty ? ' *' : ''}` : dirty ? ' · unsaved' : ''}
                    </>
                  ) : null}
                </span>
                {runtime?.libraries?.length ? (
                  <span title="Pre-installed in the sandbox image">
                    Available: {runtime.libraries.join(', ')}
                  </span>
                ) : null}
                <Form.Check
                  type="switch"
                  id="sandbox-autocheck"
                  className="ms-auto"
                  label={`Check while typing (${
                    CHECK_KIND_LABEL[runtime?.checkKind] || 'checked'
                  })`}
                  checked={autoCheck}
                  onChange={event => setAutoCheck(event.target.checked)}
                />
              </div>
            </Card.Body>
          </Card>

          <div className="border rounded overflow-hidden mb-3">
            <Editor
              height="420px"
              language={runtime?.monacoLanguage || 'python'}
              path={editorModelPath}
              theme="vs-dark"
              // Deliberately NOT `value={code}` — see setEditorCode above. The
              // buffer owns the text; React only mirrors it.
              defaultValue=""
              onChange={handleCodeChange}
              onMount={handleEditorMount}
              loading={<div className="p-3 text-muted small">Loading editor…</div>}
              options={editorOptions}
            />
          </div>

          {/* ---------------- Remedies ---------------- */}
          {remedies.length ? (
            <Alert variant="info" className="py-2">
              <div className="fw-semibold small mb-1">Suggested fixes</div>
              {remedies.map((remedy, index) => (
                <div key={index} className="small">
                  <strong>{remedy.title}</strong>
                  {remedy.detail ? (
                    <>
                      {' — '}
                      {remedy.link ? (
                        <a href={remedy.link} target="_blank" rel="noopener noreferrer">
                          {remedy.detail}
                        </a>
                      ) : (
                        remedy.detail
                      )}
                    </>
                  ) : null}
                </div>
              ))}
            </Alert>
          ) : null}

          {checkStatus ? (
            <Alert variant={checkStatus.ok ? 'success' : 'warning'} className="py-2 small mb-3">
              {checkStatus.message}
            </Alert>
          ) : null}

          {/* ---------------- Diagnostics list ---------------- */}
          {diagnostics.length ? (
            <Card className="mb-3">
              <Card.Header className="py-2 small fw-semibold">
                Problems ({diagnostics.length})
              </Card.Header>
              <ListGroup variant="flush">
                {diagnostics.slice(0, 20).map((diagnostic, index) => (
                  <ListGroup.Item
                    key={index}
                    action
                    className="py-2 small"
                    onClick={() => {
                      const editor = editorRef.current
                      if (!editor) return
                      editor.revealLineInCenter(diagnostic.line)
                      editor.setPosition({
                        lineNumber: diagnostic.line,
                        column: diagnostic.column
                      })
                      editor.focus()
                    }}
                  >
                    <span className="text-danger fw-semibold">
                      {diagnostic.line}:{diagnostic.column}
                    </span>{' '}
                    {diagnostic.message}
                    {diagnostic.remedy ? (
                      <div className="text-primary">
                        → {diagnostic.remedy.title}
                        {diagnostic.remedy.detail ? ` — ${diagnostic.remedy.detail}` : ''}
                      </div>
                    ) : null}
                  </ListGroup.Item>
                ))}
              </ListGroup>
            </Card>
          ) : null}

          {/* ---------------- Console ---------------- */}
          <Card>
            <Card.Header className="d-flex align-items-center gap-2 py-2">
              <span className="fw-semibold small">Output</span>
              {statusBadge()}
              {result?.durationMs != null ? (
                <span className="small text-muted">{formatDuration(result.durationMs)}</span>
              ) : null}
              {runMeta?.hasAwsCredentials ? (
                <Badge bg="light" text="dark" className="fw-normal">
                  {runMeta.region} · {runMeta.injectedEnv?.length || 0} credential vars
                </Badge>
              ) : running || result ? (
                <Badge bg="light" text="dark" className="fw-normal">
                  no AWS credentials
                </Badge>
              ) : null}
              {result?.truncated ? (
                <Badge bg="warning" text="dark">
                  output truncated
                </Badge>
              ) : null}
              <Button
                size="sm"
                variant="link"
                className="ms-auto p-0 small"
                onClick={() => {
                  setOutput([])
                  setResult(null)
                }}
              >
                Clear
              </Button>
            </Card.Header>
            <Card.Body className="p-0">
              <div
                ref={consoleRef}
                className="p-3"
                style={{
                  maxHeight: 320,
                  overflowY: 'auto',
                  background: '#1e1e1e',
                  color: '#d4d4d4',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: 12.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  minHeight: 120
                }}
              >
                {output.length === 0 && !running ? (
                  <span className="text-secondary">
                    Press ▶ Run (or {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter) to
                    execute this code in a fresh sandbox container.
                  </span>
                ) : (
                  output.map((entry, index) => (
                    <span
                      key={index}
                      style={entry.stream === 'stderr' ? { color: '#f48771' } : undefined}
                    >
                      {entry.text}
                    </span>
                  ))
                )}
              </div>
              {result?.stoppedReason ? (
                <div className="px-3 py-2 small text-muted border-top">{result.stoppedReason}</div>
              ) : null}
            </Card.Body>
            <Card.Footer className="py-1 small text-muted d-flex flex-wrap gap-3">
              {limits ? (
                <>
                  <span>Time limit {limits.timeoutSeconds}s</span>
                  <span>Memory-capped container, read-only workspace</span>
                  {usesAwsCredentials ? (
                    <span>
                      Credentials are passed to the container by name and never written to disk
                    </span>
                  ) : (
                    <span>Select a profile to run against AWS</span>
                  )}
                </>
              ) : null}
            </Card.Footer>
          </Card>
        </div>
      </div>
      {confirmDialog}
      {promptDialog}
    </>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ListGroup, Modal, Spinner } from 'react-bootstrap'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import ChatPanel from '../components/ChatPanel.jsx'
import { useConfirm, usePrompt } from '../components/ConfirmDialog.jsx'
import {
  listChatThreads,
  newChatThread,
  deleteChatThread,
  renameChatThread,
  summarizeChatThread
} from '../components/presignApi'

// Links in a rendered summary open in a new tab, matching the chat transcript.
const MARKDOWN_COMPONENTS = {
  a({ node, children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  }
}

// A right-click context menu anchored at a screen position. Closes on any click,
// scroll, Escape, or resize. Rendered inline (position: fixed) so it floats above
// the sidebar without a portal.
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    function onDocClick(event) {
      if (ref.current && !ref.current.contains(event.target)) onClose()
    }
    function onKey(event) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  // Keep the menu on-screen if opened near the right/bottom edge.
  const MENU_WIDTH = 208
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8)
  const top = Math.min(y, window.innerHeight - items.length * 40 - 16)

  return (
    <div
      ref={ref}
      className="shadow-sm rounded border bg-white py-1"
      style={{ position: 'fixed', top, left, zIndex: 1080, width: MENU_WIDTH }}
      role="menu"
    >
      {items.map((item, index) => (
        <div key={index}>
          {item.dividerBefore ? <div className="dropdown-divider my-1" /> : null}
          <button
            type="button"
            role="menuitem"
            className={`btn btn-sm w-100 text-start d-flex align-items-center gap-2 border-0 rounded-0 px-3 py-2 ${
              item.danger ? 'text-danger' : 'text-body'
            }`}
            style={{ fontSize: '0.875rem' }}
            onMouseEnter={event => (event.currentTarget.style.backgroundColor = '#f1f3f5')}
            onMouseLeave={event => (event.currentTarget.style.backgroundColor = 'transparent')}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  )
}

// A ChatGPT/Cursor-style page: a left sidebar listing prior chat sessions and a
// main transcript. The current thread is owned here and handed to ChatPanel as a
// controlled prop so switching sessions loads that conversation. Sessions support
// a right-click menu (rename / summarize / delete) with themed modals — no native
// browser prompts/confirms.
export default function ChatPage() {
  const [threads, setThreads] = useState([])
  const [threadId, setThreadId] = useState(null)
  const [loadingThreads, setLoadingThreads] = useState(true)

  // Right-click context menu: { x, y, thread } or null.
  const [menu, setMenu] = useState(null)

  // Shared themed dialogs (replace native confirm/prompt) — same hook the
  // Profiles/Favorites/History/Templates pages use, for one consistent look.
  const { confirm, confirmDialog } = useConfirm()
  const { prompt, promptDialog } = usePrompt()

  const [summary, setSummary] = useState(null) // { thread, text, loading, error }

  const refreshThreads = useCallback(async () => {
    try {
      const result = await listChatThreads()
      setThreads(result.threads || [])
    } catch {
      setThreads([])
    } finally {
      setLoadingThreads(false)
    }
  }, [])

  useEffect(() => {
    refreshThreads()
  }, [refreshThreads])

  async function onNewChat() {
    try {
      const result = await newChatThread()
      setThreadId(result.threadId || null)
    } catch {
      setThreadId(null)
    }
    refreshThreads()
  }

  function openMenu(event, thread) {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, thread })
  }

  // ---- Delete (themed confirm) ----
  async function startDelete(thread) {
    if (!thread) return
    const confirmed = await confirm({
      title: 'Delete chat session',
      message: `Delete "${thread.title || 'this chat'}"? This permanently removes the conversation and cannot be undone.`
    })
    if (!confirmed) return
    try {
      await deleteChatThread(thread.threadId)
    } catch {
      // ignore — refresh reflects the true state
    }
    if (thread.threadId === threadId) setThreadId(null)
    refreshThreads()
  }

  // ---- Rename (themed prompt) ----
  async function startRename(thread) {
    if (!thread) return
    const title = await prompt({
      title: 'Rename session',
      placeholder: 'Session name',
      confirmLabel: 'Save',
      initialValue: thread.title || '',
      onSubmit: value => renameChatThread(thread.threadId, value)
    })
    if (title == null) return // cancelled or failed
    refreshThreads()
  }

  // ---- Summarize ----
  async function startSummarize(thread) {
    setSummary({ thread, text: '', loading: true, error: '' })
    try {
      const result = await summarizeChatThread(thread.threadId)
      setSummary({ thread, text: result.summary || '', loading: false, error: '' })
    } catch (err) {
      const message = err.response?.data?.message || err.message || 'Failed to summarize this session.'
      setSummary({ thread, text: '', loading: false, error: message })
    }
  }

  return (
    <div className="row g-3">
      <div className="col-lg-3">
        <div className="d-flex flex-column gap-2" style={{ position: 'sticky', top: '1rem' }}>
          <Button variant="primary" onClick={onNewChat}>
            + New chat
          </Button>
          {loadingThreads ? (
            <div className="text-muted small d-flex align-items-center gap-2">
              <Spinner animation="border" size="sm" /> Loading sessions…
            </div>
          ) : threads.length === 0 ? (
            <div className="text-muted small">No previous chats yet.</div>
          ) : (
            <ListGroup style={{ maxHeight: '70vh', overflowY: 'auto' }}>
              {threads.map(thread => (
                <ListGroup.Item
                  key={thread.threadId}
                  action
                  active={thread.threadId === threadId}
                  onClick={() => setThreadId(thread.threadId)}
                  onContextMenu={event => openMenu(event, thread)}
                  className="d-flex justify-content-between align-items-start gap-2"
                  title="Right-click for options"
                >
                  <div className="text-truncate">
                    <div className="text-truncate">{thread.title || 'New chat'}</div>
                    <div
                      className={`small ${thread.threadId === threadId ? 'text-white-50' : 'text-muted'}`}
                    >
                      {thread.messageCount || 0} messages
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={thread.threadId === threadId ? 'light' : 'outline-secondary'}
                    onClick={event => openMenu(event, thread)}
                    title="Options"
                  >
                    ⋯
                  </Button>
                </ListGroup.Item>
              ))}
            </ListGroup>
          )}
          <div className="text-muted small">Tip: right-click a session for rename, summarize, and delete.</div>
        </div>
      </div>
      <div className="col-lg-9" style={{ minHeight: '75vh' }}>
        <ChatPanel
          threadId={threadId}
          onThreadChange={setThreadId}
          onActivity={refreshThreads}
          showNewChat={false}
        />
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Rename session', icon: '✏️', onClick: () => startRename(menu.thread) },
            { label: 'Summarize session', icon: '📄', onClick: () => startSummarize(menu.thread) },
            {
              label: 'Delete session',
              icon: '🗑️',
              danger: true,
              dividerBefore: true,
              onClick: () => startDelete(menu.thread)
            }
          ]}
        />
      ) : null}

      {/* Delete confirmation + rename — shared themed dialogs (useConfirm/usePrompt) */}
      {confirmDialog}
      {promptDialog}

      {/* Summary */}
      <Modal show={!!summary} onHide={() => setSummary(null)} centered size="lg">
        <Modal.Header closeButton>
          <Modal.Title className="text-truncate">
            Summary — {summary?.thread?.title || 'chat session'}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {summary?.loading ? (
            <div className="text-muted d-flex align-items-center gap-2">
              <Spinner animation="border" size="sm" /> Summarizing…
            </div>
          ) : summary?.error ? (
            <div className="text-danger small">{summary.error}</div>
          ) : (
            <div className="chat-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {summary?.text || ''}
              </ReactMarkdown>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setSummary(null)}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  )
}

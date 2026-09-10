import React, { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter as Router, Link, Navigate, Route, Routes } from 'react-router-dom'
import { Container, Nav, Navbar } from 'react-bootstrap'

import { appPath } from './appConfig'
import { getSession, setCachedUsername } from './session'

// Route components are code-split: each page's JS (and its heavy deps such as
// Cloudscape and react-markdown) loads only when that route is first visited,
// keeping the initial bundle small and navigation fast.
//
// Each import is a named loader so it can be reused for prefetch-on-hover.
// Dynamic import() caches its module promise, so calling a loader again (e.g.
// hover then click) reuses the in-flight/resolved chunk — no double download.
const loadDashboard = () => import('./pages/DashboardPage.jsx')
const loadChat = () => import('./pages/ChatPage.jsx')
const loadSandbox = () => import('./pages/SandboxPage.jsx')
const loadS3World = () => import('./pages/S3WorldPage.jsx')
const loadS3Object = () => import('./pages/S3ObjectPage.jsx')
const loadAbout = () => import('./components/PresignAbout.jsx')
const loadFavorites = () => import('./components/PresignFavorites.jsx')
const loadHistory = () => import('./components/PresignHistory.jsx')
const loadProfiles = () => import('./components/PresignProfiles.jsx')
const loadSettings = () => import('./components/PresignSettings.jsx')
const loadTemplates = () => import('./components/PresignTemplates.jsx')

const DashboardPage = lazy(loadDashboard)
const ChatPage = lazy(loadChat)
const SandboxPage = lazy(loadSandbox)
const S3WorldPage = lazy(loadS3World)
const S3ObjectPage = lazy(loadS3Object)
const PresignAbout = lazy(loadAbout)
const PresignFavorites = lazy(loadFavorites)
const PresignHistory = lazy(loadHistory)
const PresignProfiles = lazy(loadProfiles)
const PresignSettings = lazy(loadSettings)
const PresignTemplates = lazy(loadTemplates)

// Nav items in display order. `load` is the matching chunk loader, fired on
// hover/focus to warm the chunk before the user clicks.
const NAV_ITEMS = [
  { label: 'Dashboard', path: '/dashboard', load: loadDashboard },
  { label: 'Chat', path: '/chat', load: loadChat },
  { label: 'Sandbox', path: '/sandbox', load: loadSandbox },
  { label: 'S3 World', path: '/s3world', load: loadS3World },
  { label: 'Profiles', path: '/profiles', load: loadProfiles },
  { label: 'History', path: '/history', load: loadHistory },
  { label: 'Favorites', path: '/favorites', load: loadFavorites },
  { label: 'Templates', path: '/templates', load: loadTemplates },
  { label: 'Settings', path: '/settings', load: loadSettings },
  { label: 'About', path: '/about', load: loadAbout }
]

import 'bootstrap/dist/css/bootstrap.min.css'
import '@cloudscape-design/global-styles/index.css'
import './app.css'

// Prefetch a route's chunk. Swallows errors (a failed prefetch is harmless — the
// real navigation will retry) so a hover never surfaces an error to the user.
function prefetch(load) {
  try {
    const result = load()
    if (result && typeof result.catch === 'function') result.catch(() => {})
  } catch {
    // ignore — chunk will load on actual navigation
  }
}

function AppShell({ session, children }) {
  return (
    <>
      <Navbar bg="dark" variant="dark" expand="lg" className="mb-3">
        <Container fluid>
          <Navbar.Brand
            as={Link}
            to={appPath('/dashboard')}
            className="d-flex align-items-center gap-2"
            onMouseEnter={() => prefetch(loadDashboard)}
            onFocus={() => prefetch(loadDashboard)}
          >
            <img
              src={`${import.meta.env.BASE_URL}favicon.svg`}
              alt=""
              width="28"
              height="28"
              className="d-inline-block align-text-top"
            />
            SignBridge
          </Navbar.Brand>
          <Navbar.Toggle aria-controls="presign-nav" />
          <Navbar.Collapse id="presign-nav">
            <Nav className="me-auto">
              {NAV_ITEMS.map(item => (
                <Nav.Link
                  key={item.path}
                  as={Link}
                  to={appPath(item.path)}
                  onMouseEnter={() => prefetch(item.load)}
                  onFocus={() => prefetch(item.load)}
                >
                  {item.label}
                </Nav.Link>
              ))}
            </Nav>
            <Navbar.Text className="text-light">
              {session.displayName} ({session.userName})
            </Navbar.Text>
          </Navbar.Collapse>
        </Container>
      </Navbar>
      <Container fluid>{children}</Container>
    </>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getSession()
      .then(sessionData => {
        setCachedUsername(sessionData.userName)
        setSession(sessionData)
      })
      .catch(loadError => setError(loadError.message || 'Failed to load session'))
  }, [])

  if (error) {
    return <div className="p-4 text-danger">{error}</div>
  }

  if (!session) {
    return <div className="p-4">Loading SignBridge...</div>
  }

  return (
    <Router>
      <AppShell session={session}>
        <Suspense fallback={<div className="p-4 text-muted">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to={appPath('/dashboard')} replace />} />
            <Route path={appPath('/dashboard')} element={<DashboardPage />} />
            <Route path={appPath('/chat')} element={<ChatPage />} />
            <Route path={appPath('/sandbox')} element={<SandboxPage />} />
            <Route path={appPath('/s3world')} element={<S3WorldPage />} />
            {/* The standalone object viewer, opened in a new tab from S3 World. */}
            <Route path={appPath('/s3world/object')} element={<S3ObjectPage />} />
            <Route path={appPath('/profiles')} element={<PresignProfiles />} />
            <Route path={appPath('/history')} element={<PresignHistory />} />
            <Route path={appPath('/favorites')} element={<PresignFavorites />} />
            <Route path={appPath('/templates')} element={<PresignTemplates />} />
            <Route path={appPath('/settings')} element={<PresignSettings />} />
            <Route path={appPath('/about')} element={<PresignAbout />} />
            <Route path="*" element={<Navigate to={appPath('/dashboard')} replace />} />
          </Routes>
        </Suspense>
      </AppShell>
    </Router>
  )
}

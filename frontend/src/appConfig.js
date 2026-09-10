export const PROJECT_NAME = 'signbridge'
export const ROUTE_PREFIX = 'signbridge'
export const API_BASE = `/${ROUTE_PREFIX}`
export const DEFAULT_USER_NAME = 'signbridgeuser'
export const DEFAULT_DISPLAY_NAME = 'SignBridge User'
export const DEFAULT_EMAIL = 'signbridgeuser@localhost'

// Mirrors [app] tagline in config.properties. Rendered in the navbar and as the
// About page's subtitle, so it lives here rather than in either component.
export const TAGLINE = 'Presign URLs. Invoke APIs. Bridge IAM & SSO roles.'

export const defaultSession = {
  userName: DEFAULT_USER_NAME,
  displayName: DEFAULT_DISPLAY_NAME,
  emailAddress: DEFAULT_EMAIL
}

export function appPath(path = '') {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${normalizedPath}`
}

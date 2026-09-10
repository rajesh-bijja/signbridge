import { defaultSession, DEFAULT_USER_NAME, PROJECT_NAME } from './appConfig'

let cachedSession = defaultSession
let cachedUsername = DEFAULT_USER_NAME

export async function getSession() {
  return cachedSession
}

export async function getUsername() {
  return cachedUsername
}

export function getCachedUsername() {
  return cachedUsername
}

export function setCachedUsername(userName) {
  cachedUsername = userName || DEFAULT_USER_NAME
}

export function getProjectName() {
  return PROJECT_NAME
}

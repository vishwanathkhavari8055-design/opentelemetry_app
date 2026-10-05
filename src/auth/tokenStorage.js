/**
 * Token persistence abstraction.
 *
 * "Remember me" → localStorage (survives browser restart).
 * Otherwise    → sessionStorage (cleared when the tab closes).
 *
 * A single module owns *where* tokens live so the rest of the app never touches
 * Web Storage directly. Passwords are never stored — only the issued tokens and
 * a minimal, non-sensitive user profile (id, username, role, displayName).
 *
 * All access is wrapped in try/catch: storage can throw in private-mode or
 * sandboxed iframes, and auth should degrade to in-memory rather than crash.
 */
import { STORAGE_KEYS } from './constants';

/** Pick the backing store based on the persisted "remember" flag. */
function activeStore() {
  try {
    if (window.localStorage.getItem(STORAGE_KEYS.REMEMBER) === 'true') {
      return window.localStorage;
    }
  } catch {
    /* ignore — fall through to sessionStorage */
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function safeGet(store, key) {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(store, key, value) {
  try {
    if (store) store.setItem(key, value);
  } catch {
    /* ignore quota/security errors */
  }
}

/** Persist a full session. `remember` decides the storage lifetime. */
export function persistSession({ accessToken, refreshToken, user, remember }) {
  // The remember flag itself always goes to localStorage so a page reload can
  // rediscover which store holds the session.
  try {
    if (remember) {
      window.localStorage.setItem(STORAGE_KEYS.REMEMBER, 'true');
    } else {
      window.localStorage.removeItem(STORAGE_KEYS.REMEMBER);
    }
  } catch {
    /* ignore */
  }

  const store = activeStore();
  safeSet(store, STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  safeSet(store, STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
  safeSet(store, STORAGE_KEYS.USER, JSON.stringify(user));
}

/** Update just the tokens (used on silent refresh) without touching the user. */
export function persistTokens({ accessToken, refreshToken }) {
  const store = activeStore();
  safeSet(store, STORAGE_KEYS.ACCESS_TOKEN, accessToken);
  if (refreshToken) safeSet(store, STORAGE_KEYS.REFRESH_TOKEN, refreshToken);
}

export function getAccessToken() {
  return safeGet(activeStore(), STORAGE_KEYS.ACCESS_TOKEN);
}

export function getRefreshToken() {
  return safeGet(activeStore(), STORAGE_KEYS.REFRESH_TOKEN);
}

export function getStoredUser() {
  const raw = safeGet(activeStore(), STORAGE_KEYS.USER);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Wipe every trace of the session from both stores. */
export function clearSession() {
  [window.localStorage, window.sessionStorage].forEach((store) => {
    try {
      store.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
      store.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
      store.removeItem(STORAGE_KEYS.USER);
    } catch {
      /* ignore */
    }
  });
  try {
    window.localStorage.removeItem(STORAGE_KEYS.REMEMBER);
  } catch {
    /* ignore */
  }
}

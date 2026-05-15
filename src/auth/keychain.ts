import { createRequire as cjsRequire } from 'module';

// Keytar is a native addon (Keychain on macOS, Credential Manager on Windows).
// It is NOT bundled — it must be present in node_modules at runtime.
// In the Claude Extensions install folder there is no node_modules, so we
// load it lazily and fail gracefully: all tools work; only GitHub version
// control (Agency tier) requires a working keychain.

const _require = cjsRequire(import.meta.url);

const SERVICE = 'automategs';

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let _keytar: KeytarLike | null | undefined; // undefined = not yet attempted

function loadKeytar(): KeytarLike | null {
  if (_keytar !== undefined) return _keytar;
  try {
    _keytar = _require('keytar') as KeytarLike;
  } catch {
    _keytar = null;
    console.error('[AutomateGS] keytar not available — system keychain disabled (GitHub version control will not work)');
  }
  return _keytar;
}

export async function storeSecret(key: string, value: string): Promise<void> {
  const kt = loadKeytar();
  if (!kt) throw new Error('System keychain not available (keytar failed to load).');
  await kt.setPassword(SERVICE, key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  const kt = loadKeytar();
  if (!kt) return null;
  return kt.getPassword(SERVICE, key);
}

export async function deleteSecret(key: string): Promise<void> {
  const kt = loadKeytar();
  if (!kt) return;
  await kt.deletePassword(SERVICE, key);
}

import { sha256, withShortLease } from './storage.js';

const COLLECTION = 'private_ima_sessions';
const VERSION = 1;
const encoder = new TextEncoder();
const unavailable = () => ({ status: 'unavailable', message: 'native_session_unavailable' });
const invalid = () => Object.assign(new Error('invalid_native_session'), { status: 'invalid_input' });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function encode64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  if (encode64(bytes) !== value) throw invalid();
  return bytes;
}

function validString(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  // Iteration combines valid surrogate pairs while preserving lone surrogates.
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}

function numeric(value) {
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
  return value;
}

function expiry(account, name, validityName, now) {
  const value = account[name] === undefined
    ? now + numeric(account[validityName]) * 1000
    : numeric(account[name]);
  if (value <= 0 || value > 8640000000000000) throw invalid();
  return value;
}

function normalize(account, device = {}, now = Date.now()) {
  if (!isRecord(account) || !isRecord(device)) throw invalid();
  const accountInfo = {};
  for (const field of ['userId', 'token', 'refreshToken']) {
    if (!validString(account[field], field === 'userId' ? 1024 : 16384)) throw invalid();
    accountInfo[field] = account[field];
  }
  for (const field of ['idType', 'tokenType', 'guid', 'uid', 'openId', 'accountType']) {
    if (!Object.hasOwn(account, field) || account[field] === undefined) continue;
    const value = account[field];
    if (!validString(value, 4096) && !(typeof value === 'number' && Number.isSafeInteger(value))) throw invalid();
    accountInfo[field] = value;
  }
  for (const field of ['tokenValidTime', 'refreshTokenValidTime']) {
    if (account[field] === undefined) continue;
    const value = numeric(account[field]);
    if (value < 0 || now + value * 1000 > 8640000000000000) throw invalid();
    accountInfo[field] = value;
  }
  accountInfo.tokenExpiredTime = expiry(account, 'tokenExpiredTime', 'tokenValidTime', now);
  accountInfo.refreshTokenExpiredTime = expiry(account, 'refreshTokenExpiredTime', 'refreshTokenValidTime', now);
  const deviceInfo = {};
  for (const field of ['guid', 'q36', 'qua', 'version']) {
    if (!Object.hasOwn(device, field) || device[field] === undefined) continue;
    if (!validString(device[field], 4096)) throw invalid();
    deviceInfo[field] = device[field];
  }
  return { account_info: accountInfo, device_info: deviceInfo };
}

async function configuration(ctx) {
  const raw = decode64(ctx.env?.IMA_SESSION_ENCRYPTION_KEY);
  if (raw.length !== 32 || !validString(ctx.env?.IMA_OPENAPI_CLIENTID, 4096)) throw invalid();
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, account: await sha256(ctx.env.IMA_OPENAPI_CLIENTID) };
}

function aad(account, row) {
  // Authenticate public metadata as well as the client and format version.
  return encoder.encode(JSON.stringify([
    'ima-native-session', account, row.version, row.sequence, row.updated_at,
    row.expires_at, row.refresh_expires_at, row.state,
  ]));
}

function receipt(row, received = false) {
  const missing = !row || row.state === 'missing';
  const now = Date.now();
  const accessExpired = !missing && row.expires_at <= now;
  const refreshExpired = !missing && row.refresh_expires_at <= now;
  const expired = accessExpired || refreshExpired;
  return {
    status: 'succeeded',
    session: {
      state: missing ? 'missing' : received || !expired ? 'received' : 'expired',
      expires_at: missing ? null : row.expires_at,
      refresh_expires_at: missing ? null : row.refresh_expires_at,
      updated_at: row?.updated_at ?? null,
      revision: row?.sequence ?? 0,
      reauthorization_required: missing || refreshExpired,
      refresh_required: accessExpired && !refreshExpired,
      move_verified: false,
    },
  };
}

function validRow(row) {
  if (!isRecord(row) || row.version !== VERSION || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
      typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) throw Error('invalid_session_row');
  if (row.state === 'missing') {
    if (row.ciphertext !== undefined || row.iv !== undefined || row.expires_at !== null || row.refresh_expires_at !== null) throw Error('invalid_session_row');
  } else if (row.state !== 'received' || typeof row.expires_at !== 'number' || typeof row.refresh_expires_at !== 'number' ||
      !Number.isFinite(row.expires_at) || !Number.isFinite(row.refresh_expires_at)) throw Error('invalid_session_row');
}

async function readSession(store, config) {
  const row = await store.get(COLLECTION, config.account);
  if (!row) return { row: null, current: null };
  validRow(row);
  if (row.state === 'missing') return { row, current: null };
  const iv = decode64(row.iv), ciphertext = decode64(row.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw Error('invalid_session_row');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(config.account, row), tagLength: 128 }, config.key, ciphertext);
  const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  const payload = normalize(decoded.account_info, decoded.device_info);
  if (payload.account_info.tokenExpiredTime !== row.expires_at || payload.account_info.refreshTokenExpiredTime !== row.refresh_expires_at) throw Error('invalid_session_row');
  return {
    row,
    current: {
      ...payload, revision: row.sequence, updated_at: row.updated_at,
      expires_at: row.expires_at, refresh_expires_at: row.refresh_expires_at,
    },
  };
}

function nextRevision(row) {
  const sequence = row?.sequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) throw Error('invalid_session_revision');
  return sequence + 1;
}

async function writeSession(store, config, previous, payload) {
  const row = {
    version: VERSION, sequence: nextRevision(previous), updated_at: new Date().toISOString(),
    expires_at: payload.account_info.tokenExpiredTime, refresh_expires_at: payload.account_info.refreshTokenExpiredTime,
    state: 'received',
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(config.account, row), tagLength: 128 }, config.key, encoder.encode(JSON.stringify(payload)));
  await store.put(COLLECTION, config.account, { ...row, iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) });
  return receipt(row, true);
}

async function run(ctx, action, write = false) {
  let config;
  try { config = await configuration(ctx); }
  catch { return { status: 'blocked', message: 'native_session_encryption_configuration_required' }; }
  try {
    const root = ctx.baseStore || ctx.store;
    if (!write) return await action(root, config);
    // Native sessions and their lock are global, including in isolated workspaces.
    // The leased proxy still performs atomic fenced D1 writes on this root store.
    const globalCtx = { ...ctx, store: root, baseStore: root, workspace: 'global' };
    return await withShortLease(globalCtx, 'governance:ima-session:' + config.account, leased => action(leased.store, config));
  } catch (error) {
    if (error?.status === 'conflict') return { status: 'conflict', message: 'native_session_operation_in_progress_or_lease_lost' };
    if (error?.status === 'invalid_input') return { status: 'invalid_input', message: 'invalid_native_session' };
    return unavailable();
  }
}

export async function saveNativeSession(ctx, accountInfo, deviceInfo = {}) {
  return run(ctx, async (store, config) => {
    const payload = normalize(accountInfo, deviceInfo);
    return writeSession(store, config, await store.get(COLLECTION, config.account), payload);
  }, true);
}

// Internal consumers only: this operation returns plaintext credentials.
// It must never be exposed directly as a tool or an HTTP response.
export async function loadNativeSession(ctx) {
  return run(ctx, async (store, config) => {
    try {
      const { row, current } = await readSession(store, config);
      return current || receipt(row);
    } catch { return unavailable(); }
  });
}

export async function nativeSessionStatus(ctx) {
  return run(ctx, async (store, config) => {
    try { return receipt((await readSession(store, config)).row); }
    catch { return unavailable(); }
  });
}

export async function forgetNativeSession(ctx) {
  return run(ctx, async (store, config) => {
    const previous = await store.get(COLLECTION, config.account);
    if (!previous) return receipt(null);
    // A nonsecret tombstone preserves the revision across revoke and rescan.
    const row = {
      version: VERSION, sequence: nextRevision(previous), updated_at: new Date().toISOString(),
      expires_at: null, refresh_expires_at: null, state: 'missing',
    };
    await store.put(COLLECTION, config.account, row);
    return receipt(row);
  }, true);
}

export async function updateNativeSession(ctx, updater) {
  return run(ctx, async (store, config) => {
    let existing;
    try { existing = await readSession(store, config); }
    catch { return unavailable(); }
    if (!existing.current) return receipt(existing.row);
    if (typeof updater !== 'function') throw invalid();
    let next;
    try { next = await updater(existing.current); }
    catch { return unavailable(); }
    if (!isRecord(next)) throw invalid();
    return writeSession(store, config, existing.row, normalize(next.account_info, next.device_info));
  }, true);
}

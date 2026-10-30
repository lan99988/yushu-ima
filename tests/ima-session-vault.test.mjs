import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './fixtures/runtime.mjs';
import { D1Store, sha256 } from '../worker/storage.js';

let vault = {};
try { vault = await import('../worker/ima-session-vault.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const key = btoa('0123456789abcdef0123456789abcdef');
const otherKey = btoa('abcdef0123456789abcdef0123456789');
const collection = 'private_ima_sessions';
function setup(t) {
  const env = runtime();
  env.IMA_SESSION_ENCRYPTION_KEY = key;
  t.after(() => env.close());
  const store = new D1Store(env.DB);
  return { env, store };
}
function account(patch = {}) {
  return {
    userId: 'synthetic-user-用户-🔒', token: 'synthetic-access-secret-0123456789',
    refreshToken: 'synthetic-refresh-secret-0123456789', idType: 1, tokenType: 2,
    guid: 'synthetic-account-guid', uid: 'synthetic-uid', openId: 'synthetic-open-id', accountType: 3,
    tokenExpiredTime: Date.now() + 3600000, refreshTokenExpiredTime: Date.now() + 86400000,
    ...patch,
  };
}
const device = { guid: 'synthetic-device-guid', q36: 'synthetic-q36', qua: 'synthetic-qua', version: 'synthetic-device-version' };
async function row(ctx) {
  return ctx.store.get(collection, await sha256(ctx.env.IMA_OPENAPI_CLIENTID));
}
function assertSafe(value, info = account()) {
  const serialized = JSON.stringify(value);
  for (const secret of [info.userId, info.token, info.refreshToken, info.guid, info.uid, info.openId, ...Object.values(device)]) {
    assert.equal(serialized.includes(secret), false, 'public result must not include a synthetic secret');
  }
  for (const field of ['account_info', 'device_info', 'ciphertext', 'iv', 'userId', 'refreshToken']) {
    assert.equal(serialized.includes('"' + field + '"'), false, 'public result must not include private fields');
  }
}

test('exports only the five internal vault operations', () => {
  assert.deepEqual(Object.keys(vault).sort(), ['forgetNativeSession', 'loadNativeSession', 'nativeSessionStatus', 'saveNativeSession', 'updateNativeSession'].sort());
});

for (const candidate of [undefined, '', 'not-base64', btoa('short'), btoa('x'.repeat(33))]) {
  test(`absent or invalid dedicated encryption key blocks every operation (${String(candidate?.length)})`, async t => {
    const ctx = setup(t);
    ctx.env.IMA_SESSION_ENCRYPTION_KEY = candidate;
    let calls = 0;
    for (const result of [
      await vault.saveNativeSession(ctx, account(), device), await vault.loadNativeSession(ctx),
      await vault.nativeSessionStatus(ctx), await vault.forgetNativeSession(ctx),
      await vault.updateNativeSession(ctx, () => { calls++; }),
    ]) { assert.equal(result.status, 'blocked'); assertSafe(result); }
    assert.equal(calls, 0);
    assert.equal((await ctx.store.list(collection)).items.length, 0);
  });
}

test('missing session has a safe status and update never calls its updater', async t => {
  const ctx = setup(t);
  const status = await vault.nativeSessionStatus(ctx);
  assert.equal(status.status, 'succeeded');
  assert.equal(status.session.state, 'missing');
  assert.equal(status.session.reauthorization_required, true);
  assert.equal(status.session.refresh_required, false);
  assert.equal(status.session.move_verified, false);
  assert.equal((await vault.loadNativeSession(ctx)).session.state, 'missing');
  const result = await vault.updateNativeSession(ctx, () => assert.fail('missing session must not invoke updater'));
  assert.equal(result.session.state, 'missing');
  assertSafe(result);
});

test('round trips the official whitelist internally and persists no plaintext credentials anywhere in D1', async t => {
  const ctx = setup(t), info = account();
  const result = await vault.saveNativeSession(ctx, { ...info, extraSecret: 'discard-me' }, { ...device, extraSecret: 'discard-device' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.session.state, 'received');
  assert.equal(result.session.expires_at, info.tokenExpiredTime);
  assert.equal(result.session.revision, 1);
  assert.equal(result.session.reauthorization_required, false);
  assert.equal(result.session.refresh_required, false);
  assert.equal(result.session.move_verified, false);
  assertSafe(result, info);
  const loaded = await vault.loadNativeSession(ctx);
  assert.deepEqual(loaded.account_info, info);
  assert.deepEqual(loaded.device_info, device);
  assert.equal(loaded.revision, result.session.revision);
  const all = await ctx.env.DB.prepare('SELECT * FROM documents').all();
  const serialized = JSON.stringify(all);
  for (const secret of [info.userId, info.token, info.refreshToken, info.guid, info.uid, info.openId, ...Object.values(device), 'discard-me', 'discard-device']) {
    assert.equal(serialized.includes(secret), false, 'D1 must not contain plaintext synthetic credentials');
  }
  assert.equal((await ctx.store.list(collection)).items[0].key, await sha256(ctx.env.IMA_OPENAPI_CLIENTID));
  assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, info);
  assertSafe(await vault.nativeSessionStatus(ctx), info);
});

test('repeated saves use fresh encryption and monotonically increasing revisions', async t => {
  const ctx = setup(t), info = account();
  await vault.saveNativeSession(ctx, info);
  const first = await row(ctx);
  const next = await vault.saveNativeSession(ctx, info);
  const second = await row(ctx);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(next.session.revision, 2);
  assert.deepEqual((await vault.loadNativeSession(ctx)).device_info, {});
});

test('validity seconds infer finite epoch millisecond expiry for both official tokens', async t => {
  const ctx = setup(t), before = Date.now();
  const info = account({ tokenExpiredTime: undefined, refreshTokenExpiredTime: undefined, tokenValidTime: 60, refreshTokenValidTime: 120 });
  const result = await vault.saveNativeSession(ctx, info);
  assert.equal(result.status, 'succeeded');
  const loaded = await vault.loadNativeSession(ctx);
  assert.ok(loaded.account_info.tokenExpiredTime >= before + 60000);
  assert.ok(loaded.account_info.tokenExpiredTime <= Date.now() + 60000);
  assert.ok(loaded.account_info.refreshTokenExpiredTime >= before + 120000);
  assert.ok(loaded.account_info.refreshTokenExpiredTime <= Date.now() + 120000);
});

test('explicit official expiry takes precedence over validity seconds', async t => {
  const ctx = setup(t), info = account({ tokenValidTime: 1, refreshTokenValidTime: 1 });
  await vault.saveNativeSession(ctx, info);
  assert.equal((await vault.loadNativeSession(ctx)).account_info.tokenExpiredTime, info.tokenExpiredTime);
});

for (const [field, value] of [
  ['userId', ''], ['token', '   '], ['refreshToken', null], ['userId', '\ud800'],
  ['token', 'invalid\u0000token'], ['token', 'x'.repeat(16385)], ['userId', 'x'.repeat(1025)],
  ['tokenExpiredTime', Infinity], ['tokenExpiredTime', NaN], ['tokenExpiredTime', 'tomorrow'],
  ['refreshTokenExpiredTime', -1], ['refreshTokenExpiredTime', 1e20],
]) {
  test(`invalid ${field} input is rejected without storing or echoing it (${String(value).length})`, async t => {
    const ctx = setup(t);
    const result = await vault.saveNativeSession(ctx, account({ [field]: value }));
    assert.equal(result.status, 'invalid_input');
    assertSafe(result);
    assert.equal(await row(ctx), null);
  });
}

test('invalid inferred expiry and malformed optional device data are rejected', async t => {
  const ctx = setup(t);
  for (const input of [
    account({ tokenExpiredTime: undefined, tokenValidTime: Infinity }),
    account({ refreshTokenExpiredTime: undefined, refreshTokenValidTime: -10 }),
  ]) assert.equal((await vault.saveNativeSession(ctx, input)).status, 'invalid_input');
  assert.equal((await vault.saveNativeSession(ctx, account(), { guid: { nested: 'secret' } })).status, 'invalid_input');
  assert.equal(await row(ctx), null);
});

test('access expiry is reported safely while internal load preserves credentials for refresh', async t => {
  const ctx = setup(t), info = account({ tokenExpiredTime: Date.now() - 10000 });
  const saved = await vault.saveNativeSession(ctx, info);
  assert.equal(saved.session.state, 'received');
  assert.equal(saved.session.reauthorization_required, false);
  assert.equal(saved.session.refresh_required, true);
  const status = await vault.nativeSessionStatus(ctx);
  assert.equal(status.session.state, 'expired');
  assert.equal(status.session.reauthorization_required, false);
  assert.equal(status.session.refresh_required, true);
  assertSafe(status, info);
  assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, info);
});

for (const accessExpired of [false, true]) {
  test(`expired refresh token requires reauthorization with access expired=${accessExpired}`, async t => {
    const ctx = setup(t);
    const info = account({
      tokenExpiredTime: Date.now() + (accessExpired ? -10000 : 3600000),
      refreshTokenExpiredTime: Date.now() - 10000,
    });
    const saved = await vault.saveNativeSession(ctx, info);
    assert.equal(saved.session.reauthorization_required, true);
    assert.equal(saved.session.refresh_required, false);
    const status = await vault.nativeSessionStatus(ctx);
    assert.equal(status.session.state, 'expired');
    assert.equal(status.session.reauthorization_required, true);
    assert.equal(status.session.refresh_required, false);
    assertSafe(status, info);
  });
}

test('wrong encryption key and copied ciphertext under a different client produce the same generic unavailable response', async t => {
  const ctx = setup(t);
  await vault.saveNativeSession(ctx, account(), device);
  const wrongKey = { ...ctx, env: { ...ctx.env, IMA_SESSION_ENCRYPTION_KEY: otherKey } };
  const unavailable = await vault.loadNativeSession(wrongKey);
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(await vault.nativeSessionStatus(wrongKey), unavailable);
  const other = { ...ctx, env: { ...ctx.env, IMA_OPENAPI_CLIENTID: 'different-synthetic-client' } };
  await ctx.store.put(collection, await sha256(other.env.IMA_OPENAPI_CLIENTID), await row(ctx));
  assert.deepEqual(await vault.loadNativeSession(other), unavailable);
  assertSafe(unavailable);
});

for (const field of ['ciphertext', 'iv', 'version', 'sequence', 'expires_at']) {
  test(`tampered ${field} is unavailable without leaking stored data`, async t => {
    const ctx = setup(t);
    await vault.saveNativeSession(ctx, account());
    const saved = await row(ctx);
    const value = typeof saved[field] === 'string' ? (saved[field][0] === 'A' ? 'B' : 'A') + saved[field].slice(1) : saved[field] + 1;
    await ctx.store.put(collection, await sha256(ctx.env.IMA_OPENAPI_CLIENTID), { ...saved, [field]: value });
    const result = await vault.loadNativeSession(ctx);
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(await vault.nativeSessionStatus(ctx), result);
    assertSafe(result);
  });
}

test('workspace isolation cannot create a second session copy or a separate session lock', async t => {
  const ctx = setup(t);
  const isolated = { ...ctx, baseStore: ctx.store, workspace: 'isolated', store: new Proxy(ctx.store, {
    get(target, name) {
      if (['get', 'put', 'remove'].includes(name)) return (c, ...args) => target[name]('test_' + c, ...args);
      const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
  await vault.saveNativeSession(isolated, account(), device);
  assert.equal((await vault.nativeSessionStatus(ctx)).session.state, 'received');
  assert.equal((await ctx.store.list('test_' + collection)).items.length, 0);
  const lockKey = 'governance:ima-session:' + await sha256(ctx.env.IMA_OPENAPI_CLIENTID);
  const lease = await ctx.store.acquireLease(lockKey, 'synthetic-owner');
  assert.equal((await vault.forgetNativeSession(isolated)).status, 'conflict');
  await ctx.store.releaseLock(lockKey, lease.request_id);
  assert.equal((await vault.forgetNativeSession(isolated)).session.state, 'missing');
  assert.equal((await vault.nativeSessionStatus(ctx)).session.state, 'missing');
});

test('revoke removes encrypted credentials, is idempotent, and does not reuse an earlier revision', async t => {
  const ctx = setup(t);
  await vault.saveNativeSession(ctx, account(), device);
  const revoked = await vault.forgetNativeSession(ctx);
  assert.equal(revoked.status, 'succeeded');
  assert.equal(revoked.session.state, 'missing');
  assert.equal(revoked.session.reauthorization_required, true);
  assert.equal(revoked.session.refresh_required, false);
  assertSafe(revoked);
  const saved = await row(ctx);
  assert.ok(!saved?.ciphertext && !saved?.iv);
  assert.equal((await vault.loadNativeSession(ctx)).session.state, 'missing');
  assert.equal((await vault.forgetNativeSession(ctx)).session.state, 'missing');
  const replacement = await vault.saveNativeSession(ctx, account());
  assert.ok(replacement.session.revision > revoked.session.revision);
});

test('updater holds the same lease across async refresh and commits one revision without exposing secrets', async t => {
  const ctx = setup(t), info = account();
  await vault.saveNativeSession(ctx, info, device);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const refreshed = { ...info, token: 'rotated-synthetic-access', refreshToken: 'rotated-synthetic-refresh' };
  const pending = vault.updateNativeSession(ctx, async current => {
    assert.deepEqual(current.account_info, info);
    assert.deepEqual(current.device_info, device);
    assert.equal(current.revision, 1);
    entered();
    await gate;
    return { account_info: refreshed, device_info: current.device_info };
  });
  await started;
  try {
    assert.equal((await vault.saveNativeSession(ctx, account())).status, 'conflict');
    assert.equal((await vault.forgetNativeSession(ctx)).status, 'conflict');
    assert.equal((await vault.updateNativeSession(ctx, () => assert.fail('must not refresh concurrently'))).status, 'conflict');
    assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, info);
  } finally { release(); }
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.session.revision, 2);
  assertSafe(result, refreshed);
  assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, refreshed);
});

test('failing or invalid updater preserves the prior session and does not leak exception data', async t => {
  const ctx = setup(t), info = account();
  await vault.saveNativeSession(ctx, info);
  const failed = await vault.updateNativeSession(ctx, () => { throw Error(info.token); });
  assert.equal(failed.status, 'unavailable');
  assertSafe(failed, info);
  assert.equal((await vault.updateNativeSession(ctx, () => ({ account_info: { ...info, token: '' }, device_info: {} }))).status, 'invalid_input');
  assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, info);
  assert.equal((await vault.loadNativeSession(ctx)).revision, 1);
  assert.equal((await vault.saveNativeSession(ctx, info)).session.revision, 2);
});

test('a lost lease fences out a stale refresh result instead of overwriting the session', async t => {
  const ctx = setup(t), info = account();
  await vault.saveNativeSession(ctx, info);
  const lockKey = 'governance:ima-session:' + await sha256(ctx.env.IMA_OPENAPI_CLIENTID);
  const result = await vault.updateNativeSession(ctx, async () => {
    const lease = await ctx.store.get('locks', lockKey);
    await ctx.store.put('locks', lockKey, { ...lease, request_id: 'synthetic-successor' });
    return { account_info: { ...info, token: 'stale-synthetic-token' }, device_info: {} };
  });
  assert.equal(result.status, 'conflict');
  assert.deepEqual((await vault.loadNativeSession(ctx)).account_info, info);
  assert.equal((await vault.loadNativeSession(ctx)).revision, 1);
});

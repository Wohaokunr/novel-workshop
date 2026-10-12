import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInput } from '../shared/types.js';

const encrypt = async (value: string): Promise<Buffer> => Buffer.from(`encrypted:${value}`);
const decrypt = async (value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> => ({
  result: value.toString().replace(/^encrypted:|^rotated:/, ''), shouldReEncrypt: false,
});
const safeStorageFixture = { encryptStringAsync: encrypt, decryptStringAsync: decrypt };
const fixtureGlobal = globalThis as typeof globalThis & { __novelProviderSafeStorage?: typeof safeStorageFixture };
fixtureGlobal.__novelProviderSafeStorage = safeStorageFixture;
const electronFixtureURL = `data:text/javascript,${encodeURIComponent('export const safeStorage = globalThis.__novelProviderSafeStorage;')}`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: electronFixtureURL, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { ProviderStore } = await import('./providers.js').finally(() => {
  hooks.deregister();
  delete fixtureGlobal.__novelProviderSafeStorage;
});

function fixture(t: TestContext) {
  safeStorageFixture.encryptStringAsync = encrypt;
  safeStorageFixture.decryptStringAsync = decrypt;
  const directory = mkdtempSync(join(tmpdir(), 'novel-provider-'));
  const filename = join(directory, 'provider.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { store: new ProviderStore(filename), filename };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const oldProvider = {
  name: '旧配置', baseURL: 'https://old.invalid/v1', model: 'old-model', mode: 'live',
  apiKey: 'old-fixture-key', reasoningEffort: 'low',
} satisfies ProviderInput;
const newProvider = {
  name: '新配置', baseURL: 'https://new.invalid/v1', model: 'new-model', mode: 'live',
  apiKey: 'new-fixture-key', reasoningEffort: 'high',
} satisfies ProviderInput;

test('解密期间保存新配置，读取仍返回原配置及其密钥', async t => {
  const { store, filename } = fixture(t);
  await store.save(oldProvider);
  const pending = deferred<Awaited<ReturnType<typeof decrypt>>>();
  safeStorageFixture.decryptStringAsync = value => {
    assert.equal(value.toString(), 'encrypted:old-fixture-key');
    return pending.promise;
  };
  const reading = store.secret();
  await store.save(newProvider);
  const saved = readFileSync(filename, 'utf8');
  pending.resolve({ result: oldProvider.apiKey, shouldReEncrypt: false });
  assert.deepEqual(await reading, oldProvider);
  assert.equal(readFileSync(filename, 'utf8'), saved);
  const { apiKey: _key, ...settings } = newProvider;
  assert.deepEqual(store.public(), { ...settings, hasKey: true });
});

test('重加密期间保存新配置，旧密钥轮换不能覆盖新配置', async t => {
  const { store, filename } = fixture(t);
  await store.save(oldProvider);
  safeStorageFixture.decryptStringAsync = async () => ({ result: oldProvider.apiKey, shouldReEncrypt: true });
  const started = deferred<void>();
  const pending = deferred<Buffer>();
  safeStorageFixture.encryptStringAsync = value => {
    if (value !== oldProvider.apiKey) return encrypt(value);
    started.resolve(undefined);
    return pending.promise;
  };
  const reading = store.secret();
  await started.promise;
  await store.save(newProvider);
  const saved = readFileSync(filename, 'utf8');
  pending.resolve(Buffer.from('rotated:old-fixture-key'));
  assert.deepEqual(await reading, oldProvider);
  assert.equal(readFileSync(filename, 'utf8'), saved);
  const { apiKey: _key, ...settings } = newProvider;
  assert.deepEqual(store.public(), { ...settings, hasKey: true });
});

test('正常保存、读取及密钥轮换有效，演示模式不解密密钥', async t => {
  const { store, filename } = fixture(t);
  let decryptions = 0;
  safeStorageFixture.decryptStringAsync = async value => { decryptions++; return decrypt(value); };
  assert.equal((await store.secret()).apiKey, '');
  assert.equal(decryptions, 0);
  await store.save(oldProvider);
  assert.deepEqual(await store.secret(), oldProvider);
  assert.equal(decryptions, 1);
  safeStorageFixture.decryptStringAsync = async value => {
    decryptions++;
    return { ...(await decrypt(value)), shouldReEncrypt: true };
  };
  safeStorageFixture.encryptStringAsync = async value => Buffer.from(`rotated:${value}`);
  assert.deepEqual(await store.secret(), oldProvider);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).encryptedKey, Buffer.from('rotated:old-fixture-key').toString('base64'));
  const { apiKey: _key, ...settings } = oldProvider;
  await store.save({ ...settings, mode: 'mock' });
  assert.deepEqual(await store.secret(), { ...settings, mode: 'mock', apiKey: '' });
  assert.equal(decryptions, 2);
  assert.equal(store.public().hasKey, true);
});

test('单次输出上限只接受合理整数，留空不保存', async t => {
  const { store } = fixture(t);
  for (const maxOutputTokens of [0, 999, 200_001, 1500.5, Number.NaN]) {
    await assert.rejects(store.save({ ...oldProvider, maxOutputTokens }), /单次输出上限/);
  }
  await store.save({ ...oldProvider, maxOutputTokens: 64_000 });
  assert.equal((await store.secret()).maxOutputTokens, 64_000);
  await store.save({ ...oldProvider, maxOutputTokens: undefined });
  assert.equal(store.public().maxOutputTokens, undefined);
});

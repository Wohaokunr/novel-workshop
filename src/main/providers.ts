import { safeStorage } from 'electron';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import type { ProviderInput, ProviderSecret, ProviderSettings } from '../shared/types.js';
import { ROLE_LABELS, type AgentRole } from '../shared/agent-types.js';

/** Keeps only roles that name a model; an empty result means every role uses the main model. */
function normalizeRoleModels(input: ProviderInput['roleModels']): ProviderSettings['roleModels'] {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('角色模型设置无效');
  const entries: Array<[AgentRole, string]> = [];
  for (const [role, model] of Object.entries(input)) {
    if (!Object.hasOwn(ROLE_LABELS, role)) throw new Error(`未知的智能体角色：${role}`);
    if (model !== undefined && typeof model !== 'string') throw new Error(`${ROLE_LABELS[role as AgentRole]}的模型名称无效`);
    if (model?.trim()) entries.push([role as AgentRole, model.trim()]);
  }
  return entries.length ? Object.fromEntries(entries) : undefined;
}
interface StoredProvider extends Omit<ProviderSettings, 'hasKey'> { encryptedKey?: string }
export class ProviderStore {
  private value: StoredProvider;
  constructor(private filename: string) {
    this.value = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) as StoredProvider : {
      name: '我的模型', baseURL: 'https://api.openai.com/v1', model: '', mode: 'mock',
    };
  }
  public(): ProviderSettings {
    const { encryptedKey, ...settings } = this.value;
    return { ...settings, hasKey: Boolean(encryptedKey) };
  }
  async save(input: ProviderInput): Promise<ProviderSettings> {
    const url = new URL(input.baseURL.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含凭据、查询参数的 HTTP/HTTPS API 根路径');
    if (/\/responses\/?$/.test(url.pathname)) throw new Error('Base URL 应填写 API 根路径，例如 https://example.com/v1，不要包含 /responses');
    if (input.mode !== 'live' && input.mode !== 'mock') throw new Error('模型运行模式无效');
    let encryptedKey = this.value.encryptedKey;
    if (input.apiKey?.trim()) encryptedKey = (await safeStorage.encryptStringAsync(input.apiKey.trim())).toString('base64');
    if (input.mode === 'live' && (!input.model.trim() || !encryptedKey)) throw new Error('真实模型需要填写模型名称和 API Key');
    const next: StoredProvider = { name: input.name.trim() || '我的模型', baseURL: url.toString().replace(/\/$/, ''), model: input.model.trim(), mode: input.mode, encryptedKey };
    if (input.reasoningEffort) next.reasoningEffort = input.reasoningEffort;
    if (input.summaryModel?.trim()) next.summaryModel = input.summaryModel.trim();
    if (input.embeddingModel?.trim()) next.embeddingModel = input.embeddingModel.trim();
    const roleModels = normalizeRoleModels(input.roleModels);
    if (roleModels) next.roleModels = roleModels;
    if (input.maxOutputTokens !== undefined && input.maxOutputTokens !== null) {
      if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1000 || input.maxOutputTokens > 200_000) throw new Error('单次输出上限应为 1000–200000 之间的整数');
      next.maxOutputTokens = input.maxOutputTokens;
    }
    if (input.storyMemory !== undefined && input.storyMemory !== 'auto' && input.storyMemory !== 'manual') throw new Error('故事记忆模式无效');
    // Absent means auto; only an explicit choice is persisted.
    const storyMemory = input.storyMemory ?? this.value.storyMemory;
    if (storyMemory) next.storyMemory = storyMemory;
    this.persist(next);
    return this.public();
  }
  async secret(): Promise<ProviderSecret> {
    const snapshot = this.value;
    let apiKey = '';
    if (snapshot.mode === 'live') {
      if (!snapshot.encryptedKey) throw new Error('请先在模型设置中填写 API Key');
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(snapshot.encryptedKey, 'base64'));
      apiKey = decrypted.result;
      if (decrypted.shouldReEncrypt) {
        const encryptedKey = (await safeStorage.encryptStringAsync(apiKey)).toString('base64');
        if (this.value === snapshot) this.persist({ ...snapshot, encryptedKey });
      }
    }
    const { encryptedKey: _key, ...settings } = snapshot;
    return { ...settings, apiKey };
  }
  private persist(value: StoredProvider) {
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
    this.value = value;
  }
}

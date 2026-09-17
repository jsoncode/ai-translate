import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT, MODEL_PRESETS, getActiveModel, makeModel, normalizeConfig, validateModel } from '../src/lib/config';

describe('config', () => {
  it('把不完整配置收敛成合法配置', () => {
    const cfg = normalizeConfig({ targetLang: 'xx', models: [], timeoutMs: 1 });
    expect(cfg.targetLang).toBe('en');
    expect(cfg.models.length).toBeGreaterThan(0);
    expect(cfg.timeoutMs).toBe(5000);
    expect(getActiveModel(cfg)).toBeTruthy();
  });

  it('activeModelId 失效时回落到第一个模型', () => {
    const cfg = normalizeConfig({ models: [makeModel({ id: 'a' }), makeModel({ id: 'b' })], activeModelId: 'zzz' });
    expect(cfg.activeModelId).toBe('a');
  });

  it('保留已有模型字段并夹紧 temperature', () => {
    const cfg = normalizeConfig({
      models: [makeModel({ id: 'x', name: 'X', baseUrl: 'https://a/v1', model: 'm', apiKey: 'k', temperature: 9 })],
      activeModelId: 'x',
    });
    expect(cfg.models[0].name).toBe('X');
    expect(cfg.models[0].temperature).toBe(2);
    expect(cfg.activeModelId).toBe('x');
  });

  it('校验能指出缺失项', () => {
    expect(validateModel(makeModel({ name: 'x' }))).toEqual(['缺少 Base URL', '缺少模型名', '缺少 API Key']);
    expect(validateModel(makeModel({ baseUrl: 'https://a/v1', model: 'm', apiKey: 'k' }))).toEqual([]);
    expect(validateModel(undefined)).toEqual(['未选择模型']);
  });

  it('提示词包含 [index] 协议约定（引擎依赖它解析流式返回）', () => {
    expect(DEFAULT_PROMPT).toContain('[0]');
    expect(DEFAULT_PROMPT).toContain('索引');
  });

  it('预设模型都带 baseUrl/model', () => {
    for (const p of MODEL_PRESETS.filter((x) => x.key !== 'custom')) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.model.length).toBeGreaterThan(0);
    }
  });
});

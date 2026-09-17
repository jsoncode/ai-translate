import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/lib/theme';
import { normalizeConfig } from '../src/lib/config';

describe('theme', () => {
  it('手动指定时忽略系统偏好', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('跟随系统时用系统偏好', () => {
    expect(resolveTheme('system', 'light')).toBe('light');
    expect(resolveTheme('system', 'dark')).toBe('dark');
  });

  it('配置里的非法主题回落为跟随系统', () => {
    expect(normalizeConfig({ theme: 'neon' as never }).theme).toBe('system');
    expect(normalizeConfig({ theme: 'dark' }).theme).toBe('dark');
    expect(normalizeConfig(undefined).theme).toBe('system');
  });
});

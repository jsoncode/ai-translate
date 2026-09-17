/**
 * 外观主题的唯一入口。
 *
 * 分工：
 *  - CSS（styles/base.css）用 `:root[data-theme='light'|'dark']` 提供全部设计变量；
 *  - 这里只决定"用哪一套"，并把属性写到 <html> 上；
 *  - antd 的种子色在 components/ThemeRoot.tsx 里同步（antd 无法直接消费 CSS 变量）。
 *
 * 另有一份 localStorage 同步缓存：config 存在 chrome.storage（异步），
 * 若等它回来再上色，深色系统 + 手动浅色时会闪一下深色。
 */
import type { ThemeMode } from './types';

export type ResolvedTheme = 'light' | 'dark';

const CACHE_KEY = 'ai-translate-theme';
const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

type Listener = (mode: ThemeMode) => void;
const listeners = new Set<Listener>();

export function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 纯函数版本，方便单测直接喂值 */
export function resolveTheme(mode: ThemeMode, system: ResolvedTheme = systemTheme()): ResolvedTheme {
  if (mode === 'light' || mode === 'dark') return mode;
  return system;
}

export function cachedThemeMode(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system';
  const raw = localStorage.getItem(CACHE_KEY);
  return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'system';
}

export function cacheThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(CACHE_KEY, mode);
  } catch {
    /* 隐私模式下可能不可写，忽略 */
  }
}

/** 立即上色，返回最终生效的深浅 */
export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
  }
  return resolved;
}

/** 首帧上色：在 React 渲染之前调用，避免先亮后暗的闪烁 */
export function bootstrapTheme(): ResolvedTheme {
  return applyTheme(cachedThemeMode());
}

/** 订阅主题模式变化，返回取消订阅函数 */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 预览并缓存主题（设置页里点一下立刻生效，不必等保存） */
export function setThemeMode(mode: ThemeMode): void {
  cacheThemeMode(mode);
  listeners.forEach((listener) => listener(mode));
}

/** 系统深浅变化时回调（仅 mode === 'system' 需要） */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

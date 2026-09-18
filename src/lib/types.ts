/** 插件配置与引擎的类型定义 */

export interface ModelConfig {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  /** 自定义系统提示词；留空使用内置的 [index] 协议提示词 */
  systemPrompt: string;
}

/** 外观主题：跟随系统 / 强制浅色 / 强制深色 */
export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppConfig {
  enabled: boolean;
  targetLang: string;
  autoRun: boolean;
  debug: boolean;
  timeoutMs: number;
  activeModelId: string;
  models: ModelConfig[];
  theme: ThemeMode;
}

export interface LangOption {
  value: string;
  label: string;
}

export interface ModelPreset {
  key: string;
  name: string;
  baseUrl: string;
  model: string;
}

/** 引擎在页面上暴露的状态 */
export type { EngineApi, EngineConfig, EngineStatus, TranslateHandlers, TranslateTransport } from '../engine/types';

/** background <-> content 的长连接消息 */
export type PortRequest =
  | { type: 'translate'; reqId: number; text: string; targetLang: string; modelId: string; timeoutMs: number }
  | { type: 'abort'; reqId: number };

export type PortResponse =
  | ({ type: 'chunk'; reqId: number; delta: string })
  | ({ type: 'done'; reqId: number })
  | ({ type: 'error'; reqId: number; message: string });

/** 端口回包的载荷（不含 reqId，发送时再补） */
export type PortPayload =
  | { type: 'chunk'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** popup / options <-> content 的一次性消息 */
export type TabMessage =
  | { type: 'ai-translate-status' }
  | { type: 'ai-translate-run' }
  | { type: 'ai-translate-stop' }
  | { type: 'ai-translate-rescan' };

/** popup / options <-> background */
export type RuntimeMessage =
  | { type: 'test-model'; model: ModelConfig }
  | { type: 'clear-config-cache' };

declare global {
  interface Window {
    __aiTranslateEngine?: import('../engine/types').EngineApi;
    __aiTranslateContentReady?: boolean;
    /** 引擎在页面上保留的调试入口：aiTranslateHandler.scanPageContent() 等 */
    aiTranslateHandler?: Record<string, unknown>;
  }
}

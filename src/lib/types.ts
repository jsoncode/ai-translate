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

export interface AppConfig {
  enabled: boolean;
  targetLang: string;
  autoRun: boolean;
  debug: boolean;
  timeoutMs: number;
  activeModelId: string;
  models: ModelConfig[];
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
export interface EngineStatus {
  enabled: boolean;
  targetLang: string;
  loading: boolean;
  total: number;
  translated: number;
  route: string;
}

/** 引擎注入给 transport 的配置片段 */
export interface EngineConfig {
  enabled: boolean;
  targetLang: string;
  debug: boolean;
}

export interface TranslateHandlers {
  signal?: AbortSignal;
  targetLang?: string;
  onChunk: (delta: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface TranslateTransport {
  translate: (text: string, handlers: TranslateHandlers) => void;
}

/** 页面上的引擎 API（见 src/engine/ai-translate-engine.js 末尾） */
export interface EngineApi {
  applyConfig: (config: Partial<EngineConfig>) => void;
  setTransport: (transport: TranslateTransport) => void;
  getConfig: () => EngineConfig;
  run: () => void;
  stop: () => void;
  status: () => EngineStatus;
  hasChinese: (text: string) => boolean;
  getLanguage: () => string;
  scanPageContent: () => void;
  scanViewportContent: () => void;
  flashAllText: () => void;
  reverseChinese: () => void;
  state: { debug: boolean; isLoading: boolean };
}

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
    __aiTranslateEngine?: EngineApi;
    __aiTranslateContentReady?: boolean;
  }
}

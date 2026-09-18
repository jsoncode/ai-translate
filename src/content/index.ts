/**
 * Content script：把插件配置 + 模型传输层接到引擎上，并响应 popup 的开关/状态查询。
 * 引擎（engine/ai-translate-engine.js）在同一 bundle 里先执行，负责 DOM 扫描/回显/回滚。
 */
import '../engine/index';
import { loadConfig } from '../lib/config';
import { onConfigChanged } from '../lib/storage';
import type { AppConfig, EngineApi, PortRequest, PortResponse, TabMessage, TranslateHandlers } from '../lib/types';

const Engine: EngineApi | undefined = window.__aiTranslateEngine;

if (!Engine) {
  console.warn('[AI Translate] 引擎未加载，跳过初始化');
} else if (window.__aiTranslateContentReady) {
  // 重复注入（popup 按需注入 + manifest 声明）时只初始化一次
} else {
  window.__aiTranslateContentReady = true;
  bootstrap(Engine);
}

function bootstrap(engine: EngineApi): void {
  let port: chrome.runtime.Port | null = null;
  let reqSeq = 0;
  const pending = new Map<number, TranslateHandlers>();

  function ensurePort(): chrome.runtime.Port {
    if (port) return port;
    const next = chrome.runtime.connect({ name: 'ai-translate' });
    next.onMessage.addListener((raw: unknown) => {
      const msg = raw as PortResponse;
      const handlers = pending.get(msg?.reqId);
      if (!handlers) return;
      if (msg.type === 'chunk') {
        handlers.onChunk(msg.delta);
      } else if (msg.type === 'done') {
        pending.delete(msg.reqId);
        handlers.onDone();
      } else if (msg.type === 'error') {
        pending.delete(msg.reqId);
        handlers.onError(msg.message);
      }
    });
    next.onDisconnect.addListener(() => {
      const list = [...pending.values()];
      pending.clear();
      port = null;
      list.forEach((h) => h.onError('port disconnected'));
    });
    port = next;
    return next;
  }

  /** 引擎调用的传输层：一次批量文案 -> background -> 模型 -> 流式增量 */
  const transport = {
    translate(text: string, handlers: TranslateHandlers): void {
      const activePort = ensurePort();
      const reqId = ++reqSeq;
      pending.set(reqId, handlers);

      const onAbort = (): void => {
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        try {
          activePort.postMessage({ type: 'abort', reqId } satisfies PortRequest);
        } catch {
          /* ignore */
        }
        handlers.onError('aborted');
      };

      if (handlers.signal) {
        if (handlers.signal.aborted) {
          onAbort();
          return;
        }
        handlers.signal.addEventListener('abort', onAbort);
      }

      void loadConfig()
        .then((cfg) => {
          activePort.postMessage({
            type: 'translate',
            reqId,
            text,
            targetLang: cfg.targetLang,
            modelId: cfg.activeModelId,
            timeoutMs: cfg.timeoutMs,
          } satisfies PortRequest);
        })
        .catch((err: unknown) => {
          pending.delete(reqId);
          handlers.onError(String(err instanceof Error ? err.message : err));
        });
    },
  };

  engine.setTransport(transport);

  function applyConfig(cfg: AppConfig): void {
    engine.applyConfig({
      enabled: Boolean(cfg.enabled) && cfg.targetLang !== 'zh',
      targetLang: cfg.targetLang || 'en',
      debug: Boolean(cfg.debug),
    });
    engine.state.debug = Boolean(cfg.debug);
  }

  function startOrStop(cfg: AppConfig): void {
    applyConfig(cfg);
    // run() 内部按当前语言决定：非中文 -> 扫描翻译；中文/关闭 -> 回滚中文
    engine.run();
  }

  void loadConfig().then((cfg) => {
    applyConfig(cfg);
    if (cfg.enabled && cfg.autoRun && cfg.targetLang !== 'zh') {
      engine.run();
    }
  });

  onConfigChanged((next) => {
    void loadConfig().then(() => {
      startOrStop(next as AppConfig);
    });
  });

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: unknown) => void) => {
    const msg = raw as TabMessage;
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'ai-translate-status') {
      sendResponse({ ok: true, present: true, ...engine.status() });
      return false;
    }
    if (msg.type === 'ai-translate-run' || msg.type === 'ai-translate-stop') {
      void loadConfig().then((cfg) => {
        startOrStop({ ...cfg, enabled: msg.type === 'ai-translate-run' });
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === 'ai-translate-rescan') {
      engine.scanPageContent();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

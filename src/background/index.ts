/**
 * Service worker：负责所有模型请求（API Key 只在这里使用，不进入页面上下文），
 * 并把流式增量通过长连接端口回传给 content script。
 */
import { getActiveModel, loadConfig, validateModel } from '../lib/config';
import { buildMessages, streamChat, testConnection } from '../lib/model-client';
import type { ModelConfig, PortPayload, PortRequest, PortResponse } from '../lib/types';

let debugEnabled = false;
function log(...args: unknown[]): void {
  if (debugEnabled) console.log('[AI Translate BG]', ...args);
}

void loadConfig().then((cfg) => {
  debugEnabled = cfg.debug;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  debugEnabled = Boolean((changes.config.newValue as { debug?: boolean } | undefined)?.debug);
});

interface Inflight {
  controller: AbortController;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ai-translate') return;
  const inflight = new Map<number, Inflight>();

  port.onDisconnect.addListener(() => {
    for (const entry of inflight.values()) {
      try {
        entry.controller.abort();
      } catch {
        /* ignore */
      }
    }
    inflight.clear();
  });

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as PortRequest;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'abort') {
      const entry = inflight.get(msg.reqId);
      if (entry) {
        try {
          entry.controller.abort();
        } catch {
          /* ignore */
        }
        inflight.delete(msg.reqId);
      }
      return;
    }

    if (msg.type === 'translate') {
      void handleTranslate(port, inflight, msg);
    }
  });
});

async function handleTranslate(
  port: chrome.runtime.Port,
  inflight: Map<number, Inflight>,
  msg: Extract<PortRequest, { type: 'translate' }>,
): Promise<void> {
  const { reqId } = msg;
  const controller = new AbortController();
  inflight.set(reqId, { controller });

  const post = (payload: PortPayload): void => {
    try {
      port.postMessage({ ...payload, reqId } as PortResponse);
    } catch {
      /* 端口已关闭 */
    }
  };

  const timeoutTimer = setTimeout(
    () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    },
    Math.max(5000, Number(msg.timeoutMs) || 60000),
  );

  try {
    const cfg = await loadConfig();
    let model: ModelConfig | undefined = getActiveModel(cfg);
    if (msg.modelId) {
      const picked = cfg.models.find((m) => m.id === msg.modelId);
      if (picked) model = picked;
    }
    const problems = validateModel(model);
    if (!model || problems.length) {
      throw new Error(`模型配置不完整：${problems.join('、') || '未选择模型'}`);
    }

    log('translate', reqId, 'items=', String(msg.text ?? '').split('\n').length, 'model=', model.model);
    const messages = buildMessages(model, msg.text, msg.targetLang || cfg.targetLang);
    await streamChat(model, messages, {
      signal: controller.signal,
      onDelta: (delta) => post({ type: 'chunk', delta }),
    });
    post({ type: 'done' });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
    log('error', reqId, err instanceof Error ? err.message : err);
    post({ type: 'error', message: aborted ? 'aborted' : String(err instanceof Error ? err.message : err) });
  } finally {
    clearTimeout(timeoutTimer);
    inflight.delete(reqId);
  }
}

/** popup / options 的轻量请求：测试模型连通性 */
chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: unknown) => void) => {
  const msg = raw as { type?: string; model?: ModelConfig };
  if (!msg || typeof msg !== 'object' || msg.type !== 'test-model') return false;
  const model = msg.model;
  void (async () => {
    try {
      const problems = validateModel(model);
      if (problems.length) throw new Error(`配置不完整：${problems.join('、')}`);
      const reply = await testConnection(model as ModelConfig);
      sendResponse({ ok: true, reply });
    } catch (err) {
      sendResponse({ ok: false, error: String(err instanceof Error ? err.message : err) });
    }
  })();
  return true; // 异步响应
});

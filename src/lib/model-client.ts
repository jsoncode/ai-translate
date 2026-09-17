/**
 * 模型直连客户端（OpenAI 兼容 /chat/completions，流式）。
 * 只在 service worker 里运行：API Key 不进入页面上下文。
 */
import { DEFAULT_PROMPT, LANG_NAME } from './config';
import type { ModelConfig } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

/** 把 baseUrl 与 path 拼成完整地址（baseUrl 可带或不带 /v1，也可不带协议） */
export function joinUrl(baseUrl: string, path: string): string {
  let base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Base URL 为空');
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base + path;
}

/** 组装发给模型的消息 */
export function buildMessages(model: ModelConfig, text: string, targetLang: string): ChatMessage[] {
  const langName = LANG_NAME[targetLang] ?? targetLang ?? '英语';
  const system = String(model.systemPrompt ?? '').trim() || DEFAULT_PROMPT;
  return [
    { role: 'system', content: `${system}\n目标语言：${langName}。` },
    { role: 'user', content: String(text ?? '') },
  ];
}

/** 解析一行 SSE：返回增量文本 / '__DONE__' / null（无关行） */
export function parseSseLine(line: string): string | null {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(':')) return null; // 注释 / 心跳
  if (!trimmed.startsWith('data:')) return null; // event: 之类忽略
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return '__DONE__';
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const choice = json?.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta ?? choice.message ?? {};
  if (typeof delta.content === 'string' && delta.content) return delta.content;
  if (typeof choice.text === 'string' && choice.text) return choice.text;
  return null;
}

/** 从"整段 SSE 文本"里抽取全部增量（不支持流式的兜底路径） */
export function extractFromSseText(text: string): string {
  if (!String(text ?? '').includes('data:')) return '';
  let out = '';
  for (const line of String(text).split('\n')) {
    const delta = parseSseLine(line);
    if (delta && delta !== '__DONE__') out += delta;
  }
  return out;
}

/**
 * 流式请求，返回完整文本。
 * 会把模型输出原样交给 onDelta（不再包 SSE），调用方直接喂给翻译引擎的流式解析。
 */
export async function streamChat(model: ModelConfig, messages: ChatMessage[], opts: StreamOptions = {}): Promise<string> {
  const res = await fetch(joinUrl(model.baseUrl, '/chat/completions'), {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(model.apiKey ?? '').trim()}`,
    },
    body: JSON.stringify({
      model: String(model.model ?? '').trim(),
      stream: true,
      temperature: typeof model.temperature === 'number' ? model.temperature : 0.2,
      messages,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    throw new Error(`模型接口返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    // 某些代理不支持流式：退化成一次性读取
    const text = await res.text();
    const fromSse = extractFromSseText(text);
    if (fromSse) return fromSse;
    const data = JSON.parse(text);
    const content: string = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (opts.onDelta && content) opts.onDelta(content);
    return content;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  const consume = (line: string) => {
    const delta = parseSseLine(line);
    if (!delta || delta === '__DONE__') return;
    full += delta;
    opts.onDelta?.(delta);
  };

  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      consume(buffer.slice(0, idx).replace(/\r$/, ''));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.trim()) consume(buffer.trim());
  return full;
}

/** 测试连通性：非流式的极短请求 */
export async function testConnection(model: ModelConfig): Promise<string> {
  const res = await fetch(joinUrl(model.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(model.apiKey ?? '').trim()}`,
    },
    body: JSON.stringify({
      model: String(model.model ?? '').trim(),
      stream: false,
      temperature: 0,
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
  let content = '';
  try {
    const data = JSON.parse(text);
    content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
  } catch {
    content = extractFromSseText(text);
  }
  return String(content).trim();
}

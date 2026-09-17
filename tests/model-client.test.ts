import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../src/lib/types';
import { buildMessages, extractFromSseText, joinUrl, parseSseLine, streamChat, testConnection } from '../src/lib/model-client';

const model: ModelConfig = {
  id: 'm1',
  name: 'test',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'sk-test',
  temperature: 0.1,
  systemPrompt: '',
};

/** 把若干 SSE 行包成 Response 形状（带可读流） */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = lines.map((l) => encoder.encode(l + '\n'));
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () =>
          i < chunks.length
            ? Promise.resolve({ done: false, value: chunks[i++] })
            : Promise.resolve({ done: true, value: undefined }),
      }),
    },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('joinUrl', () => {
  it('去掉尾部斜杠并拼接路径', () => {
    expect(joinUrl('https://a.com/v1/', '/chat/completions')).toBe('https://a.com/v1/chat/completions');
  });
  it('缺协议时补 https', () => {
    expect(joinUrl('api.a.com/v1', '/chat/completions')).toBe('https://api.a.com/v1/chat/completions');
  });
  it('空 baseUrl 抛错', () => {
    expect(() => joinUrl('', '/x')).toThrow('Base URL 为空');
  });
});

describe('buildMessages', () => {
  it('带上目标语言与 [index] 协议提示词', () => {
    const messages = buildMessages(model, '[0]你好', 'en');
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('[0]');
    expect(messages[0].content).toContain('英语');
    expect(messages[1]).toEqual({ role: 'user', content: '[0]你好' });
  });
  it('自定义提示词优先', () => {
    const messages = buildMessages({ ...model, systemPrompt: '只输出译文' }, 'x', 'ja');
    expect(messages[0].content).toContain('只输出译文');
    expect(messages[0].content).toContain('日语');
  });
});

describe('parseSseLine', () => {
  it('解析出增量', () => {
    expect(parseSseLine('data: {"choices":[{"delta":{"content":"Hello"}}]}')).toBe('Hello');
  });
  it('忽略空行/注释/event 行', () => {
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine(': keep-alive')).toBeNull();
    expect(parseSseLine('event: translation')).toBeNull();
  });
  it('[DONE] 标记', () => {
    expect(parseSseLine('data: [DONE]')).toBe('__DONE__');
  });
  it('推理模型的 reasoning_content 不会污染译文', () => {
    expect(parseSseLine('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}')).toBeNull();
  });
  it('usage 收尾行忽略', () => {
    expect(parseSseLine('data: {"choices":[],"usage":{"total_tokens":10}}')).toBeNull();
  });
});

describe('extractFromSseText', () => {
  it('从整段 SSE 文本拼出内容', () => {
    const text = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]';
    expect(extractFromSseText(text)).toBe('AB');
  });
  it('非 SSE 文本返回空串', () => {
    expect(extractFromSseText('plain')).toBe('');
  });
});

describe('streamChat', () => {
  it('流式拼装完整文本，onDelta 与最终结果一致', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
      const body = JSON.parse(String(init.body));
      expect(body.stream).toBe(true);
      expect(body.model).toBe('test-model');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"[0]Hello"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"\\n[1]World"}}]}',
        'data: [DONE]',
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const full = await streamChat(model, buildMessages(model, '[0]你好\n[1]世界', 'en'), {
      onDelta: (d) => deltas.push(d),
    });
    expect(full).toBe('[0]Hello\n[1]World');
    expect(deltas.join('')).toBe(full);
  });

  it('HTTP 错误抛出状态码与响应体', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid api key' })),
    );
    await expect(streamChat(model, [], {})).rejects.toThrow(/401.*invalid api key/s);
  });

  it('不支持流式的接口走一次性兜底', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: null,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'plain reply' } }] }),
      })),
    );
    await expect(streamChat(model, [], {})).resolves.toBe('plain reply');
  });

  it('abort 时抛出 AbortError（引擎据此走"被中断"分支，不计入失败重试）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }),
    );
    await expect(streamChat(model, [], {})).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('testConnection', () => {
  it('返回模型回复', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      })),
    );
    await expect(testConnection(model)).resolves.toBe('ok');
  });

  it('失败时带出错误信息', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    await expect(testConnection(model)).rejects.toThrow(/500.*boom/s);
  });
});

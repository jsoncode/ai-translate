/**
 * 端到端冒烟测试：把【构建产物】dist/content.js 放进 jsdom 跑起来，
 * 用假的 chrome API + 假模型验证：配置 -> 整页翻译 -> 关闭开关回滚中文。
 *
 *   npm run build && npm run test:smoke        （加 --verbose 可看页面控制台日志）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'dist/content.js');

if (!fs.existsSync(CONTENT)) {
  console.error('缺少构建产物 dist/content.js，请先执行：npm run build');
  process.exit(2);
}

const { JSDOM, VirtualConsole } = await import('jsdom');
const VERBOSE = process.argv.includes('--verbose');

/** 假模型的词表（含"片段型复合块"场景） */
const DICT = {
  商品类型: 'Product Type',
  肺炎疫苗: 'Pneumonia Vaccine',
  带状疱疹疫苗: 'Shingles Vaccine',
  营业时间: 'Business Hours',
  疫苗: 'Vaccine',
  你好: 'Hello',
};

const PAGE = [
  '<div class="page">',
  '  <div class="t">你好</div>',
  '  <div class="coupon-title">商品类型</div>',
  '  <div class="coupon-select">',
  '    <div class="coupon-select-item selected"><img src="https://x/y.png" alt="">疫苗</div>',
  '    <div class="coupon-select-item">肺炎疫苗</div>',
  '    <div class="coupon-select-item">带状疱疹疫苗</div>',
  '  </div>',
  '  <div class="timeText"><span class="openTime">营业时间</span>&nbsp;&nbsp;9:00-16:30&nbsp;&nbsp;</div>',
  '</div>',
].join('\n');

const TEXTS = (win) => ({
  plain: win.document.querySelector('.t').textContent.trim(),
  items: [...win.document.querySelectorAll('.coupon-select-item')].map((e) => e.textContent.trim()),
  compositeHtml: win.document.querySelector('.coupon-select-item').innerHTML.trim(),
  time: win.document.querySelector('.timeText').textContent.replace(/\u00a0/g, '·').trim(),
});

/** 假 background：收到 translate 就把 [index]译文 分片回传（纯文本，与真实 background 一致） */
function makeChrome(win, store) {
  const listeners = [];
  const port = {
    _aborted: new Set(),
    _listener: null,
    onMessage: { addListener: (fn) => { port._listener = fn; } },
    onDisconnect: { addListener: () => {} },
    postMessage(msg) {
      if (msg?.type === 'abort') {
        port._aborted.add(msg.reqId);
        return;
      }
      if (msg?.type !== 'translate') return;
      const pairs = String(msg.text)
        .split('\n')
        .map((l) => l.match(/^\[(\d+)\]([\s\S]*)$/))
        .filter(Boolean);
      const body = pairs.map((m) => `[${m[1]}]${DICT[m[2]] ?? '?' + m[2]}`).join('\n') + '\n';
      const chunks = [];
      for (let p = 0; p < body.length; p += 9) chunks.push(body.slice(p, p + 9));
      let i = 0;
      const pump = () => {
        if (port._aborted.has(msg.reqId)) return;
        if (i < chunks.length) {
          port._listener({ type: 'chunk', reqId: msg.reqId, delta: chunks[i++] });
          setTimeout(pump, 1);
        } else {
          port._listener({ type: 'done', reqId: msg.reqId });
        }
      };
      setTimeout(pump, 5);
    },
  };

  win.chrome = {
    storage: {
      local: {
        // 兼容两种用法：MV3 的 Promise API 与旧的 callback 形式
        get: (_key, cb) => {
          const result = { config: store.config };
          if (typeof cb === 'function') {
            cb(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set: (obj, cb) => {
          const oldValue = store.config;
          store.config = obj.config;
          listeners.forEach((fn) => fn({ config: { newValue: obj.config, oldValue } }, 'local'));
          if (typeof cb === 'function') {
            cb();
            return undefined;
          }
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      connect: () => port,
      onMessage: { addListener: () => {} },
      lastError: null,
    },
  };
  return port;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  config: {
    enabled: false,
    targetLang: 'en',
    autoRun: false,
    debug: VERBOSE,
    timeoutMs: 60000,
    activeModelId: 'm1',
    models: [{ id: 'm1', name: 'fake', baseUrl: 'https://api.example.com/v1', model: 'fake', apiKey: 'sk-x', temperature: 0.2 }],
  },
};

const vc = new VirtualConsole();
if (VERBOSE) {
  vc.on('log', (...a) => console.log('   [page]', ...a));
  vc.on('warn', (...a) => console.log('   [page.warn]', ...a));
}
vc.on('jsdomError', (e) => console.log('   [jsdomError]', e.message));

const dom = new JSDOM(`<!doctype html><html><head><title>Shop</title></head><body>${PAGE}</body></html>`, {
  url: 'https://shop.example.com/list',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
window.ReadableStream = globalThis.ReadableStream;
window.TextEncoder = globalThis.TextEncoder;
window.TextDecoder = globalThis.TextDecoder;

// jsdom 没有布局：给所有元素一个固定可视矩形，让"可视区判定"成立
const RECT = { top: 10, left: 10, right: 300, bottom: 40, width: 290, height: 30, x: 10, y: 10 };
window.Element.prototype.getBoundingClientRect = function () { return { ...RECT }; };
window.Element.prototype.getClientRects = function () {
  const r = { ...RECT };
  const arr = [r];
  arr.item = (i) => arr[i];
  return arr;
};

makeChrome(window, store);

// 加载构建产物（引擎与 content 已打包在同一个内容脚本里）
const script = window.document.createElement('script');
script.textContent = fs.readFileSync(CONTENT, 'utf8');
window.document.body.appendChild(script);
await sleep(200);

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? `   [${detail}]` : ''));
  if (!ok) failed += 1;
};

check('关闭时页面保持中文', TEXTS(window).items[1] === '肺炎疫苗', JSON.stringify(TEXTS(window).items));

store.config = { ...store.config, enabled: true };
await window.chrome.storage.local.set({ config: store.config });
await sleep(2000);
const en = TEXTS(window);
check('打开后普通文案翻译', en.plain === 'Hello', en.plain);
check('复合块列表翻译', en.items[1] === 'Pneumonia Vaccine' && en.items[2] === 'Shingles Vaccine', JSON.stringify(en.items));
check('复合块保留 <img>', /^<img[^>]*>Vaccine$/.test(en.compositeHtml), en.compositeHtml);
check('片段型复合块：span 翻译、时间未被覆盖', en.time === 'Business Hours··9:00-16:30··', en.time);

store.config = { ...store.config, enabled: false };
await window.chrome.storage.local.set({ config: store.config });
await sleep(1800);
const zh = TEXTS(window);
check('关闭后回滚中文', zh.plain === '你好' && zh.items[1] === '肺炎疫苗' && zh.items[2] === '带状疱疹疫苗', JSON.stringify(zh));
check('关闭后片段型复合块也回滚、时间保持', zh.time === '营业时间··9:00-16:30··', zh.time);

const status = window.__aiTranslateEngine?.status();
check('引擎状态可用', !!status && typeof status.total === 'number', JSON.stringify(status));

console.log('\n' + (failed ? `${failed} FAILED of 8` : 'ALL 8 CHECKS PASSED'));
process.exit(failed ? 1 : 0);

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Select, Switch, Tooltip } from 'antd';
import { ArrowRightOutlined, ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import Mark from '../components/Mark';
import { LANG_OPTIONS, getActiveModel, loadConfig, patchConfig, validateModel } from '../lib/config';
import type { AppConfig, EngineStatus } from '../lib/types';

interface PageStatus extends EngineStatus {
  ok: boolean;
  present?: boolean;
}

interface TabInfo {
  id: number;
  host: string;
}

/** 向当前标签页要状态；content script 不在（安装前已打开的页面）时按需注入一次 */
async function askPage(tabId: number): Promise<PageStatus | null> {
  const send = (): Promise<PageStatus | null> =>
    new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'ai-translate-status' }, (res: PageStatus | undefined) => {
        resolve(chrome.runtime.lastError ? null : (res ?? null));
      });
    });

  const first = await send();
  if (first) return first;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 120));
    return await send();
  } catch {
    return null;
  }
}

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

export default function PopupApp(): React.ReactElement {
  const { message } = App.useApp();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [pending, setPending] = useState<'run' | 'stop' | null>(null);

  const activeModel = useMemo(() => (config ? getActiveModel(config) : undefined), [config]);
  const modelProblems = useMemo(() => (config ? validateModel(activeModel) : []), [config, activeModel]);

  useEffect(() => {
    void (async () => {
      setConfig(await loadConfig());
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (current?.id == null) return;
      let host = '当前标签页';
      try {
        host = new URL(current.url ?? '').hostname || host;
      } catch {
        /* chrome:// 之类的地址没有 hostname */
      }
      setTab({ id: current.id, host });
    })();
  }, []);

  // 轮询：翻译中 0.7s，空闲 2.5s —— 状态跟手，又不至于一直唤醒后台
  useEffect(() => {
    if (!tab) return;
    let alive = true;
    let timer = 0;
    const tick = async (): Promise<void> => {
      const next = await askPage(tab.id);
      if (!alive) return;
      setStatus(next);
      timer = window.setTimeout(() => void tick(), next?.loading ? 700 : 2500);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [tab]);

  const save = useCallback(
    async (partial: Partial<AppConfig>): Promise<AppConfig | null> => {
      const next = await patchConfig(partial);
      setConfig(next);
      return next;
    },
    [],
  );

  const run = useCallback(async (): Promise<void> => {
    if (!tab || modelProblems.length) return;
    setPending('run');
    await save({ enabled: true });
    // askPage 顺带按需注入 content script，装插件之前就打开的页面也能立刻翻译
    const alive = await askPage(tab.id);
    setStatus(alive);
    if (!alive) {
      message.warning('当前页面无法注入翻译脚本');
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: 'ai-translate-run' }, () => void chrome.runtime.lastError);
    }
    setPending(null);
  }, [tab, modelProblems.length, save, message]);

  const stop = useCallback(async (): Promise<void> => {
    if (!tab) return;
    setPending('stop');
    await save({ enabled: false });
    await chrome.tabs.sendMessage(tab.id, { type: 'ai-translate-stop' }, () => void chrome.runtime.lastError);
    setPending(null);
    setStatus(await askPage(tab.id));
  }, [tab, save]);

  const rescan = useCallback(async (): Promise<void> => {
    if (!tab) return;
    await chrome.tabs.sendMessage(tab.id, { type: 'ai-translate-rescan' }, () => void chrome.runtime.lastError);
    message.success('已重新扫描页面');
  }, [tab, message]);

  // 键盘：Ctrl/Cmd + Enter 直接翻译
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  if (!config) {
    return (
      <div className="popup">
        <div className="popup-loading">
          <div className="skeleton" style={{ height: 26, width: 150 }} />
          <div className="skeleton" style={{ height: 62 }} />
          <div className="skeleton" style={{ height: 38 }} />
          <div className="skeleton" style={{ height: 96 }} />
        </div>
      </div>
    );
  }

  const on = config.enabled && config.targetLang !== 'zh';
  const translated = status?.translated ?? 0;
  const total = status?.total ?? 0;
  const loading = Boolean(status?.loading);
  const pct = total > 0 ? Math.min(100, Math.round((translated / total) * 100)) : 0;
  const blocked = modelProblems.length > 0;

  const phase = ((): { label: string; dot: string; pill: string } => {
    if (!tab) return { label: '不可用', dot: '', pill: '' };
    if (!status) return { label: '此页不支持', dot: '', pill: '' };
    if (blocked) return { label: '待配置模型', dot: 'is-warn', pill: 'is-warn' };
    if (config.targetLang === 'zh') return { label: '保持原文', dot: '', pill: '' };
    if (!config.enabled) return { label: '已关闭', dot: '', pill: '' };
    if (loading) return { label: '翻译中', dot: 'is-busy', pill: 'is-accent' };
    if (translated > 0) return { label: '已完成', dot: 'is-on', pill: 'is-accent' };
    return { label: '已开启', dot: 'is-on', pill: 'is-accent' };
  })();

  const progressText = loading ? '正在翻译' : translated > 0 ? '已翻译' : '待翻译';
  // 还没扫到内容时用不定态进度条，避免"0/0"看着像卡死
  const indeterminate = loading && total === 0;
  const hint = ((): string | null => {
    if (!tab) return '当前标签页不可用，请在普通网页上使用。';
    if (!status) return '此页面不允许注入脚本（例如浏览器内置页、扩展商店页）。';
    if (blocked) return `模型配置不完整：${modelProblems.join('、')}。`;
    if (config.targetLang === 'zh') return '目标语言为「中文」时不翻译，换一个语言即可开启。';
    return null;
  })();

  return (
    <div className="popup">
      <header className="topbar tex-grid">
        <div className="brand">
          <Mark size={26} />
          <div className="brand-text">
            <div className="brand-name">AI 网页翻译</div>
            <div className="brand-host mono truncate">{tab?.host ?? '正在读取当前页面…'}</div>
          </div>
        </div>
        <Tooltip title="模型与设置">
          <button type="button" className="icon-btn" aria-label="打开设置" onClick={openOptions}>
            <SettingOutlined />
          </button>
        </Tooltip>
      </header>

      <section className="block hero">
        <div className="hero-head">
          <span className="micro">本页翻译</span>
          <span className={`pill ${phase.pill}`}>
            <i className={`dot ${phase.dot}`} />
            {phase.label}
          </span>
        </div>

        <div className="hero-actions">
          <Button
            type={on ? 'default' : 'primary'}
            size="large"
            className="btn-main"
            disabled={!tab || blocked || config.targetLang === 'zh'}
            loading={pending !== null}
            onClick={() => void (on && !blocked ? stop() : run())}
          >
            {on && !blocked ? '关闭并还原' : '翻译此页'}
          </Button>
          {on && !blocked && (
            <Tooltip title="重新扫描页面并翻译新增内容">
              <Button size="large" icon={<ReloadOutlined />} aria-label="重新翻译" onClick={() => void rescan()} />
            </Tooltip>
          )}
        </div>

        {on && !blocked && (
          <div className="hero-progress">
            <div className="track">
              <div
                className={`track-fill ${indeterminate ? 'is-indeterminate' : ''}`}
                style={{ width: indeterminate ? undefined : `${pct}%` }}
              />
            </div>
            <div className="hero-progress-meta">
              <span className="num">
                {progressText} <b>{translated}</b>
                <span className="dim"> / {total || '—'} 段</span>
              </span>
              <span className="micro">{total > 0 ? `${pct}%` : '扫描中'}</span>
            </div>
          </div>
        )}

        {hint && (
          <div className={`callout ${blocked ? '' : 'is-accent'}`}>
            <div className="callout-head">
              <span className="callout-title">{blocked ? '需要先配置模型' : '提示'}</span>
              {blocked && (
                <Button size="small" type="text" className="callout-action" onClick={openOptions}>
                  去设置
                </Button>
              )}
            </div>
            <div className="callout-text">{hint}</div>
          </div>
        )}
      </section>

      <section className="block">
        <span className="micro">翻译方向</span>
        <div className="lang-field">
          <span className="lang-src mono">自动检测</span>
          <ArrowRightOutlined className="lang-arrow" />
          <Select
            variant="borderless"
            value={config.targetLang}
            options={LANG_OPTIONS}
            popupMatchSelectWidth={false}
            className="lang-select"
            onChange={(value) => void save({ targetLang: value })}
          />
        </div>
      </section>

      <section className="block">
        <div className="row">
          <div className="row-text">
            <div className="row-title">使用模型</div>
            <div className="row-desc mono truncate">
              {activeModel?.model || '未填写模型名'}
              <span className="dim"> · {activeModel?.baseUrl || '未填写 Base URL'}</span>
            </div>
          </div>
          <div className="row-control">
            <Select
              value={config.activeModelId}
              style={{ width: 158 }}
              options={config.models.map((m) => ({
                value: m.id,
                label: `${m.name || m.model || '未命名'}${validateModel(m).length ? '（未配置）' : ''}`,
              }))}
              onChange={(value) => void save({ activeModelId: value })}
            />
          </div>
        </div>

        <div className="row">
          <div className="row-text">
            <div className="row-title">打开页面自动翻译</div>
            <div className="row-desc">仅对之后打开的页面生效</div>
          </div>
          <div className="row-control">
            <Switch checked={config.autoRun} onChange={(v) => void save({ autoRun: v })} />
          </div>
        </div>

        <div className="row">
          <div className="row-text">
            <div className="row-title">控制台调试日志</div>
            <div className="row-desc">排查翻译异常时打开</div>
          </div>
          <div className="row-control">
            <Switch checked={config.debug} onChange={(v) => void save({ debug: v })} />
          </div>
        </div>
      </section>

      <footer className="footbar">
        <Button type="text" size="small" icon={<SettingOutlined />} className="foot-btn" onClick={openOptions}>
          模型与设置
        </Button>
        <span className="dim foot-hint">
          <span className="kbd">Ctrl</span>
          <span className="kbd">↵</span>
          <span className="foot-hint-text">翻译</span>
        </span>
      </footer>
    </div>
  );
}

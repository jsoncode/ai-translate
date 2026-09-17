import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Input, InputNumber, Popconfirm, Segmented, Select, Switch, Tooltip } from 'antd';
import {
  DeleteOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SaveOutlined,
  StarFilled,
  UndoOutlined,
  DownOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
} from '@ant-design/icons';
import Mark from '../components/Mark';
import {
  DEFAULT_CONFIG,
  LANG_OPTIONS,
  MODEL_PRESETS,
  THEME_OPTIONS,
  getActiveModel,
  loadConfig,
  makeModel,
  normalizeConfig,
  saveConfig,
  validateModel,
} from '../lib/config';
import { setThemeMode } from '../lib/theme';
import type { AppConfig, ModelConfig, ThemeMode } from '../lib/types';

const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型' },
  { id: 'about', label: '关于' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** 只显示域名，Base URL 太长会把行撑爆 */
function hostOf(baseUrl: string): string {
  const raw = String(baseUrl ?? '').trim();
  if (!raw) return '未填写地址';
  try {
    return new URL(raw).host || raw;
  } catch {
    return raw;
  }
}

export default function OptionsApp(): React.ReactElement {
  const { message } = App.useApp();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preset, setPreset] = useState(MODEL_PRESETS[0].key);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [section, setSection] = useState<SectionId>('general');

  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    void loadConfig().then((cfg) => {
      setConfig(cfg);
      setOpenId(getActiveModel(cfg)?.id ?? cfg.models[0]?.id ?? null);
    });
  }, []);

  // 左栏高亮：以「滚过顶部一条线」的最后一个分区为准
  useEffect(() => {
    if (!config) return;
    const onScroll = (): void => {
      let current: SectionId = SECTIONS[0].id;
      for (const item of SECTIONS) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= 100) current = item.id;
      }
      setSection(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [config]);

  function update(patch: Partial<AppConfig>): void {
    if (!config) return;
    setConfig({ ...config, ...patch });
    setDirty(true);
  }

  function updateModel(id: string, patch: Partial<ModelConfig>): void {
    if (!config) return;
    update({ models: config.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  const save = useCallback(async (): Promise<void> => {
    if (!config) return;
    setSaving(true);
    const next = await saveConfig(config);
    setConfig(next);
    setDirty(false);
    setSaving(false);
    message.success('设置已保存');
  }, [config, message]);

  // 有未保存改动时提示一下，避免关掉页面才发现丢了
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  // Ctrl/Cmd + S 保存
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  async function test(model: ModelConfig): Promise<void> {
    setTesting(model.id);
    const res = await new Promise<{ ok?: boolean; reply?: string; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'test-model', model }, (r) => {
        resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : (r ?? {}));
      });
    });
    setTesting(null);
    setTestResult((prev) => ({
      ...prev,
      [model.id]: res.ok
        ? { ok: true, text: `连接正常，模型回复：${res.reply || '(空)'}` }
        : { ok: false, text: `失败：${res.error || '未知错误'}` },
    }));
  }

  function goto(id: SectionId): void {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    setSection(id);
  }

  const models = useMemo(() => config?.models ?? [], [config]);

  if (!config) {
    return (
      <div className="shell">
        <div className="shell-loading">
          <div className="skeleton" style={{ height: 28, width: 220 }} />
          <div className="skeleton" style={{ height: 160 }} />
          <div className="skeleton" style={{ height: 220 }} />
        </div>
      </div>
    );
  }

  const activeModel = getActiveModel(config);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <Mark size={30} />
          <div className="rail-id">
            <div className="rail-name">AI 网页翻译</div>
            <div className="rail-ver mono">v{version}</div>
          </div>
        </div>

        <nav className="rail-nav" aria-label="设置分区">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${section === item.id ? 'is-active' : ''}`}
              onClick={() => goto(item.id)}
            >
              <span className="nav-bar" />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="rail-foot">
          <span className="micro">外观</span>
          <Segmented
            block
            size="small"
            value={config.theme}
            options={THEME_OPTIONS.map((t) => ({
              value: t.value,
              // 左栏宽度有限：跟随系统缩成「系统」，避免被截断
              label: t.value === 'system' ? '系统' : t.label,
            }))}
            onChange={(value) => {
              // 先预览，保存后落库
              setThemeMode(value as ThemeMode);
              update({ theme: value as ThemeMode });
            }}
          />
        </div>
      </aside>

      <main className="content">
        <header className="page-head">
          <h1>设置</h1>
          <p className="muted">
            插件直接调用你配置的模型（OpenAI 兼容接口），不经过任何业务后端。API Key 只保存在本机{' '}
            <code className="mono">chrome.storage.local</code>，且仅由后台在请求模型时使用。
          </p>
        </header>

        <section id="general" className="panel">
          <div className="panel-head">
            <span className="micro">通用</span>
            <h2>翻译行为</h2>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">默认目标语言</div>
              <div className="row-desc">选「中文」时保持原文不翻译</div>
            </div>
            <div className="row-control">
              <Select
                value={config.targetLang}
                options={LANG_OPTIONS}
                style={{ width: 200 }}
                onChange={(v) => update({ targetLang: v })}
              />
            </div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">请求超时</div>
              <div className="row-desc">单批文案等待模型返回的上限，毫秒</div>
            </div>
            <div className="row-control">
              <InputNumber
                min={5000}
                max={600000}
                step={1000}
                value={config.timeoutMs}
                style={{ width: 150 }}
                onChange={(v) => update({ timeoutMs: Number(v) || 60000 })}
              />
            </div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">打开页面自动翻译</div>
              <div className="row-desc">仅对之后打开的页面生效，已打开的页面需要手动触发</div>
            </div>
            <div className="row-control">
              <Switch checked={config.autoRun} onChange={(v) => update({ autoRun: v })} />
            </div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">控制台调试日志</div>
              <div className="row-desc">排查翻译异常时打开，正常使用建议关闭</div>
            </div>
            <div className="row-control">
              <Switch checked={config.debug} onChange={(v) => update({ debug: v })} />
            </div>
          </div>
        </section>

        <section id="models" className="panel">
          <div className="panel-head">
            <span className="micro">模型</span>
            <h2>模型列表</h2>
            <div className="panel-actions">
              <Select
                value={preset}
                style={{ width: 176 }}
                options={MODEL_PRESETS.map((p) => ({ value: p.key, label: p.name }))}
                onChange={setPreset}
              />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  const p = MODEL_PRESETS.find((x) => x.key === preset);
                  const created = makeModel({
                    name: p && p.key !== 'custom' ? p.name : '新模型',
                    baseUrl: p?.baseUrl ?? '',
                    model: p?.model ?? '',
                  });
                  update({ models: [...models, created] });
                  setOpenId(created.id);
                }}
              >
                新增
              </Button>
            </div>
          </div>

          <div className="model-list">
            {models.map((m) => {
              const problems = validateModel(m);
              const result = testResult[m.id];
              const isActive = m.id === activeModel?.id;
              const open = openId === m.id;
              return (
                <div key={m.id} className={`model ${isActive ? 'is-active' : ''} ${open ? 'is-open' : ''}`}>
                  <div className="model-head">
                    <button
                      type="button"
                      className="model-toggle"
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : m.id)}
                    >
                      <i className={`dot ${isActive ? 'is-on' : ''}`} />
                      <span className="model-id">
                        <span className="model-name truncate">{m.name || m.model || '未命名模型'}</span>
                        <span className="model-sub mono truncate">
                          {m.model || '未填写模型名'}
                          <span className="dim"> · {hostOf(m.baseUrl)}</span>
                        </span>
                      </span>
                      <span className="model-tags">
                        {isActive && <span className="chip is-accent">当前使用</span>}
                        {problems.length > 0 && <span className="chip is-warn">未配置</span>}
                      </span>
                      <DownOutlined className="model-chev" />
                    </button>
                    <div className="model-quick">
                      {!isActive && (
                        <Tooltip title="设为当前使用的模型">
                          <Button size="small" icon={<StarFilled />} onClick={() => update({ activeModelId: m.id })}>
                            设为当前
                          </Button>
                        </Tooltip>
                      )}
                      <Popconfirm
                        title="确定删除该模型？"
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => {
                          const rest = models.filter((x) => x.id !== m.id);
                          const list = rest.length ? rest : [makeModel({ name: '新模型' })];
                          update({
                            models: list,
                            activeModelId: list.some((x) => x.id === config.activeModelId)
                              ? config.activeModelId
                              : list[0].id,
                          });
                          if (openId === m.id) setOpenId(list[0].id);
                        }}
                      >
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除该模型" />
                      </Popconfirm>
                    </div>
                  </div>

                  {open && (
                    <div className="model-body">
                      <div className="field-grid">
                        <label className="field">
                          <span className="micro">名称</span>
                          <Input
                            value={m.name}
                            placeholder="DeepSeek"
                            onChange={(e) => updateModel(m.id, { name: e.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span className="micro">模型名</span>
                          <Input
                            value={m.model}
                            placeholder="deepseek-chat"
                            onChange={(e) => updateModel(m.id, { model: e.target.value })}
                          />
                        </label>
                        <label className="field field-wide">
                          <span className="micro">Base URL</span>
                          <Input
                            value={m.baseUrl}
                            placeholder="https://api.deepseek.com/v1"
                            onChange={(e) => updateModel(m.id, { baseUrl: e.target.value })}
                          />
                        </label>
                        <label className="field field-wide">
                          <span className="micro">API Key</span>
                          <Input.Password
                            value={m.apiKey}
                            placeholder="sk-..."
                            onChange={(e) => updateModel(m.id, { apiKey: e.target.value })}
                          />
                        </label>
                        <label className="field">
                          <span className="micro">temperature</span>
                          <InputNumber
                            min={0}
                            max={2}
                            step={0.1}
                            value={m.temperature}
                            style={{ width: '100%' }}
                            onChange={(v) => updateModel(m.id, { temperature: Number(v) ?? 0.2 })}
                          />
                        </label>
                        <p className="field-note">
                          翻译任务建议 0.1 ~ 0.3：越低越稳定，越不容易漏行或改写；调高只影响文风。
                        </p>
                      </div>

                      <label className="field field-block">
                        <span className="micro">系统提示词（可选）</span>
                        <Input.TextArea
                          value={m.systemPrompt}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          placeholder="留空使用内置的「[index]译文」逐行协议；自定义时请保持同样的逐行格式，否则引擎无法把译文贴回页面。"
                          onChange={(e) => updateModel(m.id, { systemPrompt: e.target.value })}
                        />
                      </label>

                      <div className="model-foot">
                        <Button
                          icon={<ExperimentOutlined />}
                          loading={testing === m.id}
                          onClick={() => void test(m)}
                        >
                          测试连通性
                        </Button>
                        {result ? (
                          <span className={`test-result ${result.ok ? 'is-ok' : 'is-bad'}`}>
                            {result.ok ? <CheckCircleFilled /> : <CloseCircleFilled />}
                            <span className="truncate">{result.text}</span>
                          </span>
                        ) : (
                          <span className="dim">测试会发送一句“你好”，用于确认地址、模型名与 Key 可用。</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section id="about" className="panel">
          <div className="panel-head">
            <span className="micro">关于</span>
            <h2>运行信息</h2>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">版本</div>
              <div className="row-desc">清单版本号，随构建更新</div>
            </div>
            <div className="row-control mono">v{version}</div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">配置存储</div>
              <div className="row-desc">仅存本机，不上传；卸载扩展即清除</div>
            </div>
            <div className="row-control mono">chrome.storage.local</div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">请求链路</div>
              <div className="row-desc">网页 → 后台 Service Worker → 你配置的模型接口</div>
            </div>
            <div className="row-control mono">无业务后端中转</div>
          </div>

          <div className="row">
            <div className="row-text">
              <div className="row-title">开源许可</div>
              <div className="row-desc">
                项目地址 <code className="mono">github.com/jsoncode/ai-translate</code>
              </div>
            </div>
            <div className="row-control">
              <span className="chip">MIT</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="actionbar">
        <span className={`save-state ${dirty ? 'is-dirty' : ''}`}>
          <i className={`dot ${dirty ? 'is-warn' : 'is-on'}`} />
          {dirty ? '有未保存的改动' : '所有改动已保存'}
        </span>
        <div className="actionbar-btns">
          <Popconfirm
            title="恢复默认设置？"
            description="已填写的模型与 API Key 会被清空。"
            okText="恢复"
            cancelText="取消"
            onConfirm={() => {
              const next = normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig);
              setConfig(next);
              setThemeMode(next.theme);
              setDirty(true);
              setOpenId(next.models[0]?.id ?? null);
            }}
          >
            <Button icon={<UndoOutlined />}>恢复默认</Button>
          </Popconfirm>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={() => void save()}>
            保存设置
          </Button>
        </div>
      </footer>
    </div>
  );
}

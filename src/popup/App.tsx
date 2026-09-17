import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Card, Divider, Flex, Select, Switch, Tag, Tooltip, Typography } from 'antd';
import { GlobalOutlined, ReloadOutlined, SettingOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { LANG_NAME, LANG_OPTIONS, getActiveModel, loadConfig, patchConfig, validateModel } from '../lib/config';
import type { AppConfig, EngineStatus } from '../lib/types';

const { Text } = Typography;

interface PageStatus extends EngineStatus {
  ok: boolean;
  present?: boolean;
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

export default function PopupApp(): React.ReactElement {
  const { message } = App.useApp();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const activeModel = useMemo(() => (config ? getActiveModel(config) : undefined), [config]);
  const modelProblems = useMemo(() => (config ? validateModel(activeModel) : []), [config, activeModel]);

  const refreshStatus = useCallback(async () => {
    if (tabId == null) return;
    setStatus(await askPage(tabId));
  }, [tabId]);

  useEffect(() => {
    void (async () => {
      setConfig(await loadConfig());
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setTabId(tab?.id ?? null);
    })();
  }, []);

  useEffect(() => {
    if (tabId == null) return;
    void refreshStatus();
    timer.current = window.setInterval(() => void refreshStatus(), 1200);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [tabId, refreshStatus]);

  const save = useCallback(
    async (partial: Partial<AppConfig>) => {
      const next = await patchConfig(partial);
      setConfig(next);
      window.setTimeout(() => void refreshStatus(), 260);
      return next;
    },
    [refreshStatus],
  );

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    await save({ enabled });
    if (config && config.targetLang === 'zh' && enabled) {
      await save({ targetLang: 'en' });
    }
    setBusy(false);
  };

  const runOnce = async (): Promise<void> => {
    if (tabId == null) return;
    setBusy(true);
    await save({ enabled: true });
    await chrome.tabs.sendMessage(tabId, { type: 'ai-translate-run' }, () => void chrome.runtime.lastError);
    message.success('已开始翻译当前页面');
    setBusy(false);
    void refreshStatus();
  };

  const stop = async (): Promise<void> => {
    if (tabId == null) return;
    setBusy(true);
    await save({ enabled: false });
    await chrome.tabs.sendMessage(tabId, { type: 'ai-translate-stop' }, () => void chrome.runtime.lastError);
    setBusy(false);
    void refreshStatus();
  };

  if (!config) {
    return (
      <div className="popup">
        <Text type="secondary">加载中…</Text>
      </div>
    );
  }

  const statusText = (() => {
    if (tabId == null) return '当前标签页不可用';
    if (!status) return '当前页面不支持翻译（仅 http/https）';
    if (!config.enabled) return '已关闭';
    if (status.loading) return `翻译中… ${status.translated}/${status.total}`;
    if (status.total > status.translated) return `已翻译 ${status.translated} 项，待翻译 ${status.total - status.translated}`;
    return `已翻译 ${status.translated} 项`;
  })();

  return (
    <div className="popup">
      <Flex align="center" justify="space-between" className="head">
        <Flex align="center" gap={10}>
          <span className="logo">译</span>
          <div>
            <div className="title">AI 网页翻译</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {config.enabled ? LANG_NAME[config.targetLang] ?? config.targetLang : '已关闭'}
            </Text>
          </div>
        </Flex>
        <Tooltip title="开启/关闭页面翻译">
          <Switch checked={config.enabled} loading={busy} onChange={(v) => void toggle(v)} />
        </Tooltip>
      </Flex>

      <Card size="small" className="card">
        <Flex vertical gap={8}>
          <Flex align="center" justify="space-between" gap={8}>
            <Text type="secondary">目标语言</Text>
            <Select
              style={{ flex: 1, minWidth: 0 }}
              value={config.targetLang}
              options={LANG_OPTIONS}
              onChange={(value) => void save({ targetLang: value, enabled: value !== 'zh' ? true : config.enabled })}
            />
          </Flex>

          <Flex align="center" justify="space-between" gap={8}>
            <Text type="secondary">使用模型</Text>
            <Select
              style={{ flex: 1, minWidth: 0 }}
              value={config.activeModelId}
              onChange={(value) => void save({ activeModelId: value })}
              options={config.models.map((m) => ({
                value: m.id,
                label: `${m.name || m.model || '未命名'}${validateModel(m).length ? '（未配置）' : ''}`,
              }))}
            />
          </Flex>

          <Divider style={{ margin: '2px 0' }} />
          {modelProblems.length ? (
            <Alert
              type="warning"
              showIcon
              message={`模型配置不完整：${modelProblems.join('、')}`}
              action={
                <Button size="small" type="link" onClick={() => chrome.runtime.openOptionsPage()}>
                  去设置
                </Button>
              }
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              <GlobalOutlined /> {activeModel?.model} · {activeModel?.baseUrl}
            </Text>
          )}
        </Flex>
      </Card>

      <Flex gap={8} className="actions">
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          disabled={tabId == null || modelProblems.length > 0}
          loading={busy}
          onClick={() => void runOnce()}
          block
        >
          翻译此页
        </Button>
        <Button icon={<ReloadOutlined />} disabled={tabId == null} onClick={() => void stop()} block>
          恢复中文
        </Button>
      </Flex>

      <Card size="small" className="card">
        <Flex vertical gap={6}>
          <Flex align="center" justify="space-between">
            <Text type="secondary">打开页面自动翻译</Text>
            <Switch checked={config.autoRun} onChange={(v) => void save({ autoRun: v })} />
          </Flex>
          <Flex align="center" justify="space-between">
            <Text type="secondary">控制台调试日志</Text>
            <Switch checked={config.debug} onChange={(v) => void save({ debug: v })} />
          </Flex>
        </Flex>
      </Card>

      <Flex align="center" justify="space-between" className="foot">
        <Button type="link" icon={<SettingOutlined />} onClick={() => chrome.runtime.openOptionsPage()} style={{ paddingLeft: 0 }}>
          模型与设置
        </Button>
        <Tooltip title={statusText}>
          <Tag color={config.enabled ? (status?.loading ? 'processing' : 'success') : 'default'} style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {statusText}
          </Tag>
        </Tooltip>
      </Flex>
    </div>
  );
}

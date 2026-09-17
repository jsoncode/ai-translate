import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import { DeleteOutlined, ExperimentOutlined, PlusOutlined, SaveOutlined, StarFilled, UndoOutlined } from '@ant-design/icons';
import {
  DEFAULT_CONFIG,
  LANG_OPTIONS,
  MODEL_PRESETS,
  getActiveModel,
  loadConfig,
  makeModel,
  normalizeConfig,
  saveConfig,
  validateModel,
} from '../lib/config';
import type { AppConfig, ModelConfig } from '../lib/types';

const { Title, Text, Paragraph } = Typography;

export default function OptionsApp(): React.ReactElement {
  const { message } = App.useApp();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preset, setPreset] = useState(MODEL_PRESETS[0].key);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadConfig().then(setConfig);
  }, []);

  const models = useMemo(() => config?.models ?? [], [config]);

  function update(patch: Partial<AppConfig>): void {
    if (!config) return;
    setConfig({ ...config, ...patch });
    setDirty(true);
  }

  function updateModel(id: string, patch: Partial<ModelConfig>): void {
    if (!config) return;
    update({ models: config.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  }

  async function save(): Promise<void> {
    if (!config) return;
    setSaving(true);
    const next = await saveConfig(config);
    setConfig(next);
    setDirty(false);
    setSaving(false);
    message.success('设置已保存');
  }

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

  if (!config) {
    return (
      <div className="wrap">
        <Text type="secondary">加载中…</Text>
      </div>
    );
  }

  const activeModel = getActiveModel(config);

  return (
    <div className="wrap">
      <Title level={3}>AI 网页翻译 · 设置</Title>
      <Paragraph type="secondary">
        插件直接调用你配置的模型（OpenAI 兼容接口），不经过任何业务后端。API Key 只保存在本机{' '}
        <Text code>chrome.storage.local</Text>，且仅由插件后台在请求模型时使用。
      </Paragraph>

      <Card size="small" title="通用" className="panel">
        <Flex gap={16} wrap>
          <Form.Item label="默认目标语言" style={{ marginBottom: 0, minWidth: 200 }}>
            <Select
              value={config.targetLang}
              options={LANG_OPTIONS}
              style={{ width: 200 }}
              onChange={(v) => update({ targetLang: v })}
            />
          </Form.Item>
          <Form.Item label="请求超时（毫秒）" style={{ marginBottom: 0 }}>
            <InputNumber
              min={5000}
              max={600000}
              step={1000}
              value={config.timeoutMs}
              style={{ width: 160 }}
              onChange={(v) => update({ timeoutMs: Number(v) || 60000 })}
            />
          </Form.Item>
          <Form.Item label="开关默认值" style={{ marginBottom: 0 }} tooltip="新装的浏览器上打开页面时是否自动翻译">
            <Select
              value={config.autoRun ? 'auto' : 'manual'}
              style={{ width: 160 }}
              options={[
                { value: 'auto', label: '打开页面自动翻译' },
                { value: 'manual', label: '手动触发' },
              ]}
              onChange={(v) => update({ autoRun: v === 'auto' })}
            />
          </Form.Item>
          <Form.Item label="调试日志" style={{ marginBottom: 0 }}>
            <Select
              value={config.debug ? 'on' : 'off'}
              style={{ width: 160 }}
              options={[
                { value: 'on', label: '输出到控制台' },
                { value: 'off', label: '关闭' },
              ]}
              onChange={(v) => update({ debug: v === 'on' })}
            />
          </Form.Item>
        </Flex>
      </Card>

      <Card
        size="small"
        title="模型列表"
        className="panel"
        extra={
          <Space>
            <Select
              value={preset}
              style={{ width: 200 }}
              options={MODEL_PRESETS.map((p) => ({ value: p.key, label: p.name }))}
              onChange={setPreset}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                const p = MODEL_PRESETS.find((x) => x.key === preset);
                update({
                  models: [
                    ...models,
                    makeModel({
                      name: p && p.key !== 'custom' ? p.name : '新模型',
                      baseUrl: p?.baseUrl ?? '',
                      model: p?.model ?? '',
                    }),
                  ],
                });
              }}
            >
              新增模型
            </Button>
          </Space>
        }
      >
        <Flex vertical gap={12}>
          {models.map((m) => {
            const problems = validateModel(m);
            const result = testResult[m.id];
            const isActive = m.id === activeModel?.id;
            return (
              <Card
                key={m.id}
                size="small"
                className={isActive ? 'model-card active' : 'model-card'}
                title={
                  <Space>
                    <Text strong>{m.name || m.model || '未命名模型'}</Text>
                    {isActive && (
                      <Tag color="blue" icon={<StarFilled />}>
                        当前使用
                      </Tag>
                    )}
                    {problems.length > 0 && <Tag color="warning">未配置</Tag>}
                  </Space>
                }
                extra={
                  <Space>
                    {!isActive && (
                      <Button size="small" onClick={() => update({ activeModelId: m.id })}>
                        设为当前
                      </Button>
                    )}
                    <Popconfirm
                      title="确定删除该模型？"
                      onConfirm={() => {
                        const rest = models.filter((x) => x.id !== m.id);
                        const list = rest.length ? rest : [makeModel({ name: '新模型' })];
                        update({
                          models: list,
                          activeModelId: list.some((x) => x.id === config.activeModelId) ? config.activeModelId : list[0].id,
                        });
                      }}
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                }
              >
                <Flex gap={12} wrap>
                  <Form.Item label="名称" style={{ marginBottom: 0, minWidth: 200 }}>
                    <Input
                      value={m.name}
                      placeholder="例如 DeepSeek"
                      style={{ width: 200 }}
                      onChange={(e) => updateModel(m.id, { name: e.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label="Base URL" style={{ marginBottom: 0, minWidth: 300 }}>
                    <Input
                      value={m.baseUrl}
                      placeholder="https://api.deepseek.com/v1"
                      style={{ width: 300 }}
                      onChange={(e) => updateModel(m.id, { baseUrl: e.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label="模型名" style={{ marginBottom: 0, minWidth: 200 }}>
                    <Input
                      value={m.model}
                      placeholder="deepseek-chat"
                      style={{ width: 200 }}
                      onChange={(e) => updateModel(m.id, { model: e.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label="API Key" style={{ marginBottom: 0, minWidth: 260 }}>
                    <Input.Password
                      value={m.apiKey}
                      placeholder="sk-..."
                      style={{ width: 260 }}
                      onChange={(e) => updateModel(m.id, { apiKey: e.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label="temperature" style={{ marginBottom: 0 }}>
                    <InputNumber
                      min={0}
                      max={2}
                      step={0.1}
                      value={m.temperature}
                      style={{ width: 120 }}
                      onChange={(v) => updateModel(m.id, { temperature: Number(v) ?? 0.2 })}
                    />
                  </Form.Item>
                </Flex>

                <Form.Item label="系统提示词（可选，留空使用内置的逐行 [index] 译文协议）" style={{ margin: '10px 0 0' }}>
                  <Input.TextArea
                    value={m.systemPrompt}
                    autoSize={{ minRows: 2, maxRows: 6 }}
                    placeholder="留空即可；自定义时请保持「[index]译文」逐行输出，否则引擎无法回显"
                    onChange={(e) => updateModel(m.id, { systemPrompt: e.target.value })}
                  />
                </Form.Item>

                <Flex align="center" gap={12} style={{ marginTop: 10 }}>
                  <Button icon={<ExperimentOutlined />} loading={testing === m.id} onClick={() => void test(m)}>
                    测试连通性
                  </Button>
                  {result && (
                    <Text type={result.ok ? 'success' : 'danger'} style={{ fontSize: 12 }}>
                      {result.text}
                    </Text>
                  )}
                </Flex>
              </Card>
            );
          })}
        </Flex>
      </Card>

      {dirty && (
        <Alert type="info" showIcon style={{ marginBottom: 68 }} message="有未保存的修改，记得点下面的「保存设置」" />
      )}

      <div className="footer">
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
          保存设置
        </Button>
        <Popconfirm
          title="恢复默认设置？已填写的模型与 API Key 会被清空。"
          onConfirm={() => {
            setConfig(normalizeConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG))));
            setDirty(true);
          }}
        >
          <Button icon={<UndoOutlined />}>恢复默认</Button>
        </Popconfirm>
        <Divider type="vertical" />
        <Text type="secondary" style={{ fontSize: 12 }}>
          保存后页面会自动按新配置重跑；已打开的标签页无需刷新。
        </Text>
      </div>
    </div>
  );
}

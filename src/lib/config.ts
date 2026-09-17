import type { AppConfig, LangOption, ModelConfig, ModelPreset, ThemeMode } from './types';
import { readConfig, writeConfig } from './storage';

/** 目标语言可选项 */
export const LANG_OPTIONS: LangOption[] = [
  { value: 'en', label: '英语 English' },
  { value: 'zh', label: '中文（不翻译）' },
  { value: 'ja', label: '日语 日本語' },
  { value: 'ko', label: '韩语 한국어' },
  { value: 'fr', label: '法语 Français' },
  { value: 'de', label: '德语 Deutsch' },
  { value: 'es', label: '西班牙语 Español' },
  { value: 'pt', label: '葡萄牙语 Português' },
  { value: 'ru', label: '俄语 Русский' },
  { value: 'ar', label: '阿拉伯语 العربية' },
  { value: 'th', label: '泰语 ไทย' },
  { value: 'vi', label: '越南语 Tiếng Việt' },
];

export const LANG_NAME: Record<string, string> = {
  en: '英语', zh: '中文', ja: '日语', ko: '韩语', fr: '法语', de: '德语',
  es: '西班牙语', pt: '葡萄牙语', ru: '俄语', ar: '阿拉伯语', th: '泰语', vi: '越南语',
};

/**
 * 翻译协议：逐行 [index]译文。
 * 翻译引擎的流式解析、去重、回显全部基于这个协议，改这里要同步确认引擎仍能解析。
 */
export const DEFAULT_PROMPT = [
  '你是一位专业的翻译人员，请把用户提供的网页文案逐行翻译成目标语言。',
  '要求：',
  '1. 保持原有格式；如果内容是 HTML，请保留 HTML 标签结构；',
  '2. 保留每一行开头的索引标记，例如输入 "[0] 中文内容"，输出必须为 "[0] translated content"；',
  '3. 行数必须与输入一一对应，不合并、不拆分、不增删；',
  '4. 只输出 "索引+译文" 这些行，严禁输出任何解释、前后缀或代码块标记。',
].join('\n');

/** 常见 OpenAI 兼容服务预设 */
export const MODEL_PRESETS: ModelPreset[] = [
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { key: 'moonshot', name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { key: 'qwen', name: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { key: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { key: 'custom', name: '自定义', baseUrl: '', model: '' },
];

let seq = 0;
export function uid(prefix = 'm'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeModel(patch: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: uid(),
    name: '',
    baseUrl: '',
    model: '',
    apiKey: '',
    temperature: 0.2,
    systemPrompt: '',
    ...patch,
  };
}

export const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
];

export const DEFAULT_CONFIG: AppConfig = {
  enabled: false,
  targetLang: 'en',
  autoRun: true,
  debug: false,
  timeoutMs: 60000,
  activeModelId: 'preset_deepseek',
  theme: 'system',
  models: [
    makeModel({
      id: 'preset_deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    }),
  ],
};

/** 把任意来源的对象收敛成合法配置（UI/存储/旧版本数据都可能不完整） */
export function normalizeConfig(input?: Partial<AppConfig> | null): AppConfig {
  const raw = (input ?? {}) as Partial<AppConfig>;
  const out: AppConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    models: Array.isArray(raw.models) && raw.models.length ? raw.models.map((m) => makeModel(m)) : DEFAULT_CONFIG.models.map((m) => makeModel(m)),
  };

  if (!LANG_NAME[out.targetLang]) out.targetLang = DEFAULT_CONFIG.targetLang;
  if (!THEME_OPTIONS.some((t) => t.value === out.theme)) out.theme = DEFAULT_CONFIG.theme;
  out.timeoutMs = Math.min(Math.max(Math.trunc(Number(out.timeoutMs)) || 60000, 5000), 600000);
  out.models = out.models.map((m) => ({
    ...m,
    temperature: Math.min(Math.max(Number(m.temperature) || 0, 0), 2),
  }));
  if (!out.models.some((m) => m.id === out.activeModelId)) {
    out.activeModelId = out.models[0].id;
  }
  return out;
}

export async function loadConfig(): Promise<AppConfig> {
  return normalizeConfig((await readConfig()) as Partial<AppConfig> | undefined);
}

export async function saveConfig(config: Partial<AppConfig>): Promise<AppConfig> {
  const next = normalizeConfig(config);
  await writeConfig(next);
  return next;
}

/** 读取 -> 合并 -> 保存 */
export async function patchConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  return saveConfig({ ...current, ...partial });
}

export function getActiveModel(config: AppConfig): ModelConfig | undefined {
  return config.models.find((m) => m.id === config.activeModelId) ?? config.models[0];
}

/** 返回缺失项列表，空数组代表可用 */
export function validateModel(model?: Partial<ModelConfig> | null): string[] {
  const problems: string[] = [];
  if (!model) return ['未选择模型'];
  if (!String(model.baseUrl ?? '').trim()) problems.push('缺少 Base URL');
  if (!String(model.model ?? '').trim()) problems.push('缺少模型名');
  if (!String(model.apiKey ?? '').trim()) problems.push('缺少 API Key');
  return problems;
}

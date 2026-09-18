/**
 * 对外 API：run / stop / status / config
 *
 * 由 ai-translate-engine.js 拆分而来（原 L4080-L4159），函数体保持原样，仅补类型与导入导出。
 */
import type { EngineConfig, TranslateTransport } from './types';
import { getLanguage, getNodeDataMap, getRouteKey, resetRouteRetryFlags } from './cache';
import { hookHistory, hookViewportScroll, listenTitleChange, scanPageContent } from './hooks';
import { isOpenTranslate } from './lang';
import { resetMutationBatch, reverseChinese } from './lifecycle';
import { clearListener, listenDomChnage } from './listeners';
import { showLoading } from './logger';
import { scheduleDeferredContentScan } from './mutation';
import { runtime, state } from './state';

/**
 * 翻译主入口：语言切换、pageshow、FloatBubble.languageAiChange 都会调用
 * zh：回滚中文并停监听；非 zh：挂 history、单例 DOM 监听、首屏全页扫一次
 */
export function run() {
  const lang = getLanguage()
  clearListener()
  // 插件版：目标语言是中文（包括"关闭翻译开关"）时必须走回滚流程，
  // 不能在下面的开关判断处提前 return，否则关闭开关后页面会停在英文。
  if (lang === 'zh') {
    runtime.translatePipelineActive = false
    showLoading(false)
    reverseChinese()
    clearListener()
    // 中文模式下保留滚动监听，虚拟列表上划时恢复回收 DOM 中的残留英文
    hookViewportScroll()
    return
  }
  if (!isOpenTranslate()) {
    runtime.translatePipelineActive = false
    return
  }
  runtime.translatePipelineActive = true
  hookHistory()
  runtime.lastPathname = getRouteKey()
  // 新一轮翻译：清掉上一轮因失败/中断留下的 error 与尝试次数，否则条目会被永久跳过
  resetRouteRetryFlags()
  listenDomChnage()
  listenTitleChange()
  hookViewportScroll()
  scanPageContent()
  scheduleDeferredContentScan()
}

/** 供插件 content.js 调用：注入/更新配置 */
export function applyEngineConfig( next?: Partial<EngineConfig>) {
  runtime.engineConfig = Object.assign({}, runtime.engineConfig, next || {})
}

/** 供插件 content.js 调用：注入模型传输层 */
export function setEngineTransport( transport: TranslateTransport) {
  runtime.engineTransport = transport
}

/** 停止翻译并断开监听（关闭开关时调用） */
export function stopTranslation() {
  clearListener()
  if (runtime.listenDomHandler) {
    runtime.listenDomHandler.disconnect()
    runtime.listenDomHandler = null
  }
  resetMutationBatch()
  runtime.translatePipelineActive = false
}

/** 当前状态（popup 展示用） */
export function getEngineStatus() {
  let total = 0
  let translated = 0
  const map = getNodeDataMap()
  for (let k in map) {
    const item = map[k]
    if (item.pathname !== getRouteKey()) {
      continue
    }
    total++
    if (item.nodeTranslate) {
      translated++
    }
  }
  return {
    enabled: !!(runtime.engineConfig && runtime.engineConfig.enabled),
    targetLang: getLanguage(),
    loading: !!state.isLoading,
    total: total,
    translated: translated,
    route: getRouteKey()
  }
}

/**
 * 全局导出（window.__aiTranslateEngine）
 *
 * 由 ai-translate-engine.js 拆分而来（原 L4160-L4204），函数体保持原样，仅补类型与导入导出。
 */
import { applyEngineConfig, getEngineStatus, run, setEngineTransport, stopTranslation } from './api';
import { applyCachedTranslationsInRoot } from './bulk-apply';
import { getCookie, getLanguage, getRouteKey } from './cache';
import { isNumericOnlyChange } from './composite-write';
import { scanPageContent, scanPageTitle } from './hooks';
import { hasChinese, hasTranslateSkipAncestor, isOpenTranslate } from './lang';
import { pruneStaleSelectors, reverseChinese, revertTranslationsForRoute, scanViewportContent } from './lifecycle';
import { logger, showLoading } from './logger';
import { findInput, findText } from './scan';
import { runtime, state } from './state';
import { abortActiveTranslations, applyTranslationResult, flashAllText } from './stream';
import { isItemInViewport, isTranslatableNodeInViewport } from './viewport';

/** 供业务在接口渲染完成后手动触发：aiTranslateHandler.scanPageContent() */
window.aiTranslateHandler = {
  run,
  reverseChinese,
  getCookie,
  getLanguage,
  isOpenTranslate,
  findInput,
  findText,
  state,
  logger,
  applyTranslationResult,
  flashAllText,
  hasChinese,
  scanPageContent,
  scanViewportContent,
  scanPageTitle,
  isTranslatableNodeInViewport,
  isItemInViewport,
  hasTranslateSkipAncestor,
  isNumericOnlyChange,
  pruneStaleSelectors,
  abortActiveTranslations,
  getRouteKey,
  revertTranslationsForRoute,
  applyCachedTranslationsInRoot,
  showLoading,
}
/** 插件版：启动/停止完全由 content.js 控制，不在页面加载时自动跑 */
window.__aiTranslateEngine = {
  applyConfig: applyEngineConfig,
  setTransport: setEngineTransport,
  getConfig: function () { return runtime.engineConfig },
  run: run,
  stop: stopTranslation,
  status: getEngineStatus,
  hasChinese: hasChinese,
  getLanguage: getLanguage,
  scanPageContent: scanPageContent,
  scanViewportContent: scanViewportContent,
  flashAllText: flashAllText,
  reverseChinese: reverseChinese,
  state: state
}

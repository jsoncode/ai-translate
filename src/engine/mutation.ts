/**
 * MutationObserver 批处理与延迟扫描
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3660-L3739），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { onTranslate } from './batch';
import { applyCachedTranslationsInRoot } from './bulk-apply';
import { getLanguage } from './cache';
import { scanPageContent } from './hooks';
import { hasChinese, isOpenTranslate } from './lang';
import { normalizeAddedRoots, pruneStaleSelectors, resetMutationBatch, shouldScanElement } from './lifecycle';
import { findInput, findText, hasPendingTranslateWork, setOneCompositeNode, setOneNode } from './scan';
import { runtime } from './state';
import { isTranslatableNodeInViewport } from './viewport';

export function clearDeferredContentScanTimers() {
  for (let i = 0; i < runtime.deferredScanTimers.length; i++) {
    clearTimeout(runtime.deferredScanTimers[i])
  }
  runtime.deferredScanTimers = []
}

/**
 * 刷新/首屏后延迟补扫：移动端布局、地址栏、FloatBubble 配置常晚于 pageshow
 * 不经过 run/clearListener，避免 abort 进行中的翻译请求
 */
export function scheduleDeferredContentScan() {
  clearDeferredContentScanTimers()
  function tick() {
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    scanPageContent()
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(function () {
      requestAnimationFrame(tick)
    })
  }
  runtime.deferredScanTimers.push(setTimeout(tick, 300))
  runtime.deferredScanTimers.push(setTimeout(tick, 1000))
}

/** 仅扫描新增/变更的子树，不触发全页 walk；仅登记可视区内节点 */
function scanAddedRoot( node: DomNode) {
  if (!node) {
    return
  }
  if (node.nodeType === Node.TEXT_NODE) {
    if (hasChinese(node.nodeValue) && isTranslatableNodeInViewport(node)) {
      setOneNode(node)
    }
    return
  }
  if (shouldScanElement(node)) {
    findText(node, true)
    findInput(node, true)
    // findText 内部的 findInlineCompositeBlocks 用的是 TreeWalker（不包含 root 自身），
    // 若新增节点本身就是行内复合块（如 <span>营业时间</span>&nbsp;9:00-16:30），
    // 它的内层文本会被 FILTER_REJECT、自身又不会被遍历到，导致整块漏登记、一直保持中文。
    // 这里补一次 root 自身的复合块登记（非复合块会内部直接 return，无副作用）。
    setOneCompositeNode(node)
  }
}

/**
 * 合并一批 MutationRecord 后增量处理：清理移除节点登记 -> 扫新增根 -> 刷缓存 -> 请求翻译
 */
export function flushMutationBatch() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    resetMutationBatch()
    return
  }
  const added = runtime.mutationBatch.added
  const removed = runtime.mutationBatch.removed
  const hasChildList = runtime.mutationBatch.hasChildList
  resetMutationBatch()

  if (removed.size) {
    pruneStaleSelectors()
  }

  const roots = normalizeAddedRoots(added)
  if (roots.length) {
    roots.forEach(scanAddedRoot)
    roots.forEach(function (root) {
      applyCachedTranslationsInRoot(root)
    })
    // 有新增 DOM 或仍有未译条目时才请求；不在每次回显后 flashAllText
    if (hasChildList || hasPendingTranslateWork()) {
      onTranslate()
    }
  }
}

/**
 * DOM 监听装配与清理
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3964-L4079），函数体保持原样，仅补类型与导入导出。
 */
import { getLanguage } from './cache';
import { reapplyCachedTranslationIfNeeded } from './guard';
import { debouncedFlushMutationBatch, unhookViewportScroll } from './hooks';
import { hasChinese, hasTranslateSkipAncestor, isOpenTranslate } from './lang';
import { isApplyingDom, resetMutationBatch } from './lifecycle';
import { clearDeferredContentScanTimers } from './mutation';
import { runtime } from './state';
import { abortActiveTranslations } from './stream';
import { resolveItemByNodeText } from './write';

/**
 * 将单条 Mutation 记入批次队列，由 debouncedFlushMutationBatch 统一去重后扫描
 * 不在这里直接 findText(document.body)，避免与增量逻辑重复
 */
function enqueueMutationRecord( mutation: MutationRecord) {
  if (isApplyingDom()) {
    return
  }
  if (mutation.type === 'childList') {
    runtime.mutationBatch.hasChildList = true
    mutation.addedNodes.forEach(function (node) {
      if (!node) {
        return
      }
      if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
        runtime.mutationBatch.added.add(node)
      }
    })
    mutation.removedNodes.forEach(function (node) {
      if (!node) {
        return
      }
      if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
        runtime.mutationBatch.removed.add(node)
      }
    })
  } else if (mutation.type === 'characterData') {
    const target = mutation.target
    if (target && hasTranslateSkipAncestor(target)) {
      return
    }
    const trimmed = (target.nodeValue || '').trim()
    if (target && hasChinese(trimmed)) {
      const item = resolveItemByNodeText(target.nodeValue || '', trimmed)
      if (item) {
        reapplyCachedTranslationIfNeeded(target, item)
      }
      runtime.mutationBatch.added.add(target)
    }
  } else if (mutation.type === 'attributes') {
    const target = mutation.target
    if (!target || target.nodeType !== Node.ELEMENT_NODE) {
      return
    }
    if (mutation.attributeName === 'placeholder') {
      runtime.mutationBatch.added.add(target)
    } else if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
      // 仅入队，交由防抖批次统一回显。旧实现在这里同步遍历目标子树，
      // 动画/轮播/弹框每次改 class|style 都会触发一次全子树 TreeWalker，是主要性能瓶颈之一。
      if (hasChinese(target.textContent || '')) {
        runtime.mutationBatch.added.add(target)
      }
    }
  }
}

/**
 * 切页或重跑 run 前清理：abort 进行中的翻译、重置 loading
 * 仅当语言为 zh 时断开 MutationObserver（非中文切页需保持监听）
 */
export function clearListener() {
  abortActiveTranslations('clearListener')
  clearDeferredContentScanTimers()
  if (runtime.routeScanTimer) {
    clearTimeout(runtime.routeScanTimer)
    runtime.routeScanTimer = null
  }
  if (runtime.titleRouteTimer) {
    clearTimeout(runtime.titleRouteTimer)
    runtime.titleRouteTimer = null
  }
  if (runtime.listenTitleHandler) {
    runtime.listenTitleHandler.disconnect()
    runtime.listenTitleHandler = null
  }
  unhookViewportScroll()
  const lang = getLanguage()
  if (lang === 'zh') {
    if (runtime.listenDomHandler) {
      runtime.listenDomHandler.disconnect()
      runtime.listenDomHandler = null
    }
    resetMutationBatch()
  }
}

/**
 * 注册 document.body 单例 MutationObserver（subtree: true）
 * 仅 enqueue 增删节点，防抖后增量 scanAddedRoot；避免多 Observer 重复监听同一子树
 */
export function listenDomChnage() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    return
  }
  if (runtime.listenDomHandler) {
    return
  }
  runtime.listenDomHandler = new MutationObserver(function (mutationsList) {
    if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
      return
    }
    for (let mi = 0; mi < mutationsList.length; mi++) {
      enqueueMutationRecord(mutationsList[mi])
    }
    debouncedFlushMutationBatch()
  });

  runtime.listenDomHandler.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
    attributeFilter: ['placeholder', 'style', 'class'],
  });
}

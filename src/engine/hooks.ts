/**
 * 滚动/标题/路由钩子与整页扫描
 *
 * 由 ai-translate-engine.js 拆分而来（原 L3740-L3963），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { onTranslate } from './batch';
import { applyRevertTranslationsInRoot } from './bulk-apply';
import { debounce, getLanguage, getRouteKey, pruneRouteNodeCache } from './cache';
import { hasChinese, isOpenTranslate } from './lang';
import { isApplyingDom, resetMutationBatch, runWithoutDomObserver, scanViewportContent, scheduleRouteScanAfterChange } from './lifecycle';
import { flushMutationBatch } from './mutation';
import { findInput, findText, setOneNode } from './scan';
import { runtime } from './state';
import { abortActiveTranslations, flashAllText } from './stream';

export const debouncedFlushMutationBatch = debounce(flushMutationBatch, 120)

/** 滚动/resize：非中文时补扫可视区并翻译；中文时补扫可视区并恢复中文 */
const debouncedOnViewportScroll = debounce(function () {
  if (!isOpenTranslate()) {
    return
  }
  if (getLanguage() === 'zh') {
    applyRevertTranslationsInRoot(document.body, true)
    return
  }
  scanViewportContent()
  flashAllText()
  onTranslate()
}, 150)

export function hookViewportScroll() {
  if (runtime.viewportScrollHooked) {
    return
  }
  runtime.viewportScrollHooked = true
  document.addEventListener('scroll', debouncedOnViewportScroll, {passive: true, capture: true})
  window.addEventListener('scroll', debouncedOnViewportScroll, {passive: true})
  window.addEventListener('resize', debouncedOnViewportScroll, {passive: true})
  const vv = window.visualViewport
  if (vv) {
    vv.addEventListener('resize', debouncedOnViewportScroll, {passive: true})
    vv.addEventListener('scroll', debouncedOnViewportScroll, {passive: true})
  }
}

export function unhookViewportScroll() {
  if (!runtime.viewportScrollHooked) {
    return
  }
  runtime.viewportScrollHooked = false
  document.removeEventListener('scroll', debouncedOnViewportScroll, {capture: true})
  window.removeEventListener('scroll', debouncedOnViewportScroll)
  window.removeEventListener('resize', debouncedOnViewportScroll)
  const vv = window.visualViewport
  if (vv) {
    vv.removeEventListener('resize', debouncedOnViewportScroll)
    vv.removeEventListener('scroll', debouncedOnViewportScroll)
  }
}

/** 获取或创建 title 元素内的文本节点，供 setOneNode / writeTranslateToNode 使用 */
function ensureTitleTextNode() {
  const titleEl = document.querySelector('title')
  if (!titleEl) {
    return null
  }
  for (let i = 0; i < titleEl.childNodes.length; i++) {
    const node = titleEl.childNodes[i]
    if (node.nodeType === Node.TEXT_NODE) {
      return node
    }
  }
  const text = document.title
  if (!text) {
    return null
  }
  runWithoutDomObserver(function () {
    titleEl.appendChild(document.createTextNode(text))
  })
  return titleEl.firstChild
}

/** 扫描并登记页面标题（document.title 不在 body 子树内，需单独处理） */
export function scanPageTitle() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    return
  }
  const title = (document.title || '').trim()
  if (!title || !hasChinese(title)) {
    return
  }
  const textNode = ensureTitleTextNode()
  if (textNode) {
    setOneNode(textNode)
  }
}

/** 监听 title 文案变化；title 元素晚挂载时改监听 head childList */
export function listenTitleChange() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    return
  }
  if (runtime.listenTitleHandler) {
    return
  }

  function onTitleMutated() {
    if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
      return
    }
    scanPageTitle()
    flashAllText()
    onTranslate()
  }

  function observeTitleEl( titleEl: DomNode) {
    if (!titleEl || runtime.listenTitleHandler) {
      return
    }
    runtime.listenTitleHandler = new MutationObserver(function () {
      onTitleMutated()
    })
    runtime.listenTitleHandler.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    scanPageTitle()
  }

  const titleEl = document.querySelector('title')
  if (titleEl) {
    observeTitleEl(titleEl)
    return
  }

  const head = document.head
  if (!head) {
    return
  }
  runtime.listenTitleHandler = new MutationObserver(function (mutationsList) {
    if (!isOpenTranslate() || getLanguage() === 'zh' || isApplyingDom()) {
      return
    }
    for (let mi = 0; mi < mutationsList.length; mi++) {
      const mutation = mutationsList[mi]
      if (mutation.type !== 'childList') {
        continue
      }
      mutation.addedNodes.forEach(function (node) {
        if (node && node.nodeType === Node.ELEMENT_NODE && (node as DomNode).tagName && (node as DomNode).tagName.toLowerCase() === 'title') {
          runtime.listenTitleHandler?.disconnect()
          runtime.listenTitleHandler = null
          observeTitleEl(node)
        }
      })
    }
  })
  runtime.listenTitleHandler.observe(head, {childList: true})
}

/** 路由切换后延迟补扫标题（部分 SPA 异步设置 document.title） */
function scheduleTitleScanAfterRoute() {
  if (runtime.titleRouteTimer) {
    clearTimeout(runtime.titleRouteTimer)
    runtime.titleRouteTimer = null
  }
  runtime.titleRouteTimer = setTimeout(function () {
    runtime.titleRouteTimer = null
    if (!isOpenTranslate() || getLanguage() === 'zh') {
      return
    }
    scanViewportContent()
    scanPageTitle()
    flashAllText()
    onTranslate()
  }, 1000)
}

/**
 * 全页扫描：用于首屏 run、路由切换等「整页替换」场景（登记全页文案，请求仍按可视区过滤）
 * 日常动态内容由 MutationObserver 增量 scanAddedRoot 覆盖
 */
export function scanPageContent() {
  if (!isOpenTranslate() || getLanguage() === 'zh') {
    return
  }
  findText(document.body, false)
  findInput(document.body, false)
  scanPageTitle()
  flashAllText()
  onTranslate()
}

/** SPA 路由变化：中止旧请求 -> 切换路由桶 -> 延迟扫描新页（不回滚可见 DOM，避免切页闪中文） */
function onRouteChange() {
  const apply = function () {
    const routeKey = getRouteKey()
    if (routeKey !== runtime.lastPathname) {
      abortActiveTranslations('route')
      resetMutationBatch()
      runtime.lastPathname = routeKey
      pruneRouteNodeCache(routeKey)
      scheduleRouteScanAfterChange()
      scheduleTitleScanAfterRoute()
      return
    }
    abortActiveTranslations('route')
    scanPageContent()
    scheduleTitleScanAfterRoute()
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(apply)
  } else {
    setTimeout(apply, 0)
  }
}

/** 劫持 pushState/replaceState，并监听 popstate/hashchange（pageshow 对 SPA 内跳转不一定触发） */
export function hookHistory() {
  if (runtime.historyHooked) {
    return
  }
  runtime.historyHooked = true
  const rawPush = history.pushState
  const rawReplace = history.replaceState
  history.pushState = function (...args: Parameters<History['pushState']>) {
    rawPush.apply(history, args)
    onRouteChange()
  }
  history.replaceState = function (...args: Parameters<History['replaceState']>) {
    rawReplace.apply(history, args)
    onRouteChange()
  }
  window.addEventListener('popstate', onRouteChange)
  window.addEventListener('hashchange', onRouteChange)
}

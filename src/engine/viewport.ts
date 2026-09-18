/**
 * 可视区判定与文本读取
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2175-L2329），函数体保持原样，仅补类型与导入导出。
 */
import { getRouteKey } from './cache';
import { isNodeConnected, resolveSelectorNode } from './selector';
import { BLOCK_TAGS, VIEWPORT_BUFFER } from './state';
import type { DomNode, EngineItem, Rect } from './types';

/** 读取节点当前可翻译文案：文本节点的 nodeValue，或 input/textarea 的 placeholder */
function getViewportBounds() {
  const vv = window.visualViewport
  if (vv && typeof vv.height === 'number' && vv.height > 0) {
    return {
      top: vv.offsetTop - VIEWPORT_BUFFER,
      left: vv.offsetLeft - VIEWPORT_BUFFER,
      bottom: vv.offsetTop + vv.height + VIEWPORT_BUFFER,
      right: vv.offsetLeft + (vv.width || 0) + VIEWPORT_BUFFER,
    }
  }
  return {
    top: -VIEWPORT_BUFFER,
    left: -VIEWPORT_BUFFER,
    bottom: (window.innerHeight || document.documentElement.clientHeight || 0) + VIEWPORT_BUFFER,
    right: (window.innerWidth || document.documentElement.clientWidth || 0) + VIEWPORT_BUFFER,
  }
}

function rectsIntersect( rect: Rect, bounds: Rect) {
  return rect.bottom >= bounds.top && rect.top <= bounds.bottom &&
      rect.right >= bounds.left && rect.left <= bounds.right
}

/** 是否作为视口判断锚点的块级/卡片容器（避免沿 body 误判整页可视） */
function isViewportAnchorElement( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false
  }
  const tag = el.tagName.toLowerCase()
  if (BLOCK_TAGS.indexOf(tag) !== -1) {
    return true
  }
  const style = window.getComputedStyle(el)
  const display = style.display
  return display === 'block' || display === 'flex' || display === 'grid' || display === 'list-item' ||
      display === 'table' || display === 'table-cell' || display === 'table-row'
}

/**
 * 取用于视口判断的锚点元素：向上找到块级/卡片容器，以其是否与视口相交代表整块是否「露头」
 */
function getViewportAnchorElement( node: DomNode) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node
  if (!el) {
    return null
  }
  if (el.tagName && el.tagName.toLowerCase() === 'title') {
    return el
  }
  let current = el
  let fallback = el
  while (current && current.nodeType === Node.ELEMENT_NODE &&
      current !== document.body && current !== document.documentElement) {
    if (isViewportAnchorElement(current)) {
      return current
    }
    fallback = current
    current = current.parentElement
  }
  return fallback
}

/** 元素是否在可视区（含缓冲）；display:none / 零尺寸视为不可见 */
function isElementInViewport( el: DomNode) {
  if (!el || !isNodeConnected(el)) {
    return false
  }
  if (el.tagName && el.tagName.toLowerCase() === 'title') {
    return true
  }
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false
  }
  const bounds = getViewportBounds()
  const rects = el.getClientRects()
  if (!rects.length) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      return false
    }
    return rectsIntersect(rect, bounds)
  }
  for (let ri = 0; ri < rects.length; ri++) {
    const rect = rects[ri]
    if (rect.width === 0 && rect.height === 0) {
      continue
    }
    if (rectsIntersect(rect, bounds)) {
      return true
    }
  }
  return false
}

/** 文本节点 / input/textarea 是否处于可视区（按块级锚点判断，容器露头则子树内文案均视为可视） */
export function isTranslatableNodeInViewport( node: DomNode) {
  if (!node || !isNodeConnected(node)) {
    return false
  }
  const anchor = getViewportAnchorElement(node)
  if (!anchor) {
    return false
  }
  if (anchor.tagName && anchor.tagName.toLowerCase() === 'title') {
    return true
  }
  return isElementInViewport(anchor)
}

/** nodeDataMap 条目是否至少有一个 selector 落在当前路由可视区 */
export function isItemInViewport( item: EngineItem) {
  if (!item) {
    return false
  }
  const routeKey = getRouteKey()
  for (let si = 0; si < item.selectors.length; si++) {
    const sel = item.selectors[si]
    if (sel.pathname && sel.pathname !== routeKey) {
      continue
    }
    const node = resolveSelectorNode(sel)
    if (node && isTranslatableNodeInViewport(node)) {
      return true
    }
  }
  return false
}

/** 是否仍为待发起翻译的条目 */
export function isPendingTranslateItem( item: EngineItem) {
  return !item.nodeTranslate &&
      !item.sourceTranslate.includes(item.chinese) &&
      !item.loading &&
      !item.error &&
      (!item.times || item.times < 3)
}

export function getNodeText( node: DomNode) {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue || ''
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase()
    if (['input', 'textarea'].includes(tag)) {
      return node.placeholder || ''
    }
  }
  return ''
}

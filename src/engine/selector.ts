/**
 * 选择器生成、解析与回查
 *
 * 由 ai-translate-engine.js 拆分而来（原 L1781-L2000），函数体保持原样，仅补类型与导入导出。
 */
import { getNodeDataMap, getRouteKey } from './cache';
import { normalizeCompositeHtml } from './composite-dom';
import { isNumericOnlyChange } from './composite-write';
import { isSameSelectorSlot } from './guard';
import { hasWeakRef } from './original';
import { getNodeText } from './viewport';
import type { DomNode, EngineItem, SelectorSlot, WeakNodeRef } from './types';

function escapeCssAttr( val: string) {
  return String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function escapeCssClass( name: string) {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(name)
  }
  return String(name).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')
}

/** 生成单级选择器片段：id / data-* + 标签 + nth-child，不含 class */
export function buildSelectorPart( el: DomNode, parent: DomNode) {
  let part = el.tagName.toLowerCase()
  const testId = el.getAttribute && el.getAttribute('data-testid')
  if (testId) {
    return part + '[data-testid="' + escapeCssAttr(testId) + '"]'
  }
  const dataId = el.dataset && (el.dataset.id || el.dataset.translateId)
  if (dataId) {
    return part + '[data-id="' + escapeCssAttr(dataId) + '"]'
  }
  if (parent) {
    const children = Array.from(parent.children)
    const siblings = children.filter(function (c: DomNode) { return c.tagName === el.tagName })
    if (siblings.length > 1) {
      part += ':nth-child(' + (children.indexOf(el) + 1) + ')'
    }
  }
  return part
}

export function isNodeConnected( node: DomNode) {
  if (!node) {
    return false
  }
  return typeof node.isConnected === 'boolean' ? node.isConnected : document.contains(node)
}

/** 兼容旧缓存：从含 class 的历史 path 中提取纯结构路径 */
export function stripClassesFromSelectorPath( path?: string) {
  if (!path || path.indexOf('.') === -1) {
    return path
  }
  return path.split(' > ').map(function (part) {
    let segment = part
    const nthMatch = segment.match(/(:nth-child\(\d+\))$/)
    const nth = nthMatch ? nthMatch[1] : ''
    if (nth) {
      segment = segment.slice(0, -nth.length)
    }
    const attrMatch = segment.match(/(\[data-[^\]]+\])/)
    const attr = attrMatch ? attrMatch[1] : ''
    const tag = segment.split(/[.[]/)[0]
    return tag + attr + nth
  }).join(' > ')
}

function querySelectorAllSafe( path: string) {
  if (!path) {
    return []
  }
  try {
    return Array.from(document.querySelectorAll(path))
  } catch (e) {
    return []
  }
}

/** 按 selector 槽位反查 nodeDataMap 条目，用于歧义路径消歧 */
function findItemBySelectorSlot( sel: SelectorSlot) {
  if (!sel) {
    return null
  }
  const routeKey = getRouteKey()
  for (let k in getNodeDataMap()) {
    const it = getNodeDataMap()[k]
    if (it.pathname !== routeKey) {
      continue
    }
    for (let si = 0; si < it.selectors.length; si++) {
      if (isSameSelectorSlot(it.selectors[si], sel, routeKey)) {
        return it
      }
    }
  }
  return null
}

/**
 * structPath 命中多个元素时消歧：WeakRef > 中文 textContent > 复合块 innerHTML 指纹
 */
function disambiguateElementMatches( matches: DomNode[], sel: SelectorSlot, item: EngineItem | null) {
  if (!matches || !matches.length) {
    return null
  }
  if (matches.length === 1) {
    return matches[0]
  }
  if (sel && sel.nodeRef && hasWeakRef) {
    const ref = (sel.nodeRef as WeakNodeRef).deref()
    if (ref && isNodeConnected(ref)) {
      for (let mi = 0; mi < matches.length; mi++) {
        if (matches[mi] === ref) {
          return matches[mi]
        }
      }
    }
  }
  if (!item) {
    return null
  }
  const hint = (item.chinese || '').trim()
  if (hint) {
    for (let mi = 0; mi < matches.length; mi++) {
      const text = (matches[mi].textContent || '').trim()
      if (text === hint) {
        return matches[mi]
      }
    }
  }
  if (item.composite && item.fullChinese) {
    const fullNorm = normalizeCompositeHtml(item.fullChinese)
    for (let mi = 0; mi < matches.length; mi++) {
      const innerNorm = normalizeCompositeHtml(matches[mi].innerHTML || '')
      if (innerNorm === fullNorm) {
        return matches[mi]
      }
      if (item.nodeTranslate && innerNorm === normalizeCompositeHtml(item.nodeTranslate)) {
        return matches[mi]
      }
    }
  }
  return null
}

function querySelectorChildNode(path: string, index: number, item: EngineItem | null) {
  if (!path || index < 0) {
    return null
  }
  const parents = querySelectorAllSafe(path)
  if (!parents.length) {
    return null
  }
  const hint = item && item.chinese ? String(item.chinese).trim() : ''
  const fullHint = item && item.fullChinese ? String(item.fullChinese).trim() : ''
  const translateHint = item && item.nodeTranslate ? String(item.nodeTranslate).trim() : ''
  for (let pi = 0; pi < parents.length; pi++) {
    const el = parents[pi]
    const node = el.childNodes[index]
    if (!node || !isNodeConnected(node)) {
      continue
    }
    if (hint || fullHint || translateHint) {
      const current = getNodeText(node)
      const trimmed = current.trim()
      if (trimmed === hint || current === fullHint) {
        return node
      }
      // 倒计时等「仅数字变化」场景：框架整体替换文本节点后位置不变、文案只差数字，
      // 仍视为同一条目，避免槽位被 pruneStaleSelectors 剔除后重复请求
      if (hint && isNumericOnlyChange(trimmed, hint)) {
        return node
      }
      if (translateHint && (trimmed === translateHint || current === item!.nodeTranslate)) {
        return node
      }
      continue
    }
    return node
  }
  if (!hint && !fullHint && !translateHint) {
    const node = parents[0].childNodes[index]
    return node && isNodeConnected(node) ? node : null
  }
  return null
}

export function refreshSelectorNodeRef( sel: SelectorSlot, node: DomNode) {
  if (hasWeakRef && node) {
    sel.nodeRef = new WeakRef(node)
  }
}

/** 解析 selector 对应节点：WeakRef -> 结构路径（不含 class），成功后规范化 path 并刷新 nodeRef */
export function resolveSelectorNode( sel: SelectorSlot) {
  if (sel.nodeRef && hasWeakRef) {
    const ref = (sel.nodeRef as WeakNodeRef).deref()
    if (ref && isNodeConnected(ref)) {
      return ref
    }
  }
  const structPath = sel.structPath || stripClassesFromSelectorPath(sel.path)
  if (!structPath) {
    return null
  }
  const item = findItemBySelectorSlot(sel)

  if (sel.composite) {
    const matches = querySelectorAllSafe(structPath)
    const el = disambiguateElementMatches(matches, sel, item)
    if (el && isNodeConnected(el) && el.nodeType === Node.ELEMENT_NODE) {
      sel.path = structPath
      sel.structPath = structPath
      refreshSelectorNodeRef(sel, el)
      return el
    }
    return null
  }

  const node = querySelectorChildNode(structPath, sel.index as number, item)
  if (node) {
    sel.path = structPath
    sel.structPath = structPath
    refreshSelectorNodeRef(sel, node)
    return node
  }
  return null
}

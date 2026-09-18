/**
 * 复合块结构解析与选择器
 *
 * 由 ai-translate-engine.js 拆分而来（原 L742-L923），函数体保持原样，仅补类型与导入导出。
 */
import type { CompositeSegment, DomNode } from './types';
import { countTranslatableUnitsInComposite } from './composite';
import { hasBlockElementInSubtree, hasChinese, hasTranslateSkipAncestor, isInlineTagName, isMediaFilterTag } from './lang';
import { isEmptyPlaceholderHtml } from './markup';
import { containsMediaInSubtree, isMediaPlaceholderElement } from './media';
import { buildSelectorPart, escapeCssClass } from './selector';
import { SKIP_SCAN_TAGS } from './state';

/** 块容器直接子级含直接文本并与行内元素混排时作复合块（避免 countdown 等被拆成多段请求）；仅多个行内子元素、无直接文本时不合并 */
export function isInlineCompositeRoot( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false
  }
  const tag = el.tagName.toLowerCase()
  if (SKIP_SCAN_TAGS.indexOf(tag) !== -1 || ['input', 'textarea', 'select', 'option', 'title'].indexOf(tag) !== -1) {
    return false
  }
  if (hasTranslateSkipAncestor(el)) {
    return false
  }
  if (!hasChinese(el.textContent || '')) {
    return false
  }
  let inlineChildCount = 0
  let hasDirectText = false
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.nodeValue || '').trim()) {
        hasDirectText = true
      }
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return false
    }
    const childTag = (child as DomNode).tagName.toLowerCase()
    if (isMediaFilterTag(childTag)) {
      continue
    }
    if (!isInlineTagName(childTag)) {
      return false
    }
    if (hasBlockElementInSubtree(child)) {
      return false
    }
    inlineChildCount++
  }
  if (inlineChildCount < 1 && !containsMediaInSubtree(el)) {
    return false
  }
  // 媒体仅包裹单个行内/文本时拆段翻译，不整段 composite（如 svg+span+svg）
  if (inlineChildCount === 1 && !hasDirectText && containsMediaInSubtree(el)) {
    return false
  }
  // 图标/empty 占位 span + 单段文案 span（搜索框 placeholder）不合并为复合块
  if (!hasDirectText && containsMediaInSubtree(el) && countTranslatableUnitsInComposite(el) <= 1) {
    return false
  }
  // 无直接文本时多个行内标签（如 div>a+a）各自独立翻译，不合并为一条 composite
  return hasDirectText || containsMediaInSubtree(el)
}

/** 文本节点若属于行内复合块，返回该块根元素 */
export function getInlineCompositeRoot( node: DomNode) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node
  if (!el) {
    return null
  }
  if (el.nodeType === Node.ELEMENT_NODE && isInlineTagName(el.tagName)) {
    if (hasBlockElementInSubtree(el)) {
      return null
    }
    if (isInlineCompositeRoot(el)) {
      return el
    }
    el = el.parentElement
  }
  if (el && isInlineCompositeRoot(el)) {
    return el
  }
  return null
}

export function normalizeCompositeHtml( html: string) {
  return String(html || '').replace(/\s+/g, ' ').trim()
}

/** 为容器元素生成唯一 CSS 路径（path 指向元素本身，非其子文本节点） */
function getElementSelector( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return {path: '', structPath: ''}
  }
  if (el.id) {
    const idPath = '#' + escapeCssClass(el.id)
    return {path: idPath, structPath: idPath}
  }
  const parts = []
  let current = el
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    parts.unshift(buildSelectorPart(current, current.parentElement))
    const selector = parts.join(' > ')
    if (document.querySelectorAll(selector).length === 1) {
      return {path: selector, structPath: selector}
    }
    current = current.parentElement
  }
  const path = parts.join(' > ')
  return {path: path, structPath: path}
}

export function getCompositeSelector( el: DomNode) {
  const base = getElementSelector(el)
  return {
    path: base.path,
    structPath: base.structPath,
    index: -1,
    composite: true,
  }
}

/** 按子节点顺序提取文本段与行内元素段（保留 DOM 引用，回写时不替换元素） */
export function serializeCompositeStructure( el: DomNode) {
  const segments: CompositeSegment[] = []
  if (!el) {
    return segments
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === Node.TEXT_NODE) {
      segments.push({type: 'text', node: child})
    } else if (child.nodeType === Node.ELEMENT_NODE && isInlineTagName((child as DomNode).tagName)) {
      segments.push({type: 'inline', el: child})
    } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag((child as DomNode).tagName)) {
      segments.push({type: 'media', el: child})
    }
  }
  return segments
}

/** 将 innerHTML 解析为与 serializeCompositeStructure 对齐的段列表 */
export function parseCompositeHtml( html: string) {
  const segments: CompositeSegment[] = []
  if (!html) {
    return segments
  }
  let doc
  try {
    doc = new DOMParser().parseFromString('<div id="__ai_tr_wrap__">' + html + '</div>', 'text/html')
  } catch (e) {
    return segments
  }
  const wrap = doc.getElementById('__ai_tr_wrap__')
  if (!wrap) {
    return segments
  }
  for (let i = 0; i < wrap.childNodes.length; i++) {
    const child = wrap.childNodes[i]
    if (child.nodeType === Node.TEXT_NODE) {
      const val = child.nodeValue || ''
      if (isEmptyPlaceholderHtml(val.trim())) {
        continue
      }
      segments.push({type: 'text', value: val})
    } else if (isMediaPlaceholderElement(child)) {
      continue
    } else if (child.nodeType === Node.ELEMENT_NODE && isInlineTagName((child as DomNode).tagName)) {
      segments.push({type: 'inline', inner: (child as DomNode).innerHTML})
    } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag((child as DomNode).tagName)) {
      segments.push({type: 'media', inner: (child as DomNode).outerHTML})
    }
  }
  return segments
}

export function stripInlineHtml( html: string) {
  return String(html || '').replace(/<[^>]+>/g, '')
}

export function setInlineElementContent( el: DomNode, inner: string) {
  if (!el) {
    return
  }
  if (!el.children.length) {
    el.textContent = stripInlineHtml(inner)
    return
  }
  el.innerHTML = inner
}

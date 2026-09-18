/**
 * 空占位符与节点序列化
 *
 * 由 ai-translate-engine.js 拆分而来（原 L236-L350），函数体保持原样，仅补类型与导入导出。
 */
import { serializeCompositeStructure } from './composite-dom';
import { collectCompositeChineseTexts, inlineElementHasMedia } from './composite';
import { buildMediaPlaceholder, hasChinese, isInlineTagName, isMediaFilterTag } from './lang';
import { getMediaOuterHtml, isMediaPlaceholderText } from './media';
import type { DomNode, RequestMap } from './types';

export const EMPTY_PLACEHOLDER_RE = /<empty\s+index\s*=\s*["']?\d+["']?\s*(?:\/>|>[\s\S]*?<\/empty>)/gi

export function isEmptyPlaceholderHtml( str: string) {
  return isMediaPlaceholderText(str)
}

/** 去掉请求串首尾仅作占位的 empty，避免 svg+文案+svg 整段发给接口 */
export function trimEdgeEmptyPlaceholders( html: string) {
  if (!html) {
    return ''
  }
  let work = html
  work = work.replace(/^(\s*<empty\s+index\s*=\s*["']?\d+["']?\s*\/?>\s*)+/gi, '')
  work = work.replace(/(\s*<empty\s+index\s*=\s*["']?\d+["']?\s*\/?>\s*)+$/gi, '')
  return work
}

/** 将译文/HTML 中成对 empty 规范为自闭合，便于剥离 */
export function normalizeEmptyPlaceholdersInHtml( html: string) {
  if (!html) {
    return ''
  }
  return String(html).replace(/<empty\s+index\s*=\s*["']?(\d+)["']?\s*>\s*<\/empty>/gi, function (_m, idx) {
    return buildMediaPlaceholder(idx)
  })
}

function getElementOpenTag( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  const html = el.outerHTML || ''
  const m = html.match(/^<[^>]+\/>|^<[^>]+>/)
  return m ? m[0] : '<' + el.tagName.toLowerCase() + '>'
}

/** 按 DOM 子节点顺序序列化请求 HTML，媒体替换为自闭合 empty */
export function serializeChildNodesForRequest( parentEl: DomNode, map: RequestMap, idxRef: { value: number }) {
  if (!parentEl) {
    return ''
  }
  let html = ''
  for (let i = 0; i < parentEl.childNodes.length; i++) {
    const child = parentEl.childNodes[i]
    if (child.nodeType === Node.TEXT_NODE) {
      html += child.nodeValue || ''
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue
    }
    const tag = child.tagName.toLowerCase()
    if (isMediaFilterTag(tag)) {
      const key = String(idxRef.value++)
      map[key] = getMediaOuterHtml(child)
      html += buildMediaPlaceholder(key)
      continue
    }
    if (isInlineTagName(tag)) {
      html += serializeInlineElementForRequest(child, map, idxRef)
    }
  }
  return html
}

function serializeInlineElementForRequest( el: DomNode, map: RequestMap, idxRef: { value: number }) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  if (!inlineElementHasMedia(el)) {
    return el.outerHTML || ''
  }
  const tag = el.tagName.toLowerCase()
  const openTag = getElementOpenTag(el)
  const inner = serializeChildNodesForRequest(el, map, idxRef)
  if (openTag.endsWith('/>')) {
    return openTag
  }
  return openTag + inner + '</' + tag + '>'
}

/** 媒体/empty 占位与单段中文混排时，请求只发纯文本（如图标 span + 文案 span） */
export function refineCompositeRequestText( html: string, el: DomNode) {
  let work = trimEdgeEmptyPlaceholders(html)
  if (!el) {
    return work
  }
  const chineseTexts = collectCompositeChineseTexts(el)
  if (chineseTexts.length === 1) {
    return chineseTexts[0]
  }
  const segments = serializeCompositeStructure(el)
  const translatable = segments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
  const hasDirectText = segments.some(function (s) {
    return s.type === 'text' && (s.node.nodeValue || '').trim()
  })
  if (translatable.length !== 1 || hasDirectText) {
    return work
  }
  const sole = translatable[0]
  if (sole.type === 'inline' && sole.el && !inlineElementHasMedia(sole.el) && !sole.el.children.length) {
    const text = (sole.el.textContent || '').trim()
    if (text && hasChinese(text)) {
      return text
    }
  }
  if (sole.type === 'text' && sole.node) {
    const text = (sole.node.nodeValue || '').trim()
    if (text && hasChinese(text)) {
      return text
    }
  }
  return work
}

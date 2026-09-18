/**
 * 媒体占位符与 HTML 清理
 *
 * 由 ai-translate-engine.js 拆分而来（原 L351-L539），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode, RequestMap } from './types';
import { collectCompositeChineseTexts } from './composite';
import { buildMediaPlaceholder, hasChinese } from './lang';
import { EMPTY_PLACEHOLDER_RE, normalizeEmptyPlaceholdersInHtml, refineCompositeRequestText, serializeChildNodesForRequest, trimEdgeEmptyPlaceholders } from './markup';
import { MEDIA_FILTER_TAGS } from './state';

export function isMediaPlaceholderElement( el: DomNode) {
  return !!(el && el.nodeType === Node.ELEMENT_NODE &&
      el.tagName.toLowerCase() === 'empty' &&
      el.hasAttribute('index'))
}

export function isMediaPlaceholderText( val: string) {
  const t = String(val || '').trim()
  if (/^\{\{ai-tr-media:\d+\}\}$/.test(t)) {
    return true
  }
  return /^<empty\s+index\s*=\s*["']?\d+["']?\s*(?:\/>|>[\s\S]*<\/empty>)$/i.test(t)
}

export function containsMediaInSubtree( el: DomNode) {
  if (!el || !el.querySelector) {
    return false
  }
  for (let i = 0; i < MEDIA_FILTER_TAGS.length; i++) {
    if (el.querySelector(MEDIA_FILTER_TAGS[i])) {
      return true
    }
  }
  return false
}

export function normalizeMediaHtml( html: string) {
  if (!html || html.indexOf('&lt;') === -1) {
    return html || ''
  }
  const ta = document.createElement('textarea')
  ta.innerHTML = html
  return ta.value
}

export function getMediaOuterHtml( node: DomNode) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'svg' && typeof XMLSerializer !== 'undefined') {
    try {
      return normalizeMediaHtml(new XMLSerializer().serializeToString(node))
    } catch (e) {
      // fall through
    }
  }
  return normalizeMediaHtml(node.outerHTML || '')
}

/** 从 HTML 字符串中按标签平衡匹配并替换（避免 DOMParser 把 svg 转成 &lt;svg&gt;） */
function replaceMediaTagsInHtml(html: string, tagName: string, onMatch: (html: string) => string): string {
  if (!html) {
    return html
  }
  const tag = tagName.toLowerCase()
  if (tag === 'img') {
    return html.replace(/<img\b[^>]*\/?>/gi, function (matched) {
      return onMatch(matched)
    })
  }
  let result = ''
  let pos = 0
  const openRe = new RegExp('<' + tag + '(\\s[^>]*)?>', 'gi')
  while (pos < html.length) {
    openRe.lastIndex = pos
    const m = openRe.exec(html)
    if (!m) {
      result += html.slice(pos)
      break
    }
    result += html.slice(pos, m.index)
    const openStart = m.index
    const openEnd = m.index + m[0].length
    if (/\/>\s*$/.test(m[0])) {
      result += onMatch(html.slice(openStart, openEnd))
      pos = openEnd
      continue
    }
    let depth = 1
    let scan = openEnd
    let closeEnd = -1
    while (depth > 0 && scan < html.length) {
      const slice = html.slice(scan)
      const openMatch = slice.match(new RegExp('<' + tag + '(\\s[^>]*)?>', 'i'))
      const closeMatch = slice.match(new RegExp('</' + tag + '\\s*>', 'i'))
      if (!closeMatch) {
        break
      }
      const closeIdx = scan + (closeMatch.index as number)
      const openIdx = openMatch ? scan + (openMatch.index as number) : -1
      if (openMatch && openIdx < closeIdx) {
        depth++
        scan = openIdx + openMatch[0].length
      } else {
        depth--
        closeEnd = closeIdx + closeMatch[0].length
        scan = closeEnd
      }
    }
    if (closeEnd === -1) {
      result += html.slice(openStart, openEnd)
      pos = openEnd
    } else {
      result += onMatch(html.slice(openStart, closeEnd))
      pos = closeEnd
    }
  }
  return result
}

/** 从 live DOM 序列化媒体 map，empty 统一为自闭合标签 */
export function stripMediaFromCompositeElement( el: DomNode) {
  if (!el) {
    return {html: '', map: {}}
  }
  const map: RequestMap = {}
  const idxRef = {value: 0}
  const html = serializeChildNodesForRequest(el, map, idxRef)
  return {html: refineCompositeRequestText(html, el), map: map}
}

/** 将 html 中的 svg/img 等替换为占位符，避免整段发给翻译接口 */
export function stripMediaFromCompositeHtml( html: string) {
  if (!html || html.indexOf('<') === -1) {
    return {html: html || '', map: {}}
  }
  const map: RequestMap = {}
  let idx = 0
  let result = normalizeEmptyPlaceholdersInHtml(html)
  for (let mi = 0; mi < MEDIA_FILTER_TAGS.length; mi++) {
    const tag = MEDIA_FILTER_TAGS[mi]
    result = replaceMediaTagsInHtml(result, tag, function (matched) {
      const key = String(idx++)
      map[key] = normalizeMediaHtml(matched)
      return buildMediaPlaceholder(key)
    })
  }
  result = trimEdgeEmptyPlaceholders(result)
  const plain = extractPlainRequestFromCompositeHtml(result)
  if (plain) {
    result = plain
  }
  return {html: result, map: map}
}

/** 从已剥离媒体的 composite HTML 中提取唯一中文纯文本（无 live DOM 时） */
function extractPlainRequestFromCompositeHtml( html: string) {
  if (!html) {
    return ''
  }
  const cleaned = stripTranslationHtmlForApply(html)
  if (!/[<>]/.test(cleaned)) {
    const t = cleaned.trim()
    return t && hasChinese(t) ? t : ''
  }
  try {
    const doc = new DOMParser().parseFromString('<div id="__ai_tr_wrap__">' + cleaned + '</div>', 'text/html')
    const wrap = doc.getElementById('__ai_tr_wrap__')
    if (wrap) {
      const texts = collectCompositeChineseTexts(wrap)
      if (texts.length === 1) {
        return texts[0]
      }
    }
  } catch (e) {
    // fall through
  }
  return ''
}

/** 回显用：去掉 empty 占位符及译文里可能出现的媒体 markup（live DOM 已保留原 svg/img） */
export function stripTranslationHtmlForApply( html: string) {
  if (!html) {
    return ''
  }
  let work = normalizeEmptyPlaceholdersInHtml(html)
  work = work.replace(EMPTY_PLACEHOLDER_RE, '')
  work = work.replace(/<empty\s+index\s*=\s*["']?\d+["']?\s*>/gi, '')
  work = work.replace(/<\/empty\s*>/gi, '')
  work = work.replace(/\{\{ai-tr-media:\d+\}\}/g, '')
  for (let mi = 0; mi < MEDIA_FILTER_TAGS.length; mi++) {
    work = replaceMediaTagsInHtml(work, MEDIA_FILTER_TAGS[mi], function () {
      return ''
    })
  }
  return work
}

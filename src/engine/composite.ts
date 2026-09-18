/**
 * 复合块请求文本与可译单元
 *
 * 由 ai-translate-engine.js 拆分而来（原 L540-L741），函数体保持原样，仅补类型与导入导出。
 */
import type { CompositeSegment, DomNode, EngineItem } from './types';
import { serializeCompositeStructure, setInlineElementContent, stripInlineHtml } from './composite-dom';
import { hasChinese, isInlineTagName, isMediaFilterTag } from './lang';
import { runWithoutDomObserver } from './lifecycle';
import { containsMediaInSubtree, isMediaPlaceholderElement, normalizeMediaHtml, stripMediaFromCompositeElement, stripMediaFromCompositeHtml, stripTranslationHtmlForApply } from './media';

export function compositeElHasPreservedMedia( el: DomNode) {
  if (!el) {
    return false
  }
  if (containsMediaInSubtree(el)) {
    return true
  }
  return serializeCompositeStructure(el).some(function (s) {
    return s.type === 'media'
  })
}

export function getCompositeTranslateTextFingerprint( html: string) {
  const cleaned = stripTranslationHtmlForApply(html || '')
  const parts = extractTranslatableTextParts(cleaned)
  if (parts.length) {
    return parts.join('').replace(/\s+/g, ' ').trim()
  }
  return stripInlineHtml(cleaned).replace(/\s+/g, ' ').trim()
}

export function assignCompositeRequestMeta( item: EngineItem, fullChinese: string, el?: DomNode) {
  if (!item) {
    return
  }
  const stripped = el && el.cloneNode
      ? stripMediaFromCompositeElement(el)
      : stripMediaFromCompositeHtml(fullChinese || '')
  item.mediaPlaceholderMap = stripped.map
  item.requestText = stripped.html
  // 记录 requestText 对应的原文：原文一旦变化（列表复用、tab 切换等）必须重算，
  // 否则会一直拿旧文案去请求，接口返回的也是旧译文（表现为“切换后第一项不更新”）
  item.requestTextSource = fullChinese || ''
}

export function getCompositeRequestText( item: EngineItem) {
  if (!item) {
    return ''
  }
  // requestText 只是 fullChinese 的派生缓存，必须与当前原文一致才可复用
  if (item.requestText && item.requestTextSource === (item.fullChinese || '')) {
    return item.requestText
  }
  if (item.fullChinese) {
    assignCompositeRequestMeta(item, item.fullChinese)
    return item.requestText || item.fullChinese
  }
  return item.requestText || item.chinese || ''
}

export function inlineElementHasMedia( el: DomNode) {
  if (!el) {
    return false
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (isMediaFilterTag(child.tagName)) {
        return true
      }
      if (isMediaPlaceholderElement(child)) {
        return true
      }
    }
  }
  return false
}

/** 复合块 direct child 中含中文的待译单元数（直接文本 + 含中文的行内子元素） */
export function countTranslatableUnitsInComposite( el: DomNode) {
  if (!el) {
    return 0
  }
  let count = 0
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.nodeValue || '').trim()
      if (t && hasChinese(t)) {
        count++
      }
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue
    }
    const childTag = child.tagName.toLowerCase()
    if (isMediaFilterTag(childTag)) {
      continue
    }
    if (isInlineTagName(childTag)) {
      const t = (child.textContent || '').trim()
      if (t && hasChinese(t)) {
        count++
      }
    }
  }
  return count
}

/**
 * 复合块中「唯一含中文的直接子级」：直接文本节点或行内子元素。
 * 与 refineCompositeRequestText 的「只有一个含中文片段时只请求那一段」保持一致，
 * 回写时据此定位真正被翻译的那一段（多于一个含中文段或无中文段时返回 null）。
 */
export function findSoleChineseUnit( segments: CompositeSegment[]) {
  let unit = null
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si]
    let t = ''
    if (s.type === 'text' && s.node) {
      t = (s.node.nodeValue || '').trim()
    } else if (s.type === 'inline' && s.el) {
      t = (s.el.textContent || '').trim()
    } else {
      continue
    }
    if (!t || !hasChinese(t)) {
      continue
    }
    if (unit) {
      return null
    }
    unit = s
  }
  return unit
}

/** 从复合块 DOM 收集各段中文（去重保序） */
export function collectCompositeChineseTexts( el: DomNode) {
  const texts: string[] = []
  const seen: Record<string, boolean> = {}
  if (!el) {
    return texts
  }
  const segments = serializeCompositeStructure(el)
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si]
    let t = ''
    if (s.type === 'text' && s.node) {
      t = (s.node.nodeValue || '').trim()
    } else if (s.type === 'inline' && s.el) {
      t = (s.el.textContent || '').trim()
    }
    if (t && hasChinese(t) && !seen[t]) {
      seen[t] = true
      texts.push(t)
    }
  }
  return texts
}

function extractTranslatableTextParts( html: string) {
  if (!html) {
    return []
  }
  let work = stripTranslationHtmlForApply(html)
  work = work.replace(/<[^>]+>/g, '')
  work = normalizeMediaHtml(work)
  return work ? [work] : []
}

/** 行内元素含 svg/img 时只更新文本节点，不替换媒体节点 */
export function applyInlineInnerTranslation( el: DomNode, innerHtml: string) {
  if (!inlineElementHasMedia(el)) {
    setInlineElementContent(el, stripTranslationHtmlForApply(innerHtml || ''))
    return
  }
  const textParts = extractTranslatableTextParts(innerHtml || '')
  let partIdx = 0
  runWithoutDomObserver(function () {
    let lastNode = null
    for (let i = 0; i < el.childNodes.length; i++) {
      const child = el.childNodes[i]
      if (child.nodeType === Node.TEXT_NODE) {
        const val = partIdx < textParts.length ? textParts[partIdx++] : ''
        if (child.nodeValue !== val) {
          child.nodeValue = val
        }
        lastNode = child
      } else if (child.nodeType === Node.ELEMENT_NODE && isMediaFilterTag(child.tagName)) {
        lastNode = child
      }
    }
    while (partIdx < textParts.length) {
      const rest = textParts.slice(partIdx).join('')
      partIdx = textParts.length
      if (!rest) {
        break
      }
      if (lastNode && lastNode.nextSibling && lastNode.nextSibling.nodeType === Node.TEXT_NODE) {
        lastNode.nextSibling.nodeValue = rest
        lastNode = lastNode.nextSibling
      } else {
        const textNode = document.createTextNode(rest)
        el.insertBefore(textNode, lastNode ? lastNode.nextSibling : null)
        lastNode = textNode
      }
    }
  })
}

/**
 * 复合块写回/回滚
 *
 * 由 ai-translate-engine.js 拆分而来（原 L924-L1330），函数体保持原样，仅补类型与导入导出。
 */
import type { CompositeSegment, DomNode, EngineItem } from './types';
import { getNodeDataMap, getRouteKey } from './cache';
import { normalizeCompositeHtml, parseCompositeHtml, serializeCompositeStructure, setInlineElementContent, stripInlineHtml } from './composite-dom';
import { applyInlineInnerTranslation, compositeElHasPreservedMedia, findSoleChineseUnit, getCompositeTranslateTextFingerprint, inlineElementHasMedia } from './composite';
import { hasChinese } from './lang';
import { getExpectedTranslate, runWithoutDomObserver } from './lifecycle';
import { isMediaPlaceholderText, stripTranslationHtmlForApply } from './media';
import { rememberSubtreeOriginals } from './original';
import { isValidTranslationText } from './parser';
import { resolveSelectorNode } from './selector';
import { resolveItemByTranslatedText } from './write';

/** 按段对齐后写回：只改文本节点 nodeValue 与行内元素内容，不替换行内元素本身 */
function applyCompositeSegmentsToDom( domSegments: CompositeSegment[], htmlSegments: CompositeSegment[]) {
  const domParts = domSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
  const htmlParts = htmlSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
  if (!domParts.length || domParts.length !== htmlParts.length) {
    return false
  }
  for (let i = 0; i < domParts.length; i++) {
    if (domParts[i].type !== htmlParts[i].type) {
      return false
    }
  }
  let applied = false
  runWithoutDomObserver(function () {
    for (let i = 0; i < domParts.length; i++) {
      const d = domParts[i]
      const t = htmlParts[i]
      if (d.type === 'text' && d.node) {
        const nextVal = t.value != null ? t.value : ''
        if (d.node.nodeValue !== nextVal) {
          d.node.nodeValue = nextVal
          applied = true
        }
      } else if (d.type === 'inline' && d.el) {
        const nextInner = stripTranslationHtmlForApply(t.inner != null ? t.inner : '')
        if (inlineElementHasMedia(d.el)) {
          applyInlineInnerTranslation(d.el, nextInner)
          applied = true
        } else if (!d.el.children.length) {
          const plain = stripInlineHtml(nextInner)
          if (d.el.textContent !== plain) {
            d.el.textContent = plain
            applied = true
          }
        } else if (d.el.innerHTML !== nextInner) {
          setInlineElementContent(d.el, nextInner)
          applied = true
        }
      }
    }
  })
  return applied
}

/**
 * 译文与原 DOM 段顺序不一致时的回写（如 原文 span+文本，译文 文本+span+文本）
 * 按译文顺序复用已有 text/inline 节点并重排 direct child，避免前缀文案被后缀覆盖
 */
function applyCompositeSegmentsFlexible( el: DomNode, domSegments: CompositeSegment[], htmlSegments: CompositeSegment[]) {
  const htmlParts = htmlSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
  const domParts = domSegments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
  if (!htmlParts.length || !domParts.length) {
    return false
  }

  if (htmlParts.length === 1 && htmlParts[0].type === 'text' && domParts.length > 1) {
    const val = htmlParts[0].value != null ? htmlParts[0].value : ''
    if (val && !isMediaPlaceholderText(val)) {
      const firstText = domParts.find(function (s) { return s.type === 'text' && s.node })
      if (firstText) {
        runWithoutDomObserver(function () {
          if (firstText.node.nodeValue !== val) {
            firstText.node.nodeValue = val
          }
        })
        return true
      }
    }
  }

  const inlinePool = domParts.filter(function (s) { return s.type === 'inline' && s.el }).map(function (s) { return s.el })
  const textPool = domParts.filter(function (s) { return s.type === 'text' && s.node }).map(function (s) { return s.node })
  let inlineIdx = 0
  let textIdx = 0
  const orderedNodes: DomNode[] = []
  let applied = false

  function writeInlineContent( targetEl: DomNode, nextInner: string) {
    const plain = stripInlineHtml(nextInner)
    if (!targetEl.children.length) {
      if (targetEl.textContent !== plain) {
        targetEl.textContent = plain
        return true
      }
      return false
    }
    if (inlineElementHasMedia(targetEl)) {
      applyInlineInnerTranslation(targetEl, nextInner)
      return true
    }
    if (targetEl.innerHTML !== nextInner) {
      setInlineElementContent(targetEl, nextInner)
      return true
    }
    return false
  }

  runWithoutDomObserver(function () {
    for (let pi = 0; pi < htmlParts.length; pi++) {
      const part = htmlParts[pi]
      if (part.type === 'inline') {
        const targetEl = inlinePool[inlineIdx++]
        if (!targetEl) {
          continue
        }
        const nextInner = stripTranslationHtmlForApply(part.inner != null ? part.inner : '')
        if (writeInlineContent(targetEl, nextInner)) {
          applied = true
        }
        orderedNodes.push(targetEl)
      } else if (part.type === 'text') {
        const val = part.value != null ? part.value : ''
        if (!val || isMediaPlaceholderText(val)) {
          continue
        }
        let textNode = textPool[textIdx++]
        if (textNode) {
          if (textNode.nodeValue !== val) {
            textNode.nodeValue = val
            applied = true
          }
        } else {
          textNode = document.createTextNode(val)
          applied = true
        }
        orderedNodes.push(textNode)
      }
    }

    if (orderedNodes.length) {
      for (let oi = 0; oi < orderedNodes.length; oi++) {
        el.appendChild(orderedNodes[oi])
      }
    }

    while (inlineIdx < inlinePool.length) {
      const unusedEl = inlinePool[inlineIdx++]
      if (unusedEl && (unusedEl.textContent || '') !== '') {
        unusedEl.textContent = ''
        applied = true
      }
    }
    while (textIdx < textPool.length) {
      const unusedNode = textPool[textIdx++]
      if (unusedNode && (unusedNode.nodeValue || '') !== '') {
        unusedNode.nodeValue = ''
        applied = true
      }
    }
  })

  return applied
}

function applyCompositeHtmlToElement( el: DomNode, html: string) {
  if (!el || html == null) {
    return false
  }
  const resolvedHtml = stripTranslationHtmlForApply(html)
  if (!resolvedHtml) {
    return false
  }
  // 复合块回写前记录子树各文本节点的原始文案（回滚按记录还原，避免条目被复用改写后写错原文）
  rememberSubtreeOriginals(el)
  const plainTranslation = !/[<>]/.test(resolvedHtml)
  if (plainTranslation) {
    const segments = serializeCompositeStructure(el)
    const translatable = segments.filter(function (s) { return s.type === 'text' || s.type === 'inline' })
    const hasDirectText = segments.some(function (s) {
      return s.type === 'text' && (s.node.nodeValue || '').trim()
    })
    if (translatable.length === 1 && !hasDirectText) {
      const sole = translatable[0]
      let applied = false
      runWithoutDomObserver(function () {
        if (sole.type === 'inline' && sole.el) {
          if (inlineElementHasMedia(sole.el)) {
            applyInlineInnerTranslation(sole.el, resolvedHtml)
          } else if (!sole.el.children.length) {
            if (sole.el.textContent !== resolvedHtml) {
              sole.el.textContent = resolvedHtml
            }
          } else {
            setInlineElementContent(sole.el, resolvedHtml)
          }
          applied = true
        } else if (sole.type === 'text' && sole.node && sole.node.nodeValue !== resolvedHtml) {
          sole.node.nodeValue = resolvedHtml
          applied = true
        }
      })
      if (applied) {
        return true
      }
    }
    // 请求侧 refineCompositeRequestText 在「只有一个含中文片段」时只请求那一段，
    // 回写必须落到同一段上：它可能是直接文本，也可能是行内子元素
    // （如 <span class="openTime">营业时间</span>&nbsp;&nbsp;10:00-16:30）。
    // 旧实现固定写「第一个非空直接文本」，会把译文覆盖到后面的纯数字文本上（10:00 -> Business Hours），
    // 而真正被翻译的 span 仍是中文。
    const soleChinese = findSoleChineseUnit(segments)
    if (soleChinese && hasDirectText) {
      let applied = false
      runWithoutDomObserver(function () {
        if (soleChinese.type === 'inline' && soleChinese.el) {
          if (inlineElementHasMedia(soleChinese.el)) {
            applyInlineInnerTranslation(soleChinese.el, resolvedHtml)
          } else if (!soleChinese.el.children.length) {
            if (soleChinese.el.textContent !== resolvedHtml) {
              soleChinese.el.textContent = resolvedHtml
            }
          } else {
            setInlineElementContent(soleChinese.el, resolvedHtml)
          }
          applied = true
        } else if (soleChinese.type === 'text' && soleChinese.node) {
          if (soleChinese.node.nodeValue !== resolvedHtml) {
            soleChinese.node.nodeValue = resolvedHtml
            applied = true
          }
        }
      })
      if (applied) {
        return true
      }
    }
  }
  const domSegments = serializeCompositeStructure(el)
  const htmlSegments = parseCompositeHtml(resolvedHtml)
  if (applyCompositeSegmentsToDom(domSegments, htmlSegments)) {
    return true
  }
  return applyCompositeSegmentsFlexible(el, domSegments, htmlSegments)
}

function getCompositeInnerHtml( el: DomNode) {
  return el && el.nodeType === Node.ELEMENT_NODE ? el.innerHTML : ''
}

export function shouldUpdateComposite( el: DomNode, item: EngineItem) {
  if (!el || !item) {
    return false
  }
  const current = getCompositeInnerHtml(el)
  const full = item.fullChinese || ''
  const trans = item.nodeTranslate || ''
  if (normalizeCompositeHtml(current) === normalizeCompositeHtml(full)) {
    return true
  }
  if (trans && (normalizeCompositeHtml(current) === normalizeCompositeHtml(trans) || current === trans)) {
    return false
  }
  if (!hasChinese(el.textContent || '')) {
    return false
  }
  // 旧实现此处直接 return true，会让「疫苗」这类短文案条目写到包含它的兄弟复合块上；
  // 只有元素当前文案与条目登记的原文一致时才允许写入。
  return (el.textContent || '').trim() === (item.chinese || '').trim()
}

export function shouldReverseComposite( el: DomNode, item: EngineItem) {
  if (!el || !item) {
    return false
  }
  const current = getCompositeInnerHtml(el)
  const full = item.fullChinese || ''
  if (normalizeCompositeHtml(current) === normalizeCompositeHtml(full)) {
    return false
  }
  // 已翻译过的复合块：仅当元素当前文案确实是本条目的译文（含倒计时数字变化）时才恢复，
  // 避免把兄弟节点改写成别的中文原文
  if (item.nodeTranslate) {
    const currentText = (el.textContent || '').replace(/\s+/g, ' ').trim()
    const expectedText = getCompositeTranslateTextFingerprint(item.nodeTranslate)
    if (currentText === expectedText ||
        stripDigitsForCompare(currentText) === stripDigitsForCompare(expectedText)) {
      return true
    }
    // 译文只覆盖中文片段（媒体/￥ 等被保留）时，元素整体文案会包含译文指纹：
    // 仅当元素已不含中文时才据此判定为「已译过」，避免命中别的中文原文
    return !!expectedText && !hasChinese(currentText) && currentText.indexOf(expectedText) !== -1
  }
  if (!hasChinese(el.textContent || '')) {
    return true
  }
  // 仍是中文却与原文不同：没有译文记录可依据，不做猜测性回滚
  return false
}

/** 按容器元素或 textContent 查找 composite 条目（切回中文时用） */
export function resolveCompositeItemByElement( el: DomNode) {
  if (!el) {
    return null
  }
  const routeKey = getRouteKey()
  const text = (el.textContent || '').trim()
  const inner = el.innerHTML

  if (text && getNodeDataMap()[text]) {
    const direct = getNodeDataMap()[text]
    if (direct.composite && direct.pathname === routeKey) {
      return direct
    }
  }

  for (let k in getNodeDataMap()) {
    const it = getNodeDataMap()[k]
    if (!it.composite || it.pathname !== routeKey) {
      continue
    }
    if (it.chinese === text) {
      return it
    }
    for (let si = 0; si < it.selectors.length; si++) {
      const sel = it.selectors[si]
      if (!sel.composite) {
        continue
      }
      const node = resolveSelectorNode(sel)
      if (node === el) {
        return it
      }
    }
  }

  const byTranslate = resolveItemByTranslatedText(inner, text)
  if (byTranslate && byTranslate.composite) {
    return byTranslate
  }
  return null
}

export function isCompositeDomSynced( el: DomNode, item: EngineItem) {
  if (!el || !item || !item.nodeTranslate) {
    return false
  }
  const expected = getExpectedTranslate(item)
  if (compositeElHasPreservedMedia(el)) {
    const currentText = (el.textContent || '').replace(/\s+/g, ' ').trim()
    const expectedText = getCompositeTranslateTextFingerprint(expected)
    return currentText === expectedText ||
        stripDigitsForCompare(currentText) === stripDigitsForCompare(expectedText)
  }
  return normalizeCompositeHtml(getCompositeInnerHtml(el)) === normalizeCompositeHtml(expected)
}

export function writeCompositeTranslate( el: DomNode, item: EngineItem) {
  if (!el || !item || !item.nodeTranslate) {
    return false
  }
  if (!isValidTranslationText(item.nodeTranslate, item)) {
    return false
  }
  if (!shouldUpdateComposite(el, item)) {
    return false
  }
  if (isCompositeDomSynced(el, item)) {
    return false
  }
  return applyCompositeHtmlToElement(el, getExpectedTranslate(item))
}

export function writeCompositeRevert( el: DomNode, item: EngineItem) {
  if (!el || !item || !shouldReverseComposite(el, item)) {
    return false
  }
  return applyCompositeHtmlToElement(el, item.fullChinese)
}

function stripDigitsForCompare( text: string) {
  return (text || '').replace(/\d+/g, '#')
}

/** 文案变更是否仅为数字不同（如倒计时 9分34秒 -> 9分33秒） */
export function isNumericOnlyChange( oldText: string, newText: string) {
  if (!oldText || !newText || oldText === newText) {
    return false
  }
  return stripDigitsForCompare(oldText) === stripDigitsForCompare(newText)
}

function buildTranslateSkeleton( translate: string) {
  return (translate || '').replace(/\d+/g, '{{n}}')
}

export function applyTranslateSkeleton( skeleton: string, fullChinese: string) {
  const nums = (fullChinese || '').match(/\d+/g) || []
  let result = skeleton
  for (let i = 0; i < nums.length; i++) {
    const pos = result.indexOf('{{n}}')
    if (pos === -1) {
      break
    }
    result = result.slice(0, pos) + nums[i] + result.slice(pos + 5)
  }
  return result
}

export function syncTranslateSkeleton( item: EngineItem) {
  if (!item || !item.nodeTranslate) {
    return
  }
  if (/\d/.test(item.fullChinese || '')) {
    item.translateSkeleton = buildTranslateSkeleton(item.nodeTranslate)
  }
}

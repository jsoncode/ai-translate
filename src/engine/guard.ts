/**
 * 写入/回滚边界判定
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2330-L2535），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode, EngineItem, SelectorSlot } from './types';
import { getRouteKey } from './cache';
import { normalizeCompositeHtml } from './composite-dom';
import { isCompositeDomSynced, shouldReverseComposite, shouldUpdateComposite, writeCompositeTranslate } from './composite-write';
import { hasChinese } from './lang';
import { getRememberedOriginal } from './original';
import { buildSelectorPart, escapeCssClass, refreshSelectorNodeRef, resolveSelectorNode, stripClassesFromSelectorPath } from './selector';
import { getNodeText } from './viewport';
import { writeTranslateToNode } from './write';

/**
 * 写入译文前校验：仅当节点当前文案「仍像待翻译中文」时才覆盖
 * 避免同一 CSS 选择器命中了别的子节点（如 .count 里的数字、用户已改过的文案）
 */
export function shouldUpdateNode( node: DomNode, item: EngineItem) {
  if (!node) {
    return false
  }
  if (item && item.composite && node.nodeType === Node.ELEMENT_NODE) {
    return shouldUpdateComposite(node, item)
  }
  // 复合块条目也可能挂在纯文本节点上（同一文案被合并成同一条目），此时按纯文本判定
  const current = getNodeText(node)
  const trimmed = current.trim()
  const trimmedChinese = (item.chinese || '').trim()
  const trimmedFull = (item.fullChinese || '').trim()
  const trimmedTranslate = (item.nodeTranslate || '').trim()

  // 节点已空且记录也为空：允许写入（占位类场景）
  if (!trimmed && !trimmedFull) {
    return true
  }
  // 仍是原始中文（trim 或含前后空白的全文）：需要翻译
  if (trimmed === trimmedChinese || trimmed === trimmedFull) {
    return true
  }
  // 旧实现允许「当前文案包含登记的中文子串」时写入，这会让短文案条目污染包含它的兄弟节点；
  // 现已收敛为：只有当前文案精确等于本条目的原文（或已是本条目的译文）时才处理。
  // 已是本条目译文：无需再写（避免写 DOM -> Observer -> 再写 的死循环）
  if (trimmedTranslate && (trimmed === trimmedTranslate || current === item.nodeTranslate)) {
    return false
  }
  // 纯英文/其它文案且并非本条目译文：不写入（防止上一页残留译文刷到本页同名选择器节点）
  if (!hasChinese(trimmed)) {
    return false
  }
  return false
}

/**
 * 切回中文时校验：仅回滚「确认已翻译过」的节点，避免改掉用户手动编辑的内容
 */
export function shouldReverseNode( node: DomNode, item: EngineItem) {
  if (!node) {
    return false
  }
  if (item && item.composite) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return shouldReverseComposite(node, item)
    }
    // 文本槽位：只回滚「位于复合块元素之外」的独立文本节点（同一文案被合并进同一条目的场景，
    // 如 <div class="area">疫苗</div> 与 图标+「疫苗」）。复合块内部的片段文本节点交给元素级回滚，
    // 否则会把整段原文（含后面的数字/时间）写进一个片段里。
    if (!canRevertCompositeTextSlot(node, item)) {
      return false
    }
  }
  // 复合块条目挂在纯文本节点上时同样按纯文本判定：
  // 旧实现只要 item.composite 就 return false，导致该文本节点切回中文时永远停在译文上
  const current = getNodeText(node)
  const trimmed = current.trim()
  const trimmedTranslate = (item.nodeTranslate || '').trim()

  // 当前已是中文：无需回滚
  if (hasChinese(trimmed)) {
    return false
  }
  // 有写入记录：这个节点当前显示的就是我们写进去的译文，直接按记录还原
  // （条目可能已被列表复用改写/迁移，甚至旧条目已被覆盖，都不影响这里）
  if (getRememberedOriginal(node) != null) {
    return true
  }
  // 当前是译文：可恢复为 fullChinese
  if (trimmedTranslate && (trimmed === trimmedTranslate || current === item.nodeTranslate)) {
    return true
  }
  return false
}

/**
 * 复合块条目上的文本槽位能否按纯文本回滚
 * 只有「位于复合块元素之外」的独立文本节点可以（同一文案被合并进同一条目的场景）；
 * 复合块内部的片段文本节点返回 false，交给元素级回滚处理
 */
function canRevertCompositeTextSlot( node: DomNode, item: EngineItem) {
  if (!node || !item || !item.selectors) {
    return false
  }
  let sawCompositeElement = false
  for (let si = 0; si < item.selectors.length; si++) {
    const sel = item.selectors[si]
    if (!sel.composite) {
      continue
    }
    const el = resolveSelectorNode(sel)
    if (!el || el.nodeType !== Node.ELEMENT_NODE) {
      continue
    }
    sawCompositeElement = true
    if (el === node || el.contains(node)) {
      return false
    }
  }
  return sawCompositeElement
}

/**
 * 弹框关闭等场景：React 将 DOM 瞬时还原为中文，但缓存条目仍有译文
 * 此时应回写译文，勿清空 nodeTranslate 或等待防抖扫描
 */
function shouldReapplyCachedTranslation( node: DomNode, item: EngineItem) {
  if (!node || !item || !item.nodeTranslate || item.pathname !== getRouteKey()) {
    return false
  }
  if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
    const text = (node.textContent || '').trim()
    if (!hasChinese(text)) {
      return false
    }
    const chinese = (item.chinese || '').trim()
    if (text !== chinese && normalizeCompositeHtml(node.innerHTML) !== normalizeCompositeHtml(item.fullChinese)) {
      return false
    }
    return !isCompositeDomSynced(node, item)
  }
  const current = getNodeText(node)
  const trimmed = current.trim()
  const trimmedChinese = (item.chinese || '').trim()
  const trimmedFull = (item.fullChinese || '').trim()
  const trimmedTranslate = (item.nodeTranslate || '').trim()
  if (trimmed === trimmedTranslate || current === item.nodeTranslate) {
    return false
  }
  return hasChinese(trimmed) && (
      trimmed === trimmedChinese ||
      trimmed === trimmedFull
  )
}

export function reapplyCachedTranslationIfNeeded( node: DomNode, item: EngineItem) {
  if (!shouldReapplyCachedTranslation(node, item)) {
    return false
  }
  if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
    return writeCompositeTranslate(node, item)
  }
  return writeTranslateToNode(node, item)
}

/**
 * 为文本/placeholder 节点生成定位信息：CSS 结构路径 + 在父元素 childNodes 中的下标
 * 仅用 id / data-* / 标签 + nth-child，不使用 class
 */
export function getShortestSelector( el: DomNode) {
  if (!el) {
    return {path: '', structPath: '', index: -1}
  }
  const index = el.parentElement ? Array.from(el.parentElement.childNodes).indexOf(el) : -1
  const anchor = el.nodeType === Node.TEXT_NODE ? el.parentElement : el

  if (anchor && anchor.id) {
    const idPath = '#' + escapeCssClass(anchor.id)
    return {path: idPath, structPath: idPath, index: index}
  }

  const parts = []
  let current = el.parentElement
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    parts.unshift(buildSelectorPart(current, current.parentElement))
    const selector = parts.join(' > ')
    if (document.querySelectorAll(selector).length === 1) {
      return {path: selector, structPath: selector, index: index}
    }
    current = current.parentElement
  }
  const path = parts.join(' > ')
  return {
    path: path,
    structPath: path,
    index: index,
  }
}

export function isSameSelectorSlot( sel: SelectorSlot, selector: SelectorSlot, routeKey?: string) {
  if (!sel || sel.pathname !== routeKey) {
    return false
  }
  const selPath = sel.structPath || stripClassesFromSelectorPath(sel.path)
  const nextPath = selector.structPath || stripClassesFromSelectorPath(selector.path)
  if (sel.composite || selector.composite) {
    return !!sel.composite && !!selector.composite && selPath === nextPath
  }
  if (sel.index !== selector.index) {
    return false
  }
  return selPath === nextPath
}

export function patchSelectorSlot( sel: SelectorSlot, node: DomNode, selector: SelectorSlot) {
  sel.path = selector.path
  sel.structPath = selector.structPath
  refreshSelectorNodeRef(sel, node)
}

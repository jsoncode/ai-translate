/**
 * 节点写入与回滚
 *
 * 由 ai-translate-engine.js 拆分而来（原 L1614-L1780），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode, EngineItem, SelectorSlot } from './types';
import { getLanguage, getNodeDataMap, getRouteKey } from './cache';
import { normalizeCompositeHtml } from './composite-dom';
import { writeCompositeRevert, writeCompositeTranslate } from './composite-write';
import { shouldReverseNode, shouldUpdateNode } from './guard';
import { getExpectedTranslate, isDomSynced, runWithoutDomObserver } from './lifecycle';
import { getRememberedOriginal, rememberNodeOriginal } from './original';
import { isValidTranslationText } from './parser';
import { runtime } from './state';

/** 按节点当前文案在 nodeDataMap 中查找已有译文条目 */
export function resolveItemByNodeText( raw: string, trimmed: string) {
  const routeKey = getRouteKey()
  if (trimmed && getNodeDataMap()[trimmed]) {
    const direct = getNodeDataMap()[trimmed]
    if (direct.pathname === routeKey) {
      return direct
    }
  }
  for (let k in getNodeDataMap()) {
    const it = getNodeDataMap()[k]
    if (it.pathname !== routeKey) {
      continue
    }
    if (raw && it.fullChinese === raw) {
      return it
    }
    if (trimmed && it.chinese === trimmed) {
      return it
    }
    // 禁止「raw 包含 it.chinese」这类模糊匹配：像「疫苗」这种短文案条目
    // 会把「HPV疫苗」「肺炎疫苗」等兄弟节点全部改写成同一个译文。
    if (it.composite && raw && it.fullChinese && normalizeCompositeHtml(raw) === normalizeCompositeHtml(it.fullChinese)) {
      return it
    }
  }
  return null
}

/** 新建 nodeDataMap 条目（切页后或跨路由同名文案不复用上一页译文） */
export function createNodeDataMapEntry( chinese: string, fullChinese: string, selectorWithPath: SelectorSlot, composite: boolean): EngineItem {
  const entry: EngineItem = {
    key: runtime.nextNodeDataKey++,
    pathname: getRouteKey(),
    chinese,
    fullChinese,
    selectors: [selectorWithPath],
    nodeTranslate: '',
    sourceTranslate: [],
    loading: false,
    error: ''
  }
  if (composite) {
    entry.composite = true
    entry.mediaPlaceholderMap = {}
    entry.requestText = ''
  }
  return entry
}

/** 按节点当前译文在 nodeDataMap 中查找条目（切回中文、虚拟列表回收 DOM 时用） */
export function resolveItemByTranslatedText( raw: string, trimmed: string) {
  if (!trimmed) {
    return null
  }
  const routeKey = getRouteKey()
  for (let k in getNodeDataMap()) {
    const it = getNodeDataMap()[k]
    if (it.pathname !== routeKey || !it.nodeTranslate) {
      continue
    }
    const trimmedTranslate = (it.nodeTranslate || '').trim()
    const expected = getExpectedTranslate(it)
    const trimmedExpected = String(expected).trim()
    if (trimmed === trimmedTranslate || raw === it.nodeTranslate) {
      return it
    }
    if (trimmed === trimmedExpected || raw === expected) {
      return it
    }
    if (it.sourceTranslate && it.sourceTranslate.length) {
      for (let si = 0; si < it.sourceTranslate.length; si++) {
        const st = it.sourceTranslate[si]
        if (trimmed === String(st).trim() || raw === st) {
          return it
        }
      }
    }
    if (it.composite && raw && it.nodeTranslate) {
      if (normalizeCompositeHtml(raw) === normalizeCompositeHtml(it.nodeTranslate)) {
        return it
      }
    }
  }
  return null
}

/** 将节点恢复为中文原文 */
export function writeRevertToNode( node: DomNode, item: EngineItem) {
  if (!node || !item || !shouldReverseNode(node, item)) {
    return false
  }
  if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
    return writeCompositeRevert(node, item)
  }
  // 复合块条目也可能挂在纯文本节点上（同一文案：图标+「疫苗」的复合块 与 <div>疫苗</div> 合并成同一条目）。
  // 这种槽位要按纯文本回滚，且只能写纯文本原文 chinese——fullChinese 里含 innerHTML 标签，写到文本节点会变成可见标签。
  // 优先用"这个节点自己的原始文案记录"：即使条目已被列表/标签页复用改写，也不会写错原文。
  const remembered = getRememberedOriginal(node)
  const revertText = remembered != null
      ? remembered
      : (item.composite
          ? ((item.chinese || '').trim() || item.fullChinese || '')
          : item.fullChinese)
  if (!revertText) {
    return false
  }
  let reverted = false
  runWithoutDomObserver(function () {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue !== revertText) {
        node.nodeValue = revertText
        reverted = true
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase()
      if (['input', 'textarea'].includes(tag)) {
        if (node.placeholder !== revertText) {
          node.placeholder = revertText
          reverted = true
        }
      }
    }
  })
  return reverted
}

/** 将译文写入指定节点（不依赖 CSS 选择器，适用于弹框等新挂载节点） */
export function writeTranslateToNode( node: DomNode, item: EngineItem) {
  if (!node || !item || !item.nodeTranslate) {
    return false
  }
  // 双重保险：写译文只允许在非中文语言下（见 setTextInDom 的说明）
  if (getLanguage() === 'zh') {
    return false
  }
  if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
    return writeCompositeTranslate(node, item)
  }
  if (!isValidTranslationText(item.nodeTranslate, item)) {
    return false
  }
  if (!shouldUpdateNode(node, item)) {
    return false
  }
  if (isDomSynced(node, item)) {
    return false
  }
  // 写之前先记下这个节点当前的原始文案，回滚时按记录精确还原
  rememberNodeOriginal(node)
  const translate = getExpectedTranslate(item)
  let written = false
  runWithoutDomObserver(function () {
    if (node.nodeType === Node.TEXT_NODE) {
      node.nodeValue = translate
      written = true
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase()
      if (['input', 'textarea'].includes(tag)) {
        node.placeholder = translate
        written = true
      }
    }
  })
  return written
}

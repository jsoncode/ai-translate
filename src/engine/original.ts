/**
 * 原文记忆（WeakMap，回滚依据）
 *
 * 由 ai-translate-engine.js 拆分而来（原 L1540-L1613），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { hasChinese } from './lang';
import { runWithoutDomObserver } from './lifecycle';

export const hasWeakRef = typeof WeakRef === 'function'

/**
 * 节点 -> 我们写入译文前的原始文案。
 * 列表/标签页复用同一个 DOM 与同一条选择器路径时，文案会在不同 tab 之间反复变化，
 * 条目会被"就位改写"（chinese/fullChinese 被换成新文案、旧 key 被删除/覆盖），
 * 只按条目记录回滚就可能把别的原文写进这个节点（错乱回显）。
 * 这里按"节点自己当时是什么"记录，回滚时优先用它，做到与条目如何迁移无关。
 */
const nodeOriginalText = typeof WeakMap === 'function' ? new WeakMap() : null

/** 记录写入译文前的原始文案（文本节点/input.placeholder）；观察到新的中文原文时会覆盖旧记录 */
export function rememberNodeOriginal( node: DomNode) {
  if (!nodeOriginalText || !node) {
    return
  }
  let current = ''
  if (node.nodeType === Node.TEXT_NODE) {
    current = node.nodeValue || ''
  } else if (node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') {
      return
    }
    current = node.placeholder || ''
  } else {
    return
  }
  if (!current.trim()) {
    return
  }
  if (hasChinese(current) || !nodeOriginalText.has(node)) {
    nodeOriginalText.set(node, current)
  }
}

/** 记录子树内所有文本节点的原始文案（复合块回写前调用） */
export function rememberSubtreeOriginals( el: DomNode) {
  if (!nodeOriginalText || !el || el.nodeType !== Node.ELEMENT_NODE) {
    return
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    rememberNodeOriginal(walker.currentNode)
  }
}

export function getRememberedOriginal( node: DomNode) {
  return nodeOriginalText && node ? nodeOriginalText.get(node) : undefined
}

/** 按记录还原一个节点的原始文案（文本节点 / input.placeholder） */
export function writeRememberedOriginal( node: DomNode, original: string) {
  if (!node || original == null) {
    return false
  }
  let written = false
  runWithoutDomObserver(function () {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue !== original) {
        node.nodeValue = original
        written = true
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase()
      if ((tag === 'input' || tag === 'textarea') && node.placeholder !== original) {
        node.placeholder = original
        written = true
      }
    }
  })
  return written
}

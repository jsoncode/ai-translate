/**
 * 语言/中文判定与标签判定
 *
 * 由 ai-translate-engine.js 拆分而来（原 L164-L235），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { BLOCK_TAGS, INLINE_TAGS, MEDIA_FILTER_TAGS, SKIP_SCAN_TAGS, runtime } from './state';

/**
 * 当前 URL 是否在后台「AI 翻译」开关允许的应用范围内
 * 依据 sessionStorage.customerConfig.aiTranslate 与 PATH_CODE_MAP 拼正则匹配
 */
/** 当前页面是否开启翻译（插件版完全由配置决定） */
export function isOpenTranslate() {
  return !!(runtime.engineConfig && runtime.engineConfig.enabled)
}

export function hasChinese( str: string | undefined) {
  return /[\u4e00-\u9fa5]/.test(str || '');
}

/** 祖先带 data-translate-skip / data-ai-translate-skip 时跳过采集（用于倒计时数字等） */
export function hasTranslateSkipAncestor( node: DomNode) {
  let el = node
  if (el && el.nodeType === Node.TEXT_NODE) {
    el = el.parentElement
  }
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    if (el.dataset && (el.dataset.translateSkip !== undefined || el.dataset.aiTranslateSkip !== undefined)) {
      return true
    }
    el = el.parentElement
  }
  return false
}

export function isInlineTagName( tag: string) {
  return INLINE_TAGS.indexOf((tag || '').toLowerCase()) !== -1
}

function isBlockTagName( tag: string) {
  return BLOCK_TAGS.indexOf((tag || '').toLowerCase()) !== -1
}

/** 子树中是否含块级元素（a/span 等行内标签内嵌 div 时须拆段翻译） */
export function hasBlockElementInSubtree( el: DomNode) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return false
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue
    }
    const childTag = child.tagName.toLowerCase()
    if (SKIP_SCAN_TAGS.indexOf(childTag) !== -1) {
      continue
    }
    if (isBlockTagName(childTag)) {
      return true
    }
    if (hasBlockElementInSubtree(child)) {
      return true
    }
  }
  return false
}

export function isMediaFilterTag( tag: string) {
  return MEDIA_FILTER_TAGS.indexOf((tag || '').toLowerCase()) !== -1
}

export function buildMediaPlaceholder( key: string | number) {
  return '<empty index="' + key + '"/>'
}

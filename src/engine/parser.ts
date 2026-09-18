/**
 * 流式 [index] 协议解析
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2946-L3069），函数体保持原样，仅补类型与导入导出。
 */
/**
 * 按接口约定解析流式文本：[index] 起至下一个 [index] 或流结束前的所有行同属一条译文
 * @returns {{ entries: string[], remainder: string }}
 */
import type { EngineItem } from './types';

export function parseIndexedTranslationStream( buffer: string, isFinal: boolean) {
  const entries: string[] = []
  if (!buffer) {
    return {entries: entries, remainder: ''}
  }
  let text = buffer
  let remainder = ''
  if (!isFinal) {
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) {
      return {entries: entries, remainder: text}
    }
    remainder = text.slice(lastNewline + 1)
    text = text.slice(0, lastNewline + 1)
  }
  const lines = text.split('\n')
  let currentKey: string | null = null
  let contentLines: string[] = []
  /**
   * 还没有 [index] 前缀的裸文本。单条请求时接口经常直接返回译文（如请求 [0]你好、返回 Hello），
   * 旧实现把这类行直接丢掉，normalizeTranslationLines 根本没有机会补上前缀。
   * 这里原样产出（不带 [index]），由 normalizeTranslationLines 在"本批只有一条"时补 [0]。
   */
  let preludeLines: string[] = []

  function flush() {
    if (currentKey === null) {
      return
    }
    entries.push('[' + currentKey + ']' + contentLines.join('\n'))
    currentKey = null
    contentLines = []
  }

  function flushPrelude() {
    if (!preludeLines.length) {
      return
    }
    entries.push(preludeLines.join('\n'))
    preludeLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === '' && i === lines.length - 1 && text.endsWith('\n')) {
      continue
    }
    const m = line.match(/^\[(\d+)\]\s*(.*)$/)
    if (m) {
      flushPrelude()
      flush()
      currentKey = m[1]
      contentLines = m[2] ? [m[2]] : []
    } else if (currentKey !== null) {
      contentLines.push(line)
    } else {
      // 尚未出现任何 [index]：先当裸文本收着（单条请求返回纯译文的情况）
      preludeLines.push(line)
    }
  }

  if (isFinal) {
    flushPrelude()
    flush()
    if (remainder) {
      const rm = remainder.match(/^\[(\d+)\]\s*(.*)$/)
      if (rm) {
        entries.push('[' + rm[1] + ']' + (rm[2] || ''))
        remainder = ''
      }
    }
  } else if (currentKey !== null) {
    // 非 final：末尾残片(remainder)已经切走，所以要区分两种情况
    // 1) 残片为空或已是下一个 [index] 的开头 → 当前条目已被换行结束，必须直接 flush；
    //    旧实现无条件把它当作「未完成条目」回填 remainder，导致同一份内容既被 flush 又被回填，
    //    下一个条目开头会被粘上来（如 "[12]Hot Pot[13]All Categories"），
    //    既污染上一条译文，又让后面那条永远拿不到自己的译文。
    // 2) 残片是当前条目的续行 → 才需要拼回未完成条目
    if (!remainder || /^\[\d+\]/.test(remainder)) {
      flush()
    } else {
      const partial = '[' + currentKey + ']' + contentLines.join('\n')
      remainder = partial + (partial && remainder ? '\n' : '') + remainder
    }
  } else {
    // 只有裸文本（无 [index]）：它们属于同一条译文（单条请求返回纯译文），
    // 不能在这里就产出——流式分片时后续片段会覆盖前面的内容（曾出现只写到最后一段 "lo"）。
    // 把已累积内容放回 remainder，等流结束或出现 [index] 时一次性产出。
    const prelude = preludeLines.join('\n')
    preludeLines = []
    remainder = prelude + (prelude && remainder ? '\n' : '') + remainder
  }
  return {entries: entries, remainder: remainder}
}

/**
 * 是否为可写入 DOM 的译文（仅辅助过滤明显异常，不改变 [index]行 的解析规则）
 * 过滤：空串、译文恰好等于序号 key；保留 2020年 -> 2020 等数字年份
 */
export function isValidTranslationText( text: string, item: EngineItem) {
  const t = (text || '').trim()
  if (!t) {
    return false
  }
  if (item && String(item.key) === t) {
    return false
  }
  if (/^\d+$/.test(t) && item) {
    const chinese = (item.chinese || '').trim()
    const full = (item.fullChinese || '').trim()
    if (/\d/.test(chinese) || /\d/.test(full)) {
      return true
    }
    if (t.length <= 2) {
      return false
    }
  }
  return true
}

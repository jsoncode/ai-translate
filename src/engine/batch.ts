/**
 * 批次调度与去重入口
 *
 * 由 ai-translate-engine.js 拆分而来（原 L2888-L2945），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode } from './types';
import { debounce, getLanguage, getNodeDataMap, getRouteKey } from './cache';
import { getCompositeRequestText } from './composite';
import { isOpenTranslate } from './lang';
import { onFetch } from './transport';
import { isItemInViewport, isPendingTranslateItem } from './viewport';

/**
 * 收集 nodeDataMap 中待译条目并调用 onFetch（单用户串行，进行中则排队）
 * 防抖 300ms，合并 MutationObserver 高频触发
 */
export const onTranslate = debounce(() => {
  if (!isOpenTranslate()) {
    return
  }
  const lang = getLanguage()
  if (lang === 'zh') {
    return
  }

  let chineseList = []
  for (let key in getNodeDataMap()) {
    const item = getNodeDataMap()[key]
    // 仅当前路由：避免 SPA 切页后仍把上一页条目打进同一批请求
    if (item.pathname !== getRouteKey()) {
      continue
    }
    if (!isPendingTranslateItem(item)) {
      continue
    }
    // 按需翻译：仅请求可视区内待译条目
    if (!isItemInViewport(item)) {
      continue
    }
    chineseList.push({
      index: item.key,
      chinese: item.composite ? getCompositeRequestText(item) : item.chinese
    })
    // 注意：尝试次数不在这里累计。这里只是"准备请求"，批次可能因串行排队被丢弃、
    // 也可能刚发出就被切语言 abort；那些都不算"翻译不出来"，否则高频切换会很快撞上
    // times>=3 而永久不再请求。真正发出请求时才在 onFetch 里计数。
  }
  if (chineseList.length === 0) {
    return
  }

  onFetch(chineseList)
}, 300)

/** 请求失败时解除所有条目的 loading，并记录 error（避免永远卡在 loading） */
export function resetTextLoading( chineseList: DomNode[], error: string | null) {
  const batchKeys: Record<string, boolean> = {}
  for (let i = 0; i < chineseList.length; i++) {
    batchKeys[chineseList[i].index] = true
  }
  for (let key in getNodeDataMap()) {
    const item = getNodeDataMap()[key]
    if (!batchKeys[item.key]) {
      continue
    }
    item.error = error
    item.loading = false
  }
}

/**
 * 路由分桶缓存、节点数据查找
 *
 * 由 ai-translate-engine.js 拆分而来（原 L1331-L1539），函数体保持原样，仅补类型与导入导出。
 */
import type { DomNode, EngineItem, TimerHandle } from './types';
import { applyTranslateSkeleton, syncTranslateSkeleton, writeCompositeTranslate } from './composite-write';
import { assignCompositeRequestMeta } from './composite';
import { runWithoutDomObserver } from './lifecycle';
import { stripClassesFromSelectorPath } from './selector';
import { ROUTE_NODE_CACHE_LIMIT, runtime } from './state';
import { writeTranslateToNode } from './write';

export function migrateNodeDataMapKey( item: EngineItem, newChinese: string) {
  if (!item || !newChinese) {
    return
  }
  let oldKey = null
  for (let key in getNodeDataMap()) {
    if (getNodeDataMap()[key] === item) {
      oldKey = key
      break
    }
  }
  if (oldKey && oldKey !== newChinese) {
    delete getNodeDataMap()[oldKey]
    getNodeDataMap()[newChinese] = item
  }
}

/** 按 path/structPath + index 查找当前路由已登记条目（path 比对时会剥离 class 以兼容旧缓存） */
export function findItemBySelector( path: string, index: number, structPath: string) {
  const routeKey = getRouteKey()
  const normalizedPath = path ? stripClassesFromSelectorPath(path) : ''
  for (let key in getNodeDataMap()) {
    const item = getNodeDataMap()[key]
    if (item.pathname !== routeKey) {
      continue
    }
    if (item.selectors.some(function (s) {
      if (s.pathname !== routeKey) {
        return false
      }
      const sPath = s.path ? stripClassesFromSelectorPath(s.path) : ''
      const sStruct = s.structPath || sPath
      if (s.composite) {
        if (!normalizedPath && !structPath) {
          return false
        }
        return normalizedPath && (sPath === normalizedPath || sStruct === normalizedPath) ||
            structPath && (sStruct === structPath || sPath === structPath)
      }
      if (s.index !== index) {
        return false
      }
      if (normalizedPath && (sPath === normalizedPath || sStruct === normalizedPath)) {
        return true
      }
      if (structPath && (sStruct === structPath || sPath === structPath)) {
        return true
      }
      return false
    })) {
      return item
    }
  }
  return null
}

/** 倒计时等场景：沿用已有译文骨架，仅替换数字后写回 DOM，不发起新请求 */
export function applyDynamicTextUpdate( node: DomNode, item: EngineItem, fullChinese: string, chinese: string) {
  if (!item.translateSkeleton && item.nodeTranslate) {
    syncTranslateSkeleton(item)
  }
  const translate = item.translateSkeleton
      ? applyTranslateSkeleton(item.translateSkeleton, fullChinese)
      : item.nodeTranslate
  item.fullChinese = fullChinese
  item.chinese = chinese
  item.nodeTranslate = translate
  if (item.composite) {
    assignCompositeRequestMeta(item, fullChinese, node.nodeType === Node.ELEMENT_NODE ? node : null)
  }
  migrateNodeDataMapKey(item, chinese)
  runWithoutDomObserver(function () {
    if (item.composite && node.nodeType === Node.ELEMENT_NODE) {
      writeCompositeTranslate(node, item)
    } else {
      writeTranslateToNode(node, item)
    }
  })
}

export function debounce(fn: (...args: unknown[]) => void, delay: number): (...args: unknown[]) => void {
  let timer: TimerHandle | null = null;
  return function (this: unknown, ...args: unknown[]): void {
    const self = this;
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn.apply(self, args), delay);
  };
}

export function getCookie( name: string) {
  let cookie = document.cookie
  let reg = new RegExp(name + '=([^=;]+)')
  let result = cookie.match(reg)
  if (result) {
    return result[1]
  }
  return ''
}

export function getLanguage() {
  // 插件版：关闭翻译等价于"切回中文"，引擎会走回滚流程
  if (!runtime.engineConfig || !runtime.engineConfig.enabled) {
    return 'zh'
  }
  return runtime.engineConfig.targetLang || 'en'
}

/** SPA 路由唯一键（pathname+search+hash）；hash 模式路由会规范化 #/home/ 等写法 */
function normalizeHashRoute( hash: string) {
  if (!hash) {
    return ''
  }
  let h = String(hash)
  if (h.charAt(0) !== '#') {
    h = '#' + h
  }
  if (h === '#') {
    return h
  }
  let path = h.slice(1)
  try {
    path = decodeURIComponent(path)
  } catch (e) {
    // 保持原样
  }
  let hashPath = path
  let hashQuery = ''
  const qIdx = path.indexOf('?')
  if (qIdx !== -1) {
    hashPath = path.slice(0, qIdx)
    hashQuery = path.slice(qIdx)
  }
  hashPath = hashPath.replace(/\/+/g, '/')
  if (hashPath.length > 1 && hashPath.endsWith('/')) {
    hashPath = hashPath.slice(0, -1)
  }
  return '#' + hashPath + hashQuery
}

function getRouteKeyFromParts( pathname: string, search: string, hash: string) {
  const p = pathname || '/'
  const s = search || ''
  const h = normalizeHashRoute(hash || '')
  return p + s + h
}

export function getRouteKey() {
  return getRouteKeyFromParts(location.pathname, location.search, location.hash)
}

/** 当前路由（或指定路由）的 nodeDataMap 桶 */
export function getNodeDataMap( routeKey?: string) {
  const key = routeKey || getRouteKey()
  if (!runtime.routeNodeDataCache[key]) {
    runtime.routeNodeDataCache[key] = {}
  }
  return runtime.routeNodeDataCache[key]
}

/** 淘汰非当前路由的旧桶，避免内存无限增长 */
export function pruneRouteNodeCache( activeKey?: string) {
  const keys = Object.keys(runtime.routeNodeDataCache)
  if (keys.length <= ROUTE_NODE_CACHE_LIMIT) {
    return
  }
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== activeKey) {
      delete runtime.routeNodeDataCache[keys[i]]
      if (Object.keys(runtime.routeNodeDataCache).length <= ROUTE_NODE_CACHE_LIMIT) {
        break
      }
    }
  }
}

/**
 * 请求被中断（切语言/切页 abort）时复位条目的请求状态。
 * times 必须一起复位：中断并不代表"翻译不出来"，若照样累计，立刻就会撞上 times>=3
 * 而永久不再请求（表现为高频切换后中文再也翻不出来）。
 */
export function resetRouteLoadingFlags( routeKey?: string) {
  const map = runtime.routeNodeDataCache[routeKey || getRouteKey()]
  if (!map) {
    return
  }
  for (let k in map) {
    map[k].loading = false
    map[k].times = 0
  }
}

/** 新一轮翻译（run）开始时复位重试状态：用户主动切语言，失败的条目应重新尝试 */
export function resetRouteRetryFlags( routeKey?: string) {
  const map = runtime.routeNodeDataCache[routeKey || getRouteKey()]
  if (!map) {
    return
  }
  for (let k in map) {
    map[k].error = ''
    map[k].times = 0
  }
}

export function clearAllRouteNodeCache() {
  runtime.routeNodeDataCache = {}
  runtime.nextNodeDataKey = 0
}

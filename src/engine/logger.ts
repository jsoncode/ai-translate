/**
 * 日志与页面加载提示
 *
 * 由 ai-translate-engine.js 拆分而来（原 L107-L163），函数体保持原样，仅补类型与导入导出。
 */
import type {  } from './types';
import { state } from './state';

export function logger( ...msg: unknown[]) {
  if (!state.debug) {
    return
  }
  console.log('\n---------- AI Translate logger ----------\n');
  console.log(...msg);
}

function getBodyMaxWidth() {
  const html = document.documentElement
  let val = html.style.getPropertyValue('--bodyMaxWidth').trim()
  if (!val) {
    val = getComputedStyle(html).getPropertyValue('--bodyMaxWidth').trim()
  }
  if (!val) return null
  const match = val.match(/^([\d.]+)px$/i)
  return match ? parseFloat(match[1]) : null
}

function pxToRem( px: number, bodyMaxWidth: number) {
  const rem = px / (bodyMaxWidth / 7.5)
  return String(parseFloat(rem.toFixed(4))) + 'rem'
}

function getLoadingTipStyle() {
  const bodyMaxWidth = getBodyMaxWidth()
  if (!bodyMaxWidth) {
    return '.ai-translation-loading-tip{display:none;position:fixed;top:0.88rem;z-index:1000000;left: 0;text-align: center;width: 100%;justify-content: center;}.ai-translation-loading-content{max-width:90%;margin:0 auto;font-size:0.25rem;padding:10px;backdrop-filter:blur(6px);background:rgba(0,0,0,0.5);color:#fff;border-radius:6px;}'
  }
  const top = pxToRem(60, bodyMaxWidth)
  const fontSize = pxToRem(20, bodyMaxWidth)
  const paddingH = pxToRem(10, bodyMaxWidth)
  const borderRadius = pxToRem(8, bodyMaxWidth)
  return '.ai-translation-loading-tip{display:none;position:fixed;top:' + top + ';z-index:1000000;left:var((100% - var(--bodyMaxWidth, 100%)) / 2);text-align: center; var(--bodyMaxWidth, 100%);justify-content: center;}.ai-translation-loading-content{max-width:90%;margin:0 auto;font-size:' + fontSize + ';padding:' + paddingH + ';backdrop-filter:blur(6px);background:rgba(0,0,0,0.5);color:#fff;border-radius:' + borderRadius + ';}'
}

export function showLoading( show: boolean = true) {
  state.isLoading = show;
  const id = '.ai-translation-loading-tip'
  let tip = document.querySelector<HTMLElement>(id);
  if (!tip) {
    const LOADING_TIP_HTML = '<div class="ai-translation-loading-tip"><div class="ai-translation-loading-content">This content is translated by AI. For any questions, please contact customer service.</div></div>' + '<style>' + getLoadingTipStyle() + '</style>';
    document.body.insertAdjacentHTML('beforeend', LOADING_TIP_HTML);
    tip = document.querySelector(id);
  }
  if (tip) {
    tip.style.display = show ? 'block' : 'none';
  }
}

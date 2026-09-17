/**
 * 生成物：src/engine/ai-translate-engine.js（由 tools/build-engine.mjs 从上游 canvas 插件生成）。
 * 这里只声明它挂在 window 上的 API 类型，以及"导入该文件会执行它"这一点。
 */
import type { EngineApi } from '../lib/types';

declare module '../engine/ai-translate-engine.js' {
  // 纯副作用模块：导入它即把 window.__aiTranslateEngine 挂上
  const engine: EngineApi | undefined;
  export default engine;
}

/**
 * 依次构建三个目标：pages -> background -> content。
 *   node scripts/build.mjs            一次性构建
 *   node scripts/build.mjs --watch    三个目标都进入 watch（改代码自动重建，去扩展页点"重新加载"即可）
 */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

const TARGETS = ['pages', 'background', 'content'];
const watch = process.argv.includes('--watch');
const only = process.argv.find((a) => a.startsWith('--target='))?.split('=')[1];
const targets = only ? [only] : TARGETS;

const t0 = Date.now();
for (const target of targets) {
  if (!TARGETS.includes(target)) {
    console.error(`[build] 未知目标：${target}（可选 ${TARGETS.join(' / ')}）`);
    process.exit(1);
  }
  process.stdout.write(`[build] ${target} … `);
  try {
    const result = await build({
      configFile: CONFIG_FILE,
      mode: target,
      ...(watch ? { build: { watch: {} } } : {}),
    });
    if (!watch) {
      const outputs = Array.isArray(result) ? result.flatMap((r) => r.output ?? []) : [];
      console.log('ok');
      for (const chunk of outputs) {
        if (chunk.type === 'chunk' || chunk.type === 'asset') {
          console.log('        ' + chunk.fileName);
        }
      }
    } else {
      console.log('watching');
    }
  } catch (err) {
    console.error('failed');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (!watch) {
  console.log(`[build] 完成，用时 ${Date.now() - t0}ms -> dist/`);
  console.log('[build] 打开 chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> 选择 dist 目录');
}

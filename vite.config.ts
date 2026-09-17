import { defineConfig } from 'vitest/config';
import type { UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const r = (...p: string[]) => resolve(root, ...p);

/**
 * 三种构建目标（通过 `vite build --mode xxx` 选择）：
 *   pages      -> dist/popup/index.html、dist/options/index.html（React + antd，ESM）
 *   background -> dist/background.js（MV3 service worker，ESM：manifest 里 type: module）
 *   content    -> dist/content.js（内容脚本必须是单文件 IIFE，浏览器不支持 ESM 内容脚本）
 *
 * 三种目标都往 dist 输出：pages 先跑（清空 dist 并拷贝 public/），另两个 emptyOutDir: false。
 */
export default defineConfig(({ mode }): UserConfig => {
  // 测试：单测都在 tests/ 下，用 node 环境（jsdom 端到端由 tools/smoke-test.mjs 负责）
  if (mode === 'test') {
    return {
      root: r('.'),
      resolve: { alias: { '@': r('src') } },
      test: {
        include: ['tests/**/*.test.ts'],
        environment: 'node',
        globals: false,
      },
    };
  }

  const shared: UserConfig = {
    resolve: {
      alias: { '@': r('src') },
    },
    build: {
      outDir: r('dist'),
      target: 'chrome116',
      sourcemap: true,
      // Vite 8 使用 rolldown/oxc，默认压缩器即 oxc（显式写 'esbuild' 需要额外安装 esbuild）
      minify: true,
      emptyOutDir: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  };

  if (mode === 'background') {
    return {
      ...shared,
      build: {
        ...shared.build,
        lib: {
          entry: r('src/background/index.ts'),
          formats: ['es'],
          fileName: () => 'background.js',
        },
      },
    };
  }

  if (mode === 'content') {
    return {
      ...shared,
      build: {
        ...shared.build,
        lib: {
          entry: r('src/content/index.ts'),
          formats: ['iife'],
          name: 'AITranslateContent',
          fileName: () => 'content.js',
        },
      },
    };
  }

  // pages（默认）
  return {
    ...shared,
    root: r('src'),
    publicDir: r('public'),
    plugins: [react()],
    build: {
      ...shared.build,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          popup: r('src/popup/index.html'),
          options: r('src/options/index.html'),
        },
      },
    },
  };
});

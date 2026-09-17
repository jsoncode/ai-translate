/**
 * 主题 + antd 外观总入口。
 *
 * antd 的颜色需要在 JS 里以「种子色」给出（它要用色板算法推导 hover/active/边框），
 * 所以这里维护一份与 styles/base.css 对应的调色板：改一处要同步另一处。
 * 设计意图：石墨底 + 唯一强调色（青），不用蓝紫渐变，不堆阴影。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { loadConfig } from '../lib/config';
import { onConfigChanged } from '../lib/storage';
import { applyTheme, cachedThemeMode, setThemeMode, subscribeTheme, watchSystemTheme } from '../lib/theme';
import type { ResolvedTheme } from '../lib/theme';
import type { ThemeMode } from '../lib/types';

const FONT_SANS =
  'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';

/** 深色：石墨底 + 信号青。与 styles/base.css 的 :root 变量一一对应 */
const DARK_PALETTE = {
  colorPrimary: '#2FD8BE',
  colorPrimaryHover: '#4CE3CB',
  colorPrimaryActive: '#22B9A3',
  colorPrimaryBorder: 'rgba(47, 216, 190, 0.38)',
  colorPrimaryBg: 'rgba(47, 216, 190, 0.12)',
  colorBgBase: '#0A0A0B',
  colorBgLayout: '#0A0A0B',
  colorBgContainer: '#141417',
  colorBgElevated: '#17171B',
  colorBgSpotlight: '#22222A',
  colorText: '#ECECEE',
  colorTextSecondary: '#9C9CA5',
  colorTextTertiary: '#6B6B74',
  colorBorder: 'rgba(255, 255, 255, 0.14)',
  colorBorderSecondary: 'rgba(255, 255, 255, 0.07)',
  colorError: '#F0605F',
  colorErrorBg: 'rgba(240, 96, 95, 0.12)',
  colorWarning: '#E2A33F',
  colorWarningBg: 'rgba(226, 163, 63, 0.12)',
  colorSuccess: '#2FD8BE',
  colorInfo: '#2FD8BE',
  controlOutline: 'rgba(47, 216, 190, 0.22)',
  boxShadowSecondary: '0 12px 32px rgba(0, 0, 0, 0.55)',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
};

/** 浅色：暖白纸面（stone 系，避开蓝灰），强调色压深保证对比度 */
const LIGHT_PALETTE = {
  colorPrimary: '#0C8A78',
  colorPrimaryHover: '#0E9C88',
  colorPrimaryActive: '#0A7666',
  colorPrimaryBorder: 'rgba(12, 138, 120, 0.35)',
  colorPrimaryBg: 'rgba(12, 138, 120, 0.07)',
  colorBgBase: '#FAFAF9',
  colorBgLayout: '#FAFAF9',
  colorBgContainer: '#FFFFFF',
  colorBgElevated: '#FFFFFF',
  colorBgSpotlight: '#22222A',
  colorText: '#17171A',
  colorTextSecondary: '#5F5F67',
  colorTextTertiary: '#8A8A92',
  colorBorder: 'rgba(20, 20, 19, 0.16)',
  colorBorderSecondary: 'rgba(20, 20, 19, 0.08)',
  colorError: '#C93B39',
  colorErrorBg: 'rgba(201, 59, 57, 0.08)',
  colorWarning: '#9A6A12',
  colorWarningBg: 'rgba(154, 106, 18, 0.09)',
  colorSuccess: '#0C8A78',
  colorInfo: '#0C8A78',
  controlOutline: 'rgba(12, 138, 120, 0.18)',
  boxShadowSecondary: '0 12px 32px rgba(20, 20, 19, 0.14)',
  boxShadow: '0 2px 8px rgba(20, 20, 19, 0.08)',
};

interface Props {
  /** popup 里控件更紧凑（30px），设置页用 34px */
  compact?: boolean;
  children: ReactNode;
}

export default function ThemeRoot({ compact = false, children }: Props): React.ReactElement {
  const [mode, setMode] = useState<ThemeMode>(() => cachedThemeMode());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => applyTheme(cachedThemeMode()));

  // 配置里的主题才是权威值；存了之后两个页面都会跟着换
  useEffect(() => {
    void loadConfig().then((cfg) => {
      setThemeMode(cfg.theme);
      setMode(cfg.theme);
    });
    onConfigChanged(() => {
      void loadConfig().then((cfg) => {
        setThemeMode(cfg.theme);
        setMode(cfg.theme);
      });
    });
  }, []);

  // 设置页点选时先预览，再在保存后落库
  useEffect(() => subscribeTheme(setMode), []);

  useEffect(() => {
    setResolved(applyTheme(mode));
    return watchSystemTheme(() => setResolved(applyTheme(mode)));
  }, [mode]);

  const palette = resolved === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;

  return (
    <ConfigProvider
      locale={zhCN}
      componentSize={compact ? 'small' : 'middle'}
      theme={{
        algorithm: resolved === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          fontFamily: FONT_SANS,
          fontSize: 13,
          borderRadius: 8,
          borderRadiusSM: 6,
          borderRadiusLG: 10,
          borderRadiusXS: 5,
          controlHeight: compact ? 30 : 34,
          controlHeightSM: 26,
          controlHeightLG: 38,
          lineWidth: 1,
          wireframe: false,
          motionDurationFast: '0.1s',
          motionDurationMid: '0.16s',
          motionDurationSlow: '0.22s',
          ...palette,
        },
      }}
    >
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}

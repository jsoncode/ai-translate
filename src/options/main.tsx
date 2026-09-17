import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import OptionsApp from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ algorithm: theme.defaultAlgorithm, token: { borderRadius: 8 } }}>
      <AntApp>
        <OptionsApp />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import PopupApp from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      componentSize="small"
      theme={{ algorithm: theme.defaultAlgorithm, token: { fontSize: 13, borderRadius: 8 } }}
    >
      <AntApp>
        <PopupApp />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);

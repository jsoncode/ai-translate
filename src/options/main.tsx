import React from 'react';
import ReactDOM from 'react-dom/client';
import ThemeRoot from '../components/ThemeRoot';
import { bootstrapTheme } from '../lib/theme';
import OptionsApp from './App';
import '../styles/base.css';
import './styles.css';

// 渲染之前先把主题定下来，避免首帧闪一下
bootstrapTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeRoot>
      <OptionsApp />
    </ThemeRoot>
  </React.StrictMode>,
);

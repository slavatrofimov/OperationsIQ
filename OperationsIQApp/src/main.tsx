import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ConfigGate } from './components/ConfigGate';
import { missingRequiredEnv } from './lib/env';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

// Fail fast on misconfiguration: render a single clear "Configuration
// incomplete" gate instead of letting missing values surface later as opaque
// MSAL / Eventhouse / Rayfin errors.
const missing = missingRequiredEnv();

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    {missing.length > 0 ? <ConfigGate missing={missing} /> : <App />}
  </React.StrictMode>,
);

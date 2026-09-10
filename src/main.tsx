import React from 'react';
import ReactDOM from 'react-dom/client';
import ErrorBoundary from './ErrorBoundary';
import './App.css';
// A dynamic import keeps startup exceptions visible instead of leaving a blank webview.
const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<div className="recovery">Starting AfterEdit…</div>);
import('./App').then(({ default: App }) => {
  root.render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
}).catch(error => root.render(<div className="recovery" role="alert"><h1>AfterEdit could not start</h1><pre>{String(error)}</pre><button onClick={() => location.reload()}>Retry</button></div>));

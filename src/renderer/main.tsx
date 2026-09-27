import React from 'react';
import { createRoot } from 'react-dom/client';
import { operationalShellDemoFixture } from './mocks/operationalPreview.fixture';
import { OperationalListView } from './views/OperationalListView';

type AppInfo = Awaited<ReturnType<Window['ade']['getAppInfo']>>;

function App() {
  const [info, setInfo] = React.useState<AppInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!window.ade || typeof window.ade.getAppInfo !== 'function') {
      setError('A ponte IPC do Electron n\u00e3o est\u00e1 dispon\u00edvel neste preview.');
      setLoading(false);
      return;
    }
    window.ade.getAppInfo()
      .then(setInfo)
      .catch(() => setError('N\u00e3o foi poss\u00edvel carregar as informa\u00e7\u00f5es do aplicativo.'))
      .finally(() => setLoading(false));
  }, []);

  return <>
    <header className="app-runtime-status">
      <h1>ADE Desktop</h1>
      {loading && <p role="status">Carregando informa\u00e7\u00f5es do aplicativo...</p>}
      {info && <p>{info.name} · {info.version} · {info.platform}</p>}
      {error && <p role="alert">{error}</p>}
    </header>
    <OperationalListView fixture={operationalShellDemoFixture} presentation="demonstration" />
  </>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

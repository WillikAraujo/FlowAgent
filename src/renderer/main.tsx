import React from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopView } from './views/DesktopView';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><DesktopView /></React.StrictMode>,
);

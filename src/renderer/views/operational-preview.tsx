import React from 'react';
import { createRoot } from 'react-dom/client';
import { operationalPreviewFixture } from '../mocks/operationalPreview.fixture';
import { OperationalListView } from './OperationalListView';

createRoot(document.getElementById('root')!).render(<React.StrictMode><OperationalListView fixture={operationalPreviewFixture} presentation="preview" /></React.StrictMode>);

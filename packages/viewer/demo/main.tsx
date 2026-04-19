import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatArchViewer } from '../src/index.js';
import '../src/styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <ChatArchViewer manifestUrl="/chat-arch-data/manifest.json" dataRoot="/chat-arch-data" />
  </StrictMode>,
);

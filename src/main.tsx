import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerStoredProfiles } from './engine/hybrid/providerConfig';
import './styles/global.css';

// INT-006: a deployment's own capability profiles are data, applied at start.
registerStoredProfiles();

document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? 'dark';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

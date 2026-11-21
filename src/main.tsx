import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './editor/App';

if (import.meta.env.DEV) {
  // Handy for poking at state from the devtools console.
  void Promise.all([
    import('./store/doc'),
    import('./store/ui'),
    import('./store/assets'),
    import('./store/actions'),
    import('./store/sample'),
    import('./store/scene'),
    import('./store/project'),
    import('./store/meshActions'),
    import('./store/ikActions'),
    import('./i18n'),
  ]).then(([doc, ui, assets, actions, sample, scene, project, meshActions, ikActions, i18n]) => {
    (window as unknown as Record<string, unknown>).__bone2d = {
      ...doc,
      ...ui,
      ...assets,
      actions,
      sample,
      scene,
      project,
      meshActions,
      ikActions,
      i18n,
    };
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

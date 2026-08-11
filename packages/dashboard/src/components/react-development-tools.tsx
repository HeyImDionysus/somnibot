'use client';

import { scan } from 'react-scan';

const reactDevelopmentToolsEnabled =
  process.env.NODE_ENV === 'development'
  && process.env.NEXT_PUBLIC_DISABLE_REACT_DEVTOOLS !== '1';

if (reactDevelopmentToolsEnabled) {
  scan({ enabled: true, useOffscreenCanvasWorker: false });
  void import('react-grab');
}

export function ReactDevelopmentTools() {
  return null;
}

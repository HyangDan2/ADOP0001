/** Loads the vendored Mermaid bundle on demand so the main bundle stays small. */

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
  parse?: (code: string) => Promise<boolean>;
}

declare global {
  interface Window {
    mermaid?: MermaidApi;
  }
}

let pending: Promise<MermaidApi> | null = null;

export type MermaidTheme = 'dark' | 'light';

const DARK_VARS = {
  primaryColor: '#14231b',
  primaryTextColor: '#eaf4ed',
  primaryBorderColor: '#52b788',
  lineColor: '#74c69d',
  secondaryColor: '#101d16',
  tertiaryColor: '#0b140f',
  background: '#0b140f',
  mainBkg: '#14231b',
  nodeBorder: '#52b788',
  clusterBkg: '#101d16',
  clusterBorder: '#2b4a38',
  titleColor: '#eaf4ed',
  edgeLabelBackground: '#101d16',
  textColor: '#eaf4ed',
  actorBkg: '#14231b',
  actorBorder: '#52b788',
  actorTextColor: '#eaf4ed',
  signalColor: '#74c69d',
  signalTextColor: '#eaf4ed',
  labelBoxBkgColor: '#101d16',
  labelBoxBorderColor: '#52b788',
  labelTextColor: '#eaf4ed',
  loopTextColor: '#eaf4ed',
  noteBkgColor: '#182a21',
  noteTextColor: '#eaf4ed',
  noteBorderColor: '#52b788',
};

const LIGHT_VARS = {
  primaryColor: '#f5faf6',
  primaryTextColor: '#16241b',
  primaryBorderColor: '#2d6a4f',
  lineColor: '#40916c',
  secondaryColor: '#ffffff',
  tertiaryColor: '#edf4ef',
  background: '#ffffff',
  mainBkg: '#f5faf6',
  nodeBorder: '#2d6a4f',
  clusterBkg: '#f8fbf8',
  clusterBorder: '#b9d2c3',
  titleColor: '#16241b',
  edgeLabelBackground: '#ffffff',
  textColor: '#16241b',
  actorBkg: '#f5faf6',
  actorBorder: '#2d6a4f',
  actorTextColor: '#16241b',
  signalColor: '#2d6a4f',
  signalTextColor: '#16241b',
  labelBoxBkgColor: '#ffffff',
  labelBoxBorderColor: '#2d6a4f',
  labelTextColor: '#16241b',
  loopTextColor: '#16241b',
  noteBkgColor: '#eaf4ed',
  noteTextColor: '#16241b',
  noteBorderColor: '#2d6a4f',
};

export function configureMermaid(api: MermaidApi, theme: MermaidTheme): MermaidApi {
  api.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: theme === 'dark' ? DARK_VARS : LIGHT_VARS,
    fontFamily: 'Inter, Segoe UI, system-ui, sans-serif',
    flowchart: { htmlLabels: true, curve: 'basis' },
    sequence: { mirrorActors: false, messageAlign: 'left' },
  });
  return api;
}

export function loadMermaid(theme: MermaidTheme = 'dark'): Promise<MermaidApi> {
  if (window.mermaid) {
    return Promise.resolve(configureMermaid(window.mermaid, theme));
  }
  if (!pending) {
    pending = new Promise<MermaidApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${import.meta.env.BASE_URL}vendor/mermaid.min.js`;
      script.async = true;
      script.onload = () => {
        if (!window.mermaid) {
          reject(new Error('Mermaid loaded but did not register itself.'));
          return;
        }
        resolve(window.mermaid);
      };
      script.onerror = () => {
        pending = null;
        reject(new Error('Mermaid could not be loaded from public/vendor/mermaid.min.js.'));
      };
      document.head.appendChild(script);
    });
  }
  return pending.then((api) => configureMermaid(api, theme));
}

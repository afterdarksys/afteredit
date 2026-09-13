import { JSDOM } from 'jsdom';
import { act, createElement, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';

/**
 * react-dom is loaded lazily, and never at module scope.
 *
 * It feature-detects the DOM once, when it is first imported: with no `window`
 * yet, it decides the `input` event is unsupported and falls back to its
 * legacy change detection for the rest of the process. The visible symptom is
 * that no controlled text input can ever be typed into -- `onChange` simply
 * never fires. Importing it only after `mountEnvironment` has installed the
 * globals is what makes `type()` work.
 */
let createRoot: ((container: Element) => Root) | undefined;
async function reactDom() {
  if (!createRoot) ({ createRoot } = (await import('react-dom/client')) as unknown as { createRoot: (container: Element) => Root });
  return createRoot;
}

/**
 * A DOM plus a Tauri stub, so components can actually be mounted.
 *
 * Nothing else in the suite executes a line of JSX -- `tsc` type-checks it and
 * vite bundles it, but a render-time throw (a null deref, a bad hook order)
 * would reach the user unnoticed. These tests exist to catch that.
 *
 * Calls are recorded rather than asserted here: a component that quietly stops
 * asking the backend for anything is also a regression.
 */
export type Invoked = { command: string; args: Record<string, unknown> };

let dom: JSDOM | undefined;
let root: Root | undefined;
let container: HTMLElement | undefined;

export type Harness = {
  calls: Invoked[];
  container: HTMLElement;
  text: () => string;
  html: () => string;
  find: (selector: string) => HTMLElement | null;
  all: (selector: string) => HTMLElement[];
  click: (target: HTMLElement) => Promise<void>;
  type: (target: HTMLElement, value: string) => Promise<void>;
};

export type Responses = Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;

/** Install a DOM. `responses` maps a command name to its result; an unlisted
 *  command rejects, which is how a component's error path gets exercised. */
export function mountEnvironment(responses: Responses = {}, tauri = true): Invoked[] {
  const calls: Invoked[] = [];
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  // Some of these (navigator) are getter-only on globalThis in Node 22, so
  // plain assignment throws. defineProperty works for all of them.
  const expose = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  expose('window', win);
  expose('document', win.document);
  expose('navigator', win.navigator);
  expose('HTMLElement', win.HTMLElement);
  expose('Element', win.Element);
  expose('Node', win.Node);
  expose('Event', win.Event);
  expose('MouseEvent', win.MouseEvent);
  expose('getComputedStyle', win.getComputedStyle.bind(win));
  expose('requestAnimationFrame', (cb: FrameRequestCallback) => win.setTimeout(() => cb(0), 0));
  expose('cancelAnimationFrame', (id: number) => win.clearTimeout(id));
  expose('IS_REACT_ACT_ENVIRONMENT', true);

  (globalThis as Record<string, unknown>).isTauri = tauri;
  win.isTauri = tauri;
  win.__TAURI_INTERNALS__ = {
    transformCallback: (callback: unknown) => callback,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (!(command in responses)) throw new Error(`no stub for '${command}'`);
      const reply = responses[command];
      return typeof reply === 'function' ? (reply as (a: Record<string, unknown>) => unknown)(args) : reply;
    },
  };
  return calls;
}

export async function render<P extends object>(
  Component: ComponentType<P>,
  props: P,
  calls: Invoked[] = [],
): Promise<Harness> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = container;
  root = (await reactDom())(mounted);

  // The async act flushes effects, so an invoke made on mount has resolved
  // (or rejected) by the time assertions run.
  await act(async () => { root!.render(createElement(Component, props)); });

  return {
    calls,
    container: mounted,
    text: () => mounted.textContent ?? '',
    html: () => mounted.innerHTML,
    find: (selector: string) => mounted.querySelector(selector),
    all: (selector: string) => [...mounted.querySelectorAll(selector)] as HTMLElement[],
    click: async (target: HTMLElement) => {
      await act(async () => { target.click(); });
    },
    // React caches the input's last value, so assigning `.value` directly is
    // ignored. Go through the prototype setter, then fire the event React
    // actually listens for.
    type: async (target: HTMLElement, value: string) => {
      const view = target.ownerDocument.defaultView as unknown as {
        HTMLInputElement: { prototype: object };
        Event: new (type: string, init?: { bubbles?: boolean }) => Event;
      };
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(target, value);
      await act(async () => {
        target.dispatchEvent(new view.Event('input', { bubbles: true }));
      });
    },
  };
}

export async function unmount(): Promise<void> {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = undefined;
  }
  container?.remove();
  container = undefined;
  dom?.window.close();
  dom = undefined;
}

/** Silence an expected React or console error for one test. */
export function quiet<T>(run: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return run();
  } finally {
    console.error = original;
  }
}

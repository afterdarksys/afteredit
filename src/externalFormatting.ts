import * as monaco from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectedServer } from './languageServices';
import { externalFormattingWanted } from './formatterPolicy';

export type FormatOutcome = { text: string; formatter: string; changed: boolean };

export function formatText(language: string, text: string): Promise<FormatOutcome> {
  return invoke<FormatOutcome>('format_source', { language, text });
}

let formattable: string[] | null = null;

export async function formattableLanguages(): Promise<string[]> {
  if (!formattable) {
    formattable = await invoke<string[]>('formattable_languages').catch(() => []);
  }
  return formattable;
}

const registrations = new Map<string, monaco.IDisposable>();

function provider(language: string, onError: (message: string) => void): monaco.languages.DocumentFormattingEditProvider {
  return {
    displayName: 'External formatter',
    async provideDocumentFormattingEdits(model) {
      try {
        const outcome = await formatText(language, model.getValue());
        return outcome.changed ? [{ range: model.getFullModelRange(), text: outcome.text }] : [];
      } catch (error) {
        // No edits leaves the document exactly as it was, which is the only
        // safe result when the tool is missing or exited non-zero.
        onError(String(error));
        return [];
      }
    },
  };
}

/** Register a provider for every formattable language no connected server is
 *  already formatting, and drop ours as soon as one takes over. */
export async function syncExternalFormatters(
  servers: ConnectedServer[],
  onError: (message: string) => void,
): Promise<void> {
  for (const language of await formattableLanguages()) {
    const wanted = externalFormattingWanted(language, servers);
    const existing = registrations.get(language);
    if (wanted && !existing) {
      registrations.set(language, monaco.languages.registerDocumentFormattingEditProvider(language, provider(language, onError)));
    } else if (!wanted && existing) {
      existing.dispose();
      registrations.delete(language);
    }
  }
}

export function disposeExternalFormatters(): void {
  registrations.forEach((registration) => registration.dispose());
  registrations.clear();
}

import * as monaco from 'monaco-editor';

/** `.http` request files, so the method, headers and body read apart. */
export function registerHttpFile() {
  monaco.languages.register({
    id: 'http',
    extensions: ['.http', '.rest'],
    aliases: ['HTTP', 'http', 'REST'],
  });

  monaco.languages.setLanguageConfiguration('http', {
    comments: { lineComment: '#' },
    brackets: [['{', '}'], ['[', ']']],
  });

  monaco.languages.setMonarchTokensProvider('http', {
    defaultToken: '',
    tokenizer: {
      root: [
        [/^###.*$/, 'type.identifier'],
        [/^\s*(?:#|\/\/).*$/, 'comment'],
        [/^@[A-Za-z0-9_.-]+(?=\s*=)/, 'variable'],
        [/\{\{[^}]*\}\}/, 'string.escape'],
        [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/, 'keyword'],
        [/\bHTTP\/[\d.]+/, 'number'],
        [/^[A-Za-z-]+(?=\s*:)/, 'attribute.name'],
        [/https?:\/\/\S+/, 'string.link'],
        [/[{}[\],]/, 'delimiter.bracket'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/\b\d+\b/, 'number'],
      ],
    },
  });
}

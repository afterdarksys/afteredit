import * as monaco from "monaco-editor";

/**
 * Monaco ships ~85 languages but not TOML, which is awkward for a Rust/Python
 * project: Cargo.toml, pyproject.toml and rustfmt.toml are all unhighlighted.
 * This is a Monarch tokenizer covering TOML 1.0.
 */
export function registerToml() {
  if (monaco.languages.getLanguages().some((lang) => lang.id === "toml")) return;

  monaco.languages.register({
    id: "toml",
    extensions: [".toml"],
    filenames: ["Cargo.lock", "Pipfile", "poetry.lock"],
    aliases: ["TOML", "toml"],
    mimetypes: ["application/toml", "text/x-toml"],
  });

  monaco.languages.setLanguageConfiguration("toml", {
    comments: { lineComment: "#" },
    brackets: [
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider("toml", {
    defaultToken: "",
    tokenPostfix: ".toml",

    // Order matters: multi-line string openers must be tried before their
    // single-line counterparts, and table headers before bare brackets.
    tokenizer: {
      root: [
        [/^\s*#.*$/, "comment"],
        [/^\s*\[\[[^\]]*\]\]/, "type.identifier"],
        [/^\s*\[[^\]]*\]/, "type.identifier"],

        [/"""/, "string", "@blockBasic"],
        [/'''/, "string", "@blockLiteral"],

        // A bare, quoted or dotted key, only when an '=' follows.
        [/(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(?=\s*=)/, "variable"],

        [/\b(?:true|false)\b/, "keyword"],
        // Offset date-time / local date-time / date / time.
        [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, "number"],
        [/\d{2}:\d{2}:\d{2}(?:\.\d+)?/, "number"],
        [/[+-]?(?:inf|nan)\b/, "number.float"],
        [/0x[0-9A-Fa-f](?:[0-9A-Fa-f_]*)?/, "number.hex"],
        [/0o[0-7][0-7_]*/, "number.octal"],
        [/0b[01][01_]*/, "number.binary"],
        [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/, "number"],

        [/"/, "string", "@basic"],
        [/'/, "string", "@literal"],

        [/#.*$/, "comment"],
        [/=/, "delimiter"],
        [/[[\]{},]/, "delimiter.bracket"],
      ],

      basic: [
        [/[^\\"]+/, "string"],
        [/\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],

      // Literal strings have no escapes at all.
      literal: [
        [/[^']+/, "string"],
        [/'/, "string", "@pop"],
      ],

      blockBasic: [
        [/[^\\"]+/, "string"],
        [/\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|\s*$)/, "string.escape"],
        [/"""/, "string", "@pop"],
        [/"/, "string"],
      ],

      blockLiteral: [
        [/[^']+/, "string"],
        [/'''/, "string", "@pop"],
        [/'/, "string"],
      ],
    },
  });
}

import * as monaco from "monaco-editor";

/** Rego (Open Policy Agent). This is the policy language behind Spacelift
 *  plan policies, Conftest and Gatekeeper -- core devsecops surface, and
 *  Monaco ships nothing for it. */
export function registerRego() {
  monaco.languages.register({
    id: "rego",
    extensions: [".rego"],
    aliases: ["Rego", "rego", "OPA"],
  });

  monaco.languages.setLanguageConfiguration("rego", {
    comments: { lineComment: "#" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });

  monaco.languages.setMonarchTokensProvider("rego", {
    defaultToken: "",
    tokenPostfix: ".rego",

    keywords: [
      "package", "import", "as", "default", "not", "with", "some", "every",
      "in", "if", "else", "contains", "null", "true", "false",
    ],
    builtins: [
      "input", "data", "count", "sum", "product", "max", "min", "sort", "all",
      "any", "concat", "endswith", "startswith", "indexof", "substring",
      "lower", "upper", "trim", "trim_space", "split", "replace", "sprintf",
      "format_int", "to_number", "type_name", "walk", "print", "regex", "json",
      "yaml", "base64", "base64url", "hex", "urlquery", "http", "net", "time",
      "crypto", "uuid", "rand", "numbers", "bits", "object", "array", "sets",
      "strings", "units", "semver", "glob", "graph", "io", "opa", "trace",
      "is_string", "is_number", "is_boolean", "is_array", "is_object",
      "is_set", "is_null", "cast_array", "cast_set", "cast_string",
    ],

    tokenizer: {
      root: [
        [/#.*$/, "comment"],

        [/`/, "string", "@rawString"],
        [/"/, "string", "@string"],

        // Rule head: name at the start of a line, before args, := , = or {.
        [/^[a-z_][\w$]*(?=\s*(?:\[|\(|:=|=|\{|$))/, "type.identifier"],

        [/\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, "number"],

        [/[a-zA-Z_][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@builtins": "predefined",
            "@default": "identifier",
          },
        }],

        [/:=|==|!=|<=|>=|[<>=]/, "operator"],
        [/[+\-*/%|&]/, "operator"],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/\\(?:[abfnrtv\\"/]|u[0-9A-Fa-f]{4})/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],

      // Raw strings have no escapes.
      rawString: [
        [/[^`]+/, "string"],
        [/`/, "string", "@pop"],
      ],
    },
  });
}

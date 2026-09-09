import * as monaco from "monaco-editor";

/** Groovy, primarily so Jenkinsfiles highlight. The declarative-pipeline DSL
 *  words are treated as keywords because that is what a Jenkinsfile is mostly
 *  made of. */
export function registerGroovy() {
  monaco.languages.register({
    id: "groovy",
    extensions: [".groovy", ".gvy", ".gy", ".gsh", ".gradle"],
    filenames: ["Jenkinsfile", "jenkinsfile"],
    aliases: ["Groovy", "groovy", "Jenkinsfile"],
  });

  monaco.languages.setLanguageConfiguration("groovy", {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });

  monaco.languages.setMonarchTokensProvider("groovy", {
    defaultToken: "",
    tokenPostfix: ".groovy",

    keywords: [
      "abstract", "as", "assert", "boolean", "break", "byte", "case", "catch",
      "char", "class", "const", "continue", "def", "default", "do", "double",
      "else", "enum", "extends", "false", "final", "finally", "float", "for",
      "goto", "if", "implements", "import", "in", "instanceof", "int",
      "interface", "long", "native", "new", "null", "package", "private",
      "protected", "public", "return", "short", "static", "strictfp", "super",
      "switch", "synchronized", "this", "threadsafe", "throw", "throws",
      "transient", "true", "try", "var", "void", "volatile", "while", "trait",
    ],
    // Declarative pipeline + the steps people use every day.
    pipeline: [
      "pipeline", "agent", "any", "none", "docker", "dockerfile", "kubernetes",
      "label", "stages", "stage", "steps", "script", "environment", "options",
      "parameters", "triggers", "tools", "when", "post", "always", "success",
      "failure", "unstable", "aborted", "changed", "cleanup", "parallel",
      "matrix", "axes", "axis", "input", "credentials", "libraries", "library",
      "sh", "bat", "powershell", "echo", "checkout", "scm", "git", "node",
      "stash", "unstash", "archiveArtifacts", "junit", "withCredentials",
      "withEnv", "timeout", "retry", "dir", "readFile", "writeFile", "error",
											"build", "emailext", "sleep", "milestone", "lock", "container",
    ],

    tokenizer: {
      root: [
        [/@\s*[A-Za-z_$][\w$]*/, "annotation"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],

        [/"""/, "string", "@blockDouble"],
        [/'''/, "string", "@blockSingle"],
        [/"/, "string", "@double"],
        [/'/, "string", "@single"],
        [/\//, "regexp", "@slashy"],

        [/\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFdDlLgGiI]?\b/, "number"],

        [/[A-Za-z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@pipeline": "keyword.control",
            "@default": "identifier",
          },
        }],

        [/[{}()[\]]/, "@brackets"],
        [/[<>=!+\-*/%&|^~?:]+/, "operator"],
      ],

      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],

      // GStrings interpolate; single quotes do not. That distinction matters a
      // lot in Jenkinsfiles, where it decides whether a secret is expanded by
      // Groovy or by the shell.
      double: [
        [/[^\\"$]+/, "string"],
        [/\$\{/, { token: "delimiter.bracket", next: "@interpolation" }],
        [/\$[A-Za-z_][\w.]*/, "variable"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],
      blockDouble: [
        [/[^\\"$]+/, "string"],
        [/\$\{/, { token: "delimiter.bracket", next: "@interpolation" }],
        [/\$[A-Za-z_][\w.]*/, "variable"],
        [/\\./, "string.escape"],
        [/"""/, "string", "@pop"],
        [/"/, "string"],
      ],
      single: [
        [/[^\\']+/, "string"],
        [/\\./, "string.escape"],
        [/'/, "string", "@pop"],
      ],
      blockSingle: [
        [/[^']+/, "string"],
        [/'''/, "string", "@pop"],
        [/'/, "string"],
      ],
      interpolation: [
        [/\}/, { token: "delimiter.bracket", next: "@pop" }],
        [/[A-Za-z_$][\w$]*/, "variable"],
        [/[^}]/, ""],
      ],
      slashy: [
        [/[^\\/]+/, "regexp"],
        [/\\./, "regexp.escape"],
        [/\//, "regexp", "@pop"],
      ],
    },
  });
}

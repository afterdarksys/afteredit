import * as monaco from "monaco-editor";

/** Monaco ships no Makefile support at all, and Makefiles are unavoidable in
 *  a devops toolchain. */
export function registerMakefile() {
  monaco.languages.register({
    id: "makefile",
    extensions: [".mk", ".mak"],
    filenames: ["Makefile", "makefile", "GNUmakefile", "Justfile", "justfile"],
    aliases: ["Makefile", "makefile"],
  });

  monaco.languages.setLanguageConfiguration("makefile", {
    comments: { lineComment: "#" },
    brackets: [["(", ")"], ["{", "}"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
  });

  monaco.languages.setMonarchTokensProvider("makefile", {
    defaultToken: "",
    tokenPostfix: ".makefile",

    directives: [
      "include", "-include", "sinclude", "ifeq", "ifneq", "ifdef", "ifndef",
      "else", "endif", "define", "endef", "export", "unexport", "override",
      "undefine", "vpath",
    ],
    specialTargets: [
      ".PHONY", ".DEFAULT", ".PRECIOUS", ".INTERMEDIATE", ".SECONDARY",
      ".SECONDEXPANSION", ".SUFFIXES", ".DELETE_ON_ERROR", ".IGNORE",
      ".SILENT", ".EXPORT_ALL_VARIABLES", ".NOTPARALLEL", ".ONESHELL", ".POSIX",
    ],

    tokenizer: {
      root: [
        [/#.*$/, "comment"],

        [/^\.[A-Z_]+\b/, { cases: { "@specialTargets": "keyword", "@default": "type.identifier" } }],
        [/^\s*[-a-z]+\b/, { cases: { "@directives": "keyword", "@default": "" } }],

        // $(VAR), ${VAR}, $(shell ...) -- and the automatic variables, which
        // are the ones people actually misread.
        [/\$[({][^)}]*[)}]/, "variable"],
        [/\$[@<^+*?%|]/, "variable.predefined"],
        [/\$\$/, "variable"],

        // A target: start of line, up to a ':' that is not part of ':='.
        [/^[^\s:#=][^:#=]*(?=:(?!=))/, "type.identifier"],

        [/(?::=|::=|\?=|\+=|!=|=)/, "operator"],
        [/^\t\s*[@+-]/, "operator"],

        [/"/, "string", "@dquote"],
        [/'/, "string", "@squote"],
        [/\b\d+\b/, "number"],
      ],

      dquote: [
        [/[^\\"$]+/, "string"],
        [/\$[({][^)}]*[)}]/, "variable"],
        [/\\./, "string.escape"],
        [/"/, "string", "@pop"],
      ],

      squote: [
        [/[^']+/, "string"],
        [/'/, "string", "@pop"],
      ],
    },
  });
}

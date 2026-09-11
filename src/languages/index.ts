import {swiftSnippets} from '../appleDevelopment';
import { infrastructureLanguage, infrastructureSnippets } from '../infrastructure';
import { shellSnippets } from '../smartEditing';
import { conf as yamlConf, language as yamlLanguage } from 'monaco-editor/languages/definitions/yaml/yaml';
import * as monaco from "monaco-editor";
import { registerToml } from "./toml";
import { registerMakefile } from "./makefile";
import { registerGroovy } from "./groovy";
import { registerRego } from "./rego";
import { registerHttpFile } from "./http";

/** Languages Monaco does not ship but a devops/devsecops toolchain needs. */
export function registerExtraLanguages() {
  monaco.languages.register({id:'ansible',aliases:['Ansible']});
  monaco.languages.setLanguageConfiguration('ansible',yamlConf);
  monaco.languages.setMonarchTokensProvider('ansible',yamlLanguage as monaco.languages.IMonarchLanguage);
  for(const [language,entries] of Object.entries({...infrastructureSnippets,swift:swiftSnippets,shell:shellSnippets}))monaco.languages.registerCompletionItemProvider(language,{provideCompletionItems(model,position){const word=model.getWordUntilPosition(position);return {suggestions:entries.map(entry=>({label:entry.label,kind:monaco.languages.CompletionItemKind.Snippet,detail:'Built-in '+language+' block',insertText:entry.body,insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,range:new monaco.Range(position.lineNumber,word.startColumn,position.lineNumber,word.endColumn)}))};}});
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  if (!known.has("toml")) registerToml();
  if (!known.has("makefile")) registerMakefile();
  if (!known.has("groovy")) registerGroovy();
  if (!known.has("rego")) registerRego();
  if (!known.has("http")) registerHttpFile();
}

/**
 * Filename patterns Monaco has no association for. It registers `filenames`
 * for only four things (Dockerfile, Gemfile, rakefile, jakefile and a few git
 * dotfiles), which leaves most of a devops repo unhighlighted. Prefix rules
 * also catch the variants people really use: Dockerfile.prod, .env.staging,
 * Jenkinsfile.release.
 */
const FILENAME_RULES: Array<[RegExp, string]> = [
  [/^dockerfile(\..+)?$/, "dockerfile"],
  [/^(gnu)?makefile(\..+)?$/, "makefile"],
  [/^justfile$/, "makefile"],
  [/^jenkinsfile(\..+)?$/, "groovy"],
  [/^vagrantfile$/, "ruby"],
  [/^brewfile$/, "ruby"],
  [/^(gemfile|rakefile|podfile|fastfile|appfile)$/, "ruby"],
  [/^\.env(\..+)?$/, "ini"],
  [/^(codeowners|\.gitignore|\.dockerignore|\.terraformignore|\.helmignore|\.npmignore|\.gcloudignore)$/, "ini"],
  [/^caddyfile$/, "ini"],
  [/^\.(bashrc|bash_profile|zshrc|zprofile|profile|aliases)$/, "shell"],
  [/^(procfile)$/, "yaml"],
  [/^\.(babelrc|prettierrc|eslintrc|swcrc)$/, "json"],
];

let lookup: Map<string, string> | null = null;

function buildLookup(): Map<string, string> {
  const map = new Map<string, string>();
  for (const language of monaco.languages.getLanguages()) {
    for (const extension of language.extensions ?? []) {
      map.set(extension.toLowerCase(), language.id);
    }
    for (const filename of language.filenames ?? []) {
      map.set(filename.toLowerCase(), language.id);
    }
  }
  return map;
}

/** Filename (or path) -> Monaco language id, "plaintext" when unknown. */
export function languageForFilename(filename: string): string {
  const infrastructure=infrastructureLanguage(filename);if(infrastructure)return infrastructure;
  // Languages register lazily, so don't cache an empty map.
  if (!lookup || lookup.size === 0) lookup = buildLookup();

  const base = (filename.split("/").pop() ?? filename).toLowerCase();

  for (const [pattern, language] of FILENAME_RULES) {
    if (pattern.test(base)) return language;
  }

  const exact = lookup.get(base);
  if (exact) return exact;

  // Try progressively shorter suffixes so `.pkr.hcl` resolves via `.hcl`.
  let from = base.indexOf(".");
  while (from >= 0) {
    const match = lookup.get(base.slice(from));
    if (match) return match;
    from = base.indexOf(".", from + 1);
  }
  return "plaintext";
}

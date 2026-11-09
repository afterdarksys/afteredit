import { detectInfrastructure } from './infrastructure.ts';
export type ServerConfig={command:string;args:string[];env?:Record<string,string>;initializationOptions?:unknown;documentLanguage?:string};
export type ConnectedServer={id:number;root:string;root_uri:string;language:string;documentLanguage?:string;capabilities:Record<string,any>};
export const serverPresets:Record<string,ServerConfig>={
 swift:{command:'/usr/bin/xcrun',args:['sourcekit-lsp']},'objective-c':{command:'/usr/bin/xcrun',args:['sourcekit-lsp']},
 hcl:{command:'terraform-ls',args:['serve'],documentLanguage:'terraform'},ansible:{command:'ansible-language-server',args:['--stdio'],documentLanguage:'ansible'},
 rust:{command:'rust-analyzer',args:[]},go:{command:'gopls',args:['serve']},python:{command:'pyright-langserver',args:['--stdio']},
 c:{command:'clangd',args:[]},cpp:{command:'clangd',args:[]},java:{command:'jdtls',args:[]},php:{command:'intelephense',args:['--stdio']},
 perl:{command:'perlnavigator',args:['--stdio']},groovy:{command:'java',args:['-jar','groovy-language-server.jar']},shell:{command:'bash-language-server',args:['start']},
 typescript:{command:'typescript-language-server',args:['--stdio']},javascript:{command:'typescript-language-server',args:['--stdio']},html:{command:'vscode-html-language-server',args:['--stdio']},css:{command:'vscode-css-language-server',args:['--stdio']},
};
export function detectBuildSystems(files:string[]):string[]{
 const found=new Set<string>(detectInfrastructure(files));
 const markers:Record<string,string>={'Package.swift':'Swift Package','Cargo.toml':'Rust / Cargo','go.mod':'Go','CMakeLists.txt':'C / C++ / CMake','Makefile':'Make','pom.xml':'Java / Maven','build.gradle':'Java / Groovy / Gradle','build.gradle.kts':'Java / Groovy / Gradle','package.json':'Node / HTML / CSS (npm)','pnpm-lock.yaml':'pnpm','yarn.lock':'Yarn','bun.lock':'Bun','bun.lockb':'Bun','composer.json':'PHP / Composer','pyproject.toml':'Python','uv.lock':'Python / uv','Makefile.PL':'Perl','build.sh':'Bash'};
 for(const file of files){if(markers[file])found.add(markers[file]);if(/\.(xcodeproj|xcworkspace)$/.test(file))found.add('Xcode');}return [...found];
}

/** Legend names we tell a server we understand. Painting uses the server's own legend. */
export const semanticTokenTypes = ['namespace','type','class','enum','interface','struct','typeParameter','parameter','variable','property','enumMember','event','function','method','macro','keyword','modifier','comment','string','number','regexp','operator','decorator'];
export const semanticTokenModifiers = ['declaration','definition','readonly','static','deprecated','abstract','async','modification','documentation','defaultLibrary'];
const MAX_SEMANTIC_INTS = 500_000;

/**
 * Capabilities sent with `initialize`. Dynamic registration stays off:
 * a server must not add methods this client did not agree to at connect time.
 * Semantic-token deltas are off; the editor always asks for a full set.
 */
export function clientCapabilities() {
  const link = { linkSupport: true };
  return {
    general: { positionEncodings: ['utf-16'] },
    textDocument: {
      synchronization: { didSave: true },
      completion: { completionItem: { snippetSupport: true } },
      hover: { contentFormat: ['markdown', 'plaintext'] },
      publishDiagnostics: { versionSupport: true },
      definition: link,
      typeDefinition: link,
      implementation: link,
      declaration: link,
      references: {},
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
      codeAction: { dataSupport: true, resolveSupport: { properties: ['edit'] }, isPreferredSupport: true },
      rename: { prepareSupport: true },
      formatting: {},
      semanticTokens: {
        requests: { range: false, full: { delta: false } },
        tokenTypes: semanticTokenTypes,
        tokenModifiers: semanticTokenModifiers,
        formats: ['relative'],
      },
      inlayHint: {},
      callHierarchy: {},
      typeHierarchy: {},
    },
  };
}

/**
 * LSP semantic tokens are a flat list of 5 integers per token.
 * A bad or huge payload paints nothing: a throw here blanks the editor.
 */
export function decodeSemanticTokens(payload: unknown): Uint32Array | null {
  if (payload == null) return new Uint32Array();
  if (typeof payload !== 'object') return null;
  const raw = (payload as { data?: unknown }).data;
  if (raw == null) return new Uint32Array();
  if (!Array.isArray(raw) || raw.length % 5 !== 0 || raw.length > MAX_SEMANTIC_INTS) return null;
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  }
  return Uint32Array.from(raw);
}

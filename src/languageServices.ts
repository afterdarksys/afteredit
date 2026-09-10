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

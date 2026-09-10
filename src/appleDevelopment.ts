export const swiftSnippets=[
 {label:'SwiftUI View',body:'import SwiftUI\n\nstruct ${1:ContentView}: View {\n\tvar body: some View {\n\t\tText("${2:Hello}")\n\t}\n}'},
 {label:'SwiftUI preview',body:'#Preview {\n\t${1:ContentView}()\n}'},
 {label:'XCTest case',body:'func test${1:Behavior}() throws {\n\tXCTAssertEqual(${2:actual}, ${3:expected})\n}'},
 {label:'Swift async function',body:'func ${1:load}() async throws -> ${2:String} {\n\t$0\n}'},
];
export type AppleSelection={project:string;scheme:string;target:string;configuration:string;destination:string};
export type AppleMetadata={schemes:string[];targets:string[];configurations:string[]};
export function appleMetadata(text:string):AppleMetadata{
 const data=JSON.parse(text),item=data.project??data.workspace??data;
 const strings=(v:unknown)=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
 return {schemes:strings(item.schemes),targets:Array.isArray(item.targets)?item.targets.map((t:any)=>typeof t==='string'?t:t.name).filter((t:any)=>typeof t==='string'):[],configurations:strings(item.configurations)};
}
export type AppleDestination={id:string;name:string;platform:string;available:boolean};
export function appleDestinations(text:string):AppleDestination[]{
 const result:AppleDestination[]=[];let available=true;
 for(const line of text.split('\n')){
  if(/Ineligible destinations/.test(line))available=false;
  for(const match of line.matchAll(/\{([^{}]+)\}/g)){
   const item=Object.fromEntries([...match[1].matchAll(/(?:^|,)\s*(\w+):\s*([^,]*)/g)].map(m=>[m[1],m[2].trim()]));
   if(item.id&&item.platform&&!result.some(d=>d.id===item.id&&d.platform===item.platform))result.push({id:item.id,name:item.name??item.id,platform:item.platform,available:available&&!item.error});
  }
 }return result;
}

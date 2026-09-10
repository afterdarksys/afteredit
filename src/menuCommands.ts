import catalogue from './nativeMenu.json';
export const menuCommands = catalogue.flatMap(group=>group.items.filter(item=>'id' in item).map(item=>({id:item.id!,title:item.title!,group:group.title})));
export const editorCommands = menuCommands.filter(c=>!['file.','view.','go.','terminal.','window.'].some(prefix=>c.id.startsWith(prefix)));
export type EditorMenuRequest = {id:string;sequence:number};

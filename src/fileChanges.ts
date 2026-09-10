export type FileBuffer = {value:string;saved:string;disk:boolean};
export function reconcileDisk(buffer:FileBuffer, expectedSaved:string, disk:string) {
  // An async check started before a save/reload must not undo that newer operation.
  if(buffer.saved!==expectedSaved)return {buffer,stale:true,conflict:false};
  if(disk===buffer.saved)return {buffer,stale:false,conflict:false};
  if(buffer.value===buffer.saved)return {buffer:{...buffer,value:disk,saved:disk},stale:false,conflict:false};
  return {buffer,stale:false,conflict:true};
}

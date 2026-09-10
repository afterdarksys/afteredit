import {parse,type ParseError} from 'jsonc-parser';
export function normalizeExtensionSettings(text:string):string{
 if(text.length>256000)throw new Error('Extension settings exceed 256 KB.');
 const errors:ParseError[]=[];
 const value=parse(text,errors,{allowTrailingComma:true});
 if(errors.length||!value||typeof value!=='object'||Array.isArray(value))throw new Error('Extension settings must be a JSON object; comments and trailing commas are allowed.');
 return JSON.stringify(value,null,2);
}
export function restoredExtensionSettings(text:string):string{
 try{return normalizeExtensionSettings(text);}catch{return '{}';}
}

/** Conservative shell expansion on Enter, only at the end of a completed header. */
export function shellClosingBlock(line:string,following:string):{indent:string;close:string}|null {
 const indent=line.match(/^[\t ]*/)?.[0]??'',text=line.trim();let close='';
 if(/^if\s+.+;\s*then\s*$/.test(text)||/^then\s*$/.test(text))close='fi';
 else if(/^(for|while|until|select)\s+.+;\s*do\s*$/.test(text)||text==='do')close='done';
 else if(/^case\s+.+\s+in\s*$/.test(text))close='esac';
 if(!close||following.split(/\r?\n/).some(l=>l.startsWith(indent)&&l.slice(indent.length).trim()===close))return null;
 return {indent,close};
}
export const shellSnippets=[
 {label:'if',body:'if [ ${1:condition} ]; then\n\t${2:command}\nfi'},
 {label:'for',body:'for ${1:item} in ${2:items}; do\n\t${3:command}\ndone'},
 {label:'while',body:'while ${1:condition}; do\n\t${2:command}\ndone'},
 {label:'case',body:'case "${1:value}" in\n\t${2:pattern})\n\t\t${3:command}\n\t\t;;\nesac'},
];

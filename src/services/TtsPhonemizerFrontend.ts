// Derived from bootphon/phonemizer v3.3.0, copyright 2015-2021 Mathieu Bernard.
// SPDX-License-Identifier: GPL-3.0-or-later
// Modified 2026-10-20: single-en-us-utterance JS port, bounded admission, external native worker.
// Mobile port, modified 2026-10-21. License: modules/pocket-phonemizer/vendor/COPYING.
interface Mark { mark: string; position: string }
export interface PhonemizerParts { chunks: string[]; marks: Mark[] }
const MARKS=';:,.!?¡¿—…"«»“”(){}[]';
const punctuation=new RegExp(`(\\s*[${MARKS.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}]+\\s*)+`,'gu');
export function admit(text: string){
 if(typeof text!=='string'||!text.trim()||text.length>240||/[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text))throw Error('input_limit');
 if(/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\p{Mark}\s$+<=>^|~`]/u.test(text))throw Error('unsupported_input');
 return text; // No NFKC/quote translation in Neu's phonemes branch.
}
export function split(text: string): PhonemizerParts{
 admit(text);let offset=0;const chunks=[],marks=[];const matches=[...text.matchAll(punctuation)];
 if(matches.length===1&&matches[0][0]===text)return {chunks:[],marks:[{mark:text,position:'A'}]};
 for(const [i,m]of matches.entries()){
  const prefix=text.slice(offset,m.index);if(prefix)chunks.push(prefix);
  marks.push({mark:m[0],position:i===0&&m.index===0?'B':i===matches.length-1&&m.index+m[0].length===text.length?'E':'I'});offset=m.index+m[0].length;
 }if(offset<text.length)chunks.push(text.slice(offset));return {chunks,marks};
}
export function postprocess(raw: string){
 let s=raw.trim().replace(/\n/g,' ').replace(/  /g,' ').replace(/_+/g,'_').replace(/_ /g,' ');
 s=s.replace(/\(.+?\)/g,''); // Strip generated language flags BEFORE restoring user's parentheses.
 if(!s)return '';
 return s.split(' ').map(word=>`${(word.trim()+'_').replace(/_/g,'')} `).join('');
}
export function restore(raw: string[],state: PhonemizerParts){
 let text=raw.map(postprocess),marks=state.marks.map(x=>({...x}));const out=[];
 while(text.length||marks.length){
  if(!marks.length){out.push(...text.map(s=>s.endsWith(' ')?s:s+' '));text=[];}
  else if(!text.length){out.push(marks.map(m=>m.mark).join(''));marks=[];}
  else {const {mark,position}=marks.shift()!;if(text[0].endsWith(' '))text[0]=text[0].slice(0,-1);
   if(position==='B')text[0]=mark+text[0];
   else if(position==='E'){out.push(text.shift()+mark+(mark.endsWith(' ')?'':' '));}
   else if(position==='A')out.push(mark+(mark.endsWith(' ')?'':' '));
   else if(text.length===1)text[0]+=mark;
   else {const first=text.shift();text[0]=first+mark+text[0];}
  }
 }
 const result=out.join(' ').replace(/\s+/gu,' ').trim();if(!result||result.length>4096)throw Error('output_limit');return result;
}

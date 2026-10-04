import { it,expect } from 'vitest';
import { documentChunks,renderDocumentChunk,sourceFragmentPages,streamingDocumentChunks,documentChunkWindows,validateChunkCitations } from '../src/services/document-chunks';
import type { DocumentFragment } from '../src/services/document-chunks';
async function* rows(input:DocumentFragment[]){yield*input;}
async function collect<T>(source:AsyncIterable<T>){const result:T[]=[];for await(const item of source)result.push(item);return result;}
it('streaming partition equals eager chunks including unicode and oversize fragments',async()=>{
 const input=[{id:'a',page_number:1,content:'文😀'.repeat(700)},{id:'b',page_number:2,content:'末页'}];
 const actual=await collect(streamingDocumentChunks(rows(input),500,100));expect(actual).toEqual(documentChunks(input,500,100));
 expect(actual.flat().map(f=>f.content).join('')).toBe(input.map(f=>f.content).join(''));expect(actual.every(chunk=>renderDocumentChunk(chunk).length+100<=500)).toBe(true);
});
it('keeps adjacent original boundaries citable without duplicating core coverage',async()=>{
 const input=[1,2,3].map(n=>({id:String(n),page_number:n,content:'第'+n+'页'+'文'.repeat(170)}));
 const windows=await collect(documentChunkWindows(streamingDocumentChunks(rows(input),270,70),20));
 expect(windows.length).toBeGreaterThan(1);expect(windows[1]!.boundaries.length).toBe(2);
 const middle=windows[1]!;const prev=middle.boundaries[0]!;validateChunkCitations([...middle.chunk,...middle.boundaries],[{fragmentId:prev.id,pageNumber:prev.page_number,quote:prev.content}]);
 expect(windows.flatMap(w=>w.chunk).map(f=>f.content).join('')).toBe(input.map(f=>f.content).join(''));
});
it('pages through duplicate sequence values using id cursor and LIMIT20 without eager loading',async()=>{
 const input=Array.from({length:101},(_,i)=>({id:String(i).padStart(4,'0'),seq:Math.floor(i/2),page_number:i+1,content:'文'.repeat(200)}));
 let queries=0;const requested:string[]=[];
 const db={prepare:(sql:string)=>{requested.push(sql);return {bind:(_version:string,_project:string,seq:number,id:string)=>({all:async()=>{queries++;return {results:input.filter(f=>f.seq>seq||(f.seq===seq&&f.id>id)).slice(0,20)};}})};}} as unknown as D1Database;
 let guards=0;const source=sourceFragmentPages(db,'version','project',async()=>{guards++;});
 const iterator=documentChunkWindows(streamingDocumentChunks(source,1000,100),20)[Symbol.asyncIterator]();
 const first=await iterator.next();expect(first.done).toBe(false);expect(queries).toBe(1);
 const all=[first.value!];for(let next=await iterator.next();!next.done;next=await iterator.next())all.push(next.value);
 expect(all.flatMap(w=>w.chunk).map(f=>f.content).join('')).toBe(input.map(f=>f.content).join(''));
 expect(queries).toBe(6);expect(guards).toBe(6);expect(requested.every(sql=>sql.includes('project_id=?2')&&sql.includes('ORDER BY seq,id LIMIT 20'))).toBe(true);
});
it('checks lifecycle before every page and stops without reading next page after rejection',async()=>{
 let count=0;const db={prepare:()=>({bind:()=>({all:async()=>({results:Array.from({length:20},(_,i)=>({id:String(i),seq:i,page_number:1,content:'text'}))})})})} as unknown as D1Database;
 await expect(collect(sourceFragmentPages(db,'v','p',async()=>{if(++count===2)throw new Error('deleted');}))).rejects.toThrow('deleted');expect(count).toBe(2);
});

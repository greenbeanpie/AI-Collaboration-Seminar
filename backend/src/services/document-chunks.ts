import { AppError } from '../core/errors';
export interface DocumentFragment {
    id: string;
    page_number: number | null;
    content: string;
    kind?: string;
}
export function renderDocumentChunk(fragments: DocumentFragment[], includeKind = false): string {
    return '<source>\n' + fragments.map(f => '[frag:' + f.id + ' 页' + (f.page_number ?? '-') + (includeKind ? ' ' + (f.kind ?? 'text') : '') + ']\n' + f.content).join('\n\n') + '\n</source>';
}
/** Partition every character. Oversized original fragments retain their ID for checked citations. */
export function documentChunks<T extends DocumentFragment>(fragments: T[], maxInputChars: number, systemChars: number, includeKind = false): T[][] {
    const capacity = maxInputChars - systemChars;
    const chunks: T[][] = [];
    let current: T[] = [];
    for (const fragment of fragments) {
        let offset = 0;
        do {
            const header = renderDocumentChunk([{ ...fragment, content: '' }], includeKind).length;
            const available = capacity - renderDocumentChunk(current, includeKind).length - (current.length ? 2 : 0) - header + '<source>\n\n</source>'.length;
            if (available < 1) {
                if (current.length) {
                    chunks.push(current);
                    current = [];
                    continue;
                }
                throw new AppError('SOURCE_PARSE_FAILED', '模型输入上限不足以容纳资料片段与提示词', 422, false);
            }
            let length = Math.min(fragment.content.length - offset, available);
            if (length > 0 && offset + length < fragment.content.length && /[\uD800-\uDBFF]/u.test(fragment.content[offset + length - 1]!))
                length--;
            if (length < 1 && fragment.content.length > offset) {
                if (current.length) { chunks.push(current); current = []; continue; }
                throw new AppError('SOURCE_PARSE_FAILED', '模型输入上限不足以容纳资料字符', 422, false);
            }
            const part = { ...fragment, content: fragment.content.slice(offset, offset + length) };
            current.push(part);
            offset += length;
            if (offset < fragment.content.length) {
                chunks.push(current);
                current = [];
            }
        } while (offset < fragment.content.length);
    }
    if (current.length)
        chunks.push(current);
    return chunks;
}
export function validateChunkCitations(fragments: DocumentFragment[], citations: {
    fragmentId: string;
    pageNumber: number | null;
    quote: string;
}[]): void {
    const normalize = (s: string) => s.replace(/\s+/gu, '').toLowerCase();
    for (const cite of citations) {
        if (!fragments.some(f => f.id === cite.fragmentId && f.page_number === cite.pageNumber && normalize(f.content).includes(normalize(cite.quote))))
            throw new AppError('AI_OUTPUT_INVALID', '引用不属于本次实际读取的原文片段', 502, false);
    }
}

/** Pull at most 20 rows at a time, preserving a stable (seq,id) keyset cursor. */
export async function* sourceFragmentPages(db: D1Database, versionId: string, projectId: string, beforePage?: () => Promise<void>): AsyncGenerator<DocumentFragment & { seq:number }> {
 let seq=-1,id='';
 while(true){
  await beforePage?.();
  const page=await db.prepare('SELECT id,page_number,kind,content,seq FROM source_fragments WHERE source_version_id=?1 AND project_id=?2 AND (seq>?3 OR (seq=?3 AND id>?4)) ORDER BY seq,id LIMIT 20').bind(versionId,projectId,seq,id).all<DocumentFragment & {seq:number}>();
  for(const fragment of page.results){seq=fragment.seq;id=fragment.id;yield fragment;}
  if(page.results.length<20)return;
 }
}
/** Same character-preserving partition as documentChunks, with one live chunk. */
export async function* streamingDocumentChunks<T extends DocumentFragment>(fragments:AsyncIterable<T>,maxInputChars:number,systemChars:number,includeKind=false):AsyncGenerator<T[]> {
 const capacity=maxInputChars-systemChars;let current:T[]=[];
 for await(const fragment of fragments){let offset=0;
  do {
   const header=renderDocumentChunk([{...fragment,content:''}],includeKind).length;
   const available=capacity-renderDocumentChunk(current,includeKind).length-(current.length?2:0)-header+'<source>\n\n</source>'.length;
   if(available<1){if(current.length){yield current;current=[];continue;}throw new AppError('SOURCE_PARSE_FAILED','模型输入上限不足以容纳资料片段与提示词',422,false);}
   let length=Math.min(fragment.content.length-offset,available);
   if(length>0&&offset+length<fragment.content.length&&/[\uD800-\uDBFF]/u.test(fragment.content[offset+length-1]!))length--;
   if(length<1&&fragment.content.length>offset){if(current.length){yield current;current=[];continue;}throw new AppError('SOURCE_PARSE_FAILED','模型输入上限不足以容纳资料字符',422,false);}
   current.push({...fragment,content:fragment.content.slice(offset,offset+length)});offset+=length;
   if(offset<fragment.content.length){yield current;current=[];}
  }while(offset<fragment.content.length);
 }
 if(current.length)yield current;
}
/** One-chunk lookahead keeps the previous boundary and adjacent reading context bounded. */
export async function* documentChunkWindows<T extends DocumentFragment>(chunks:AsyncIterable<T[]>,contextLimit=0):AsyncGenerator<{index:number;chunk:T[];boundaries:T[];single:boolean}> {
 const iterator=chunks[Symbol.asyncIterator]();let current=await iterator.next(),previous:T|undefined,index=0;
 while(!current.done){const next=await iterator.next();const boundaries:T[]=[];
  if(contextLimit&&previous){const text=previous.content.slice(-contextLimit).replace(/^[\uDC00-\uDFFF]/u,'');if(text)boundaries.push({...previous,content:text});}
  const after=next.done?undefined:next.value[0];
  if(contextLimit&&after){const text=after.content.slice(0,contextLimit).replace(/[\uD800-\uDBFF]$/u,'');if(text)boundaries.push({...after,content:text});}
  yield {index,chunk:current.value,boundaries,single:index===0&&next.done===true};
  previous=current.value.at(-1);current=next;index++;
 }
}

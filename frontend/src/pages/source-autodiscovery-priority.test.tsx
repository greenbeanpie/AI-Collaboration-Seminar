import {afterEach,expect,it,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {ProjectSourceContext} from './ProjectSourceContext';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('does not silently limit autonomous reading by automatically selecting recent source snapshots',async()=>{
 const sources=Array.from({length:6},(_,i)=>({sourceId:`s${i}`,currentVersionId:`v${i}`,title:`材料${i}`,kind:'paste',createdAt:'2026-10-02T00:00:00Z'}));
 vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL)=>Response.json({data:String(url).includes('/versions/')?(String(url).endsWith('/processing')?{textStatus:'ready'}:{charCount:10,pages:[]}):{items:sources,nextCursor:null},requestId:'fixture'})));
 const selection=vi.fn(),ready=vi.fn();
 render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ProjectSourceContext projectId="p" enabled selected={[]} onSelection={selection} onReady={ready}/></QueryClientProvider></MemoryRouter>);
 const boxes=await screen.findAllByRole('checkbox');
 await waitFor(()=>expect(ready).toHaveBeenCalledWith('v0',true));
 expect(boxes).toHaveLength(6);expect(selection).not.toHaveBeenCalled();for(const box of boxes)expect(box).not.toBeChecked();
 fireEvent.click(boxes[0]!);expect(selection).toHaveBeenCalledWith('v0',true);
});

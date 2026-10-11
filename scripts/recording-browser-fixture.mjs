import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const repo=path.resolve(import.meta.dirname,'..'),frontend=path.join(repo,'frontend');
const files=['recording-smoke.html','recording-smoke.tsx'];
const contents=await Promise.all(files.map(name=>readFile(path.join(import.meta.dirname,'fixtures','recordings',name))));
for(const name of files){try{await readFile(path.join(frontend,name));throw new Error(`Refusing to overwrite existing fixture: ${name}`);}catch(e){if(e.code!=='ENOENT')throw e;}}
for(let n=0;n<files.length;n++)await writeFile(path.join(frontend,files[n]),contents[n],{flag:'wx'});
const child=spawn(process.execPath,[path.join(frontend,'node_modules','vite','bin','vite.js'),'--host','127.0.0.1','--port','5181','--strictPort'],{cwd:frontend,stdio:'inherit',windowsHide:true});
console.log('Synthetic recording UI: http://127.0.0.1:5181/recording-smoke.html (local mock services and generated media only)');
let cleaning;
const cleanup=()=>cleaning??=(async()=>{for(let n=0;n<files.length;n++){const target=path.join(frontend,files[n]);try{if((await readFile(target)).equals(contents[n]))await unlink(target);}catch(e){if(e.code!=='ENOENT')throw e;}}})();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill();void cleanup();});
child.on('error',async error=>{console.error(error);await cleanup();process.exitCode=1;});
child.on('exit',async code=>{await cleanup();process.exitCode=code??0;});

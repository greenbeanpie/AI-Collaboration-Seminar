import {readFile,writeFile,mkdir} from 'node:fs/promises';
let text=await readFile(new URL('./src/client.js',import.meta.url),'utf8');
text=text.replace("import React, {useState,useEffect} from 'react';", "const React = require('react'); const {useState,useEffect} = React;").replace('export const inject','const inject').replace('export function apply','function apply');
await mkdir(new URL('./lib/',import.meta.url),{recursive:true});
await writeFile(new URL('./lib/client.js',import.meta.url),`window.__ModuleLoader__.load({id:'@greenbeanpie/dsh-team-office-bridge',factory:(require)=>{\n${text}\nreturn {inject,apply};\n}});\n`);

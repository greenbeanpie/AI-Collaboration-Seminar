/** User-operated setup helper. Default mode never creates or configures credentials. */
import { webcrypto } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
const args=process.argv.slice(2);
if (args.length===0 || (args.length===1&&args[0]==='--plan')) {
 console.log('System Web Push is not enabled by this script.');
 console.log('The deployment owner can explicitly generate an independent key pair with:');
 console.log('node backend/scripts/prepare-vapid.mjs --generate --output <new-private-directory>');
 console.log('Private material is written only to that new local directory, never printed or uploaded.');
 console.log('The owner enters VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY in the existing production backend Worker secrets.');
 console.log('Do not paste private-key.txt into chat, commit it, upload it to tickets, or reuse another application’s key pair.');
} else if(args.length===3&&args[0]==='--generate'&&args[1]==='--output'&&args[2]) {
 const directory=resolve(args[2]);
 // A new directory is mandatory; never overwrite existing keys.
 await mkdir(directory,{mode:0o700});
 const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const publicKey=Buffer.from(await webcrypto.subtle.exportKey('raw',pair.publicKey)).toString('base64url');
 const privateKey=(await webcrypto.subtle.exportKey('jwk',pair.privateKey)).d;
 if(!privateKey || Buffer.from(privateKey,'base64url').length!==32)throw new Error('Unexpected private key format');
 await writeFile(join(directory,'public-key.txt'),publicKey+'\n',{flag:'wx',mode:0o600});
 await writeFile(join(directory,'private-key.txt'),privateKey+'\n',{flag:'wx',mode:0o600});
 console.log('Wrote public-key.txt and private-key.txt to the owner-selected directory. No service configuration changed.');
} else {
 console.error('Usage: prepare-vapid.mjs [--plan] | --generate --output <new-private-directory>');
 process.exitCode=2;
}

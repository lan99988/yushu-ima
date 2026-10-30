import {mkdir,copyFile} from 'node:fs/promises';
import {build} from 'esbuild';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await build({entryPoints:['worker/app.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/server/index.js',legalComments:'inline'});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Built Worker ESM');

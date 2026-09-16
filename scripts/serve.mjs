import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build,root} from './build.mjs';
export async function startServer(port=4173,basePath='/'){
  await build();const base=resolve(root,'dist');
  const mount='/'+basePath.split('/').filter(Boolean).join('/'),prefix=mount==='/'?'':mount;
  if(!/^[/a-zA-Z0-9_-]*$/.test(prefix))throw new Error('Invalid mount path');
  const server=createServer(async(req,res)=>{
    try{
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(prefix&&pathname===prefix){res.writeHead(302,{Location:prefix+'/'});res.end();return;}
      if(!pathname.startsWith(prefix+'/')){res.writeHead(404);res.end('Not found');return;}
      const relative=pathname.slice(prefix.length);
      const path=resolve(base,'.'+(relative==='/'?'/index.html':relative));
      if(!path.startsWith(base+sep)&&path!==base){res.writeHead(403);res.end('Forbidden');return;}
      const data=await readFile(path);
      const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
      res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,url:'http://127.0.0.1:'+server.address().port+prefix+'/'};
}
if(globalThis.process?.argv?.[1]&&resolve(globalThis.process.argv[1])===fileURLToPath(import.meta.url)){const s=await startServer();console.log('MagicCards: '+s.url);}

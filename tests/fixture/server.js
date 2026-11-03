import http from "node:http";

const mode=process.argv[2]||"vulnerable", port=Number(process.env.HH_FIXTURE_PORT||4317);
const identities={"Bearer fixture-token-a":{id:"user-a",tenant:"a"},"Bearer fixture-token-b":{id:"user-b",tenant:"b"}};
const objects={a1:{id:"a1",owner:"user-a",tenant:"a",email:"alice@example.test",secret:"alpha-fixture-secret"},b1:{id:"b1",owner:"user-b",tenant:"b",email:"bob@example.test",secret:"beta-fixture-secret"}};
const server=http.createServer((request,response)=>{
  response.setHeader("content-type","application/json");
  if(request.url==="/health"){response.end(JSON.stringify({ok:true,mode}));return;}
  const identity=identities[request.headers.authorization];
  if(!identity){response.statusCode=401;response.end(JSON.stringify({error:"unauthorized"}));return;}
  if(request.url==="/api/"){response.end(JSON.stringify({objects:["/api/objects/a1","/api/objects/b1"]}));return;}
  const match=/^\/api\/objects\/([ab]1)$/.exec(request.url||"");
  if(!match){response.statusCode=404;response.end(JSON.stringify({error:"not found"}));return;}
  const object=objects[match[1]];
  if(mode==="fixed"&&object.owner!==identity.id){response.statusCode=403;response.end(JSON.stringify({error:"forbidden"}));return;}
  response.end(JSON.stringify(object));
});
server.listen(port,"127.0.0.1",()=>console.log(JSON.stringify({ready:true,mode,port})));
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>server.close(()=>process.exit(0)));

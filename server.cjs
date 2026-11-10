// Cadence Inventory v2: SQLite storage (Node 22.13+, no npm packages). Run: node server.js
// Cadence Inventory v2: SQLite storage (Node 22.13+, no npm packages)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = process.env.PORT || 3000;

// Use /tmp on Vercel so the filesystem is writable, or fallback to local ./data
const DIR = process.env.VERCEL ? path.join('/tmp', 'data') : (process.env.DATA_DIR || path.join(__dirname, 'data'));
const PH = path.join(DIR, 'photos');

if (!fs.existsSync(PH)) {
  fs.mkdirSync(PH, { recursive: true });
}

const db = new DatabaseSync(path.join(DIR, 'cadence.sqlite'));

// Run pragmas and table creations cleanly with backticks so bundlers don't choke on semicolons
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE COLLATE NOCASE, email TEXT DEFAULT '', role TEXT DEFAULT 'core', ok INT DEFAULT 0, salt TEXT, hash TEXT, google INT DEFAULT 0, created INT);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user INT REFERENCES users(id) ON DELETE CASCADE, exp INT);
  CREATE TABLE IF NOT EXISTS cats(name TEXT PRIMARY KEY, code TEXT UNIQUE);
  CREATE TABLE IF NOT EXISTS locs(name TEXT PRIMARY KEY, pos INT);
  CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, uid TEXT UNIQUE, cat TEXT, brand TEXT, model TEXT, serial TEXT, cond TEXT, loc TEXT, kind TEXT DEFAULT 'single', qty INT DEFAULT 1, qout INT DEFAULT 0, status TEXT DEFAULT 'in', holder TEXT, due INT DEFAULT 0, notes TEXT, contents TEXT, dueat TEXT, created INT, updated INT);
  CREATE INDEX IF NOT EXISTS i_cat ON items(cat);
  CREATE INDEX IF NOT EXISTS i_loc ON items(loc);
  CREATE INDEX IF NOT EXISTS i_due ON items(due);
  CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT REFERENCES items(id) ON DELETE CASCADE, type TEXT, txt TEXT, author TEXT, ts INT, photos TEXT DEFAULT '[]', phdel INT DEFAULT 0);
  CREATE INDEX IF NOT EXISTS e_item ON events(item, ts);
`);
try{db.exec('ALTER TABLE items ADD COLUMN dueat TEXT')}catch{}
const q=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
const meta=(k,v)=>v===undefined?(one('SELECT v FROM meta WHERE k=?',k)||{}).v:run('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',k,String(v));
if(meta('rev')===undefined)meta('rev',0);
const tx=f=>{db.exec('BEGIN');try{const r=f();db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}};
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
const addUser=(name,pw,role,ok,x={})=>{const salt=crypto.randomBytes(16).toString('hex');run('INSERT INTO users(name,email,role,ok,salt,hash,google,created) VALUES(?,?,?,?,?,?,?,?)',name,x.email||'',role,ok,salt,pw?hash(pw,salt):'',x.google?1:0,Date.now())};
const same=(a,b)=>a.length==b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const hid=()=>crypto.randomBytes(6).toString('hex');
const ITEM=['uid','cat','brand','model','serial','cond','loc','kind','qty','qout','status','holder','due','dueat','notes','contents'];
const photoIds=()=>new Set(q('SELECT photos FROM events').flatMap(e=>JSON.parse(e.photos)));
const rmPhotos=ids=>ids.forEach(id=>{try{fs.unlinkSync(path.join(PH,id+'.jpg'))}catch{}});

// one-time import from the old db.json (v1)
const old=path.join(DIR,'db.json');
if(fs.existsSync(old)&&!one('SELECT 1 x FROM users')){try{const o=JSON.parse(fs.readFileSync(old,'utf8'));tx(()=>{
 o.users.forEach(u=>run('INSERT OR IGNORE INTO users(name,email,role,ok,salt,hash,google,created) VALUES(?,?,?,?,?,?,?,?)',u.name,u.email||'',u.role,u.ok?1:0,u.salt,u.hash,u.google?1:0,Date.now()));
 Object.entries(o.cats||{}).forEach(([n,c])=>run('INSERT OR IGNORE INTO cats VALUES(?,?)',n,c));(o.locs||[]).forEach((l,i)=>run('INSERT OR IGNORE INTO locs VALUES(?,?)',l,i));if(o.google)meta('google',o.google);
 o.items.forEach(i=>{const id=hid();run(`INSERT INTO items(id,${ITEM}) VALUES(?${',?'.repeat(ITEM.length)})`,id,...ITEM.map(k=>k=='qout'?i.out||0:k=='due'?i.due?1:0:i[k]??null));
  (i.hist||[]).slice().reverse().forEach(h=>run('INSERT INTO events(item,type,txt,author,ts,photos,phdel) VALUES(?,?,?,?,?,?,?)',id,h.type,h.txt,h.by,h.at||Date.parse(h.t)||Date.now(),JSON.stringify(h.ph||[]),h.phDel||0))})});
 fs.renameSync(old,old+'.migrated');console.log('Imported data from db.json')}catch(e){console.error('Migration failed',e)}}
if(!one('SELECT 1 x FROM users')){const n=process.env.ADMIN_USER||'admin',p=process.env.ADMIN_PASSWORD||crypto.randomBytes(6).toString('hex');addUser(n,p,'admin',1);console.log(`\n=== First run. Admin login: ${n} / ${p} ===\n`)}
if(!one('SELECT 1 x FROM locs'))['Blue Crate 1','Blue Crate 2 (Multipurpose)','Music Room','Store Room'].forEach((l,i)=>run('INSERT INTO locs VALUES(?,?)',l,i));

const send=(res,c,o,h={})=>{res.writeHead(c,{'Content-Type':'application/json',...h});res.end(JSON.stringify(o))};
const cookies=r=>Object.fromEntries((r.headers.cookie||'').split(/;\s*/).filter(Boolean).map(c=>{const i=c.indexOf('=');return[c.slice(0,i),c.slice(i+1)]}));
const who=r=>one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user WHERE s.token=? AND s.exp>? AND u.ok=1',cookies(r).sid||'',Date.now());
const fails={},tooMany=k=>(fails[k]=(fails[k]||[]).filter(t=>Date.now()-t<6e5)).length>=8;
const start=(req,res,u)=>{const t=crypto.randomBytes(32).toString('hex');run('DELETE FROM sessions WHERE exp<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?)',t,u.id,Date.now()+30*864e5);
 const sec=req.headers['x-forwarded-proto']=='https'||process.env.COOKIE_SECURE?'; Secure':'';
 send(res,200,{name:u.name,role:u.role},{'Set-Cookie':`sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${sec}`})};
const body=r=>new Promise((ok,no)=>{let b='';r.on('data',c=>{b+=c;if(b.length>8e6){no();r.destroy()}});r.on('end',()=>{try{ok(JSON.parse(b||'{}'))}catch{ok({})}})});
const gid=()=>process.env.GOOGLE_CLIENT_ID||meta('google')||'';
const state=()=>{const ev={};q('SELECT * FROM events ORDER BY ts DESC,id DESC').forEach(e=>(ev[e.item]=ev[e.item]||[]).push({id:e.id,type:e.type,txt:e.txt,by:e.author,at:e.ts,ph:JSON.parse(e.photos),phDel:e.phdel}));
 return{rev:+meta('rev'),locs:q('SELECT name FROM locs ORDER BY pos').map(l=>l.name),cats:Object.fromEntries(q('SELECT * FROM cats').map(c=>[c.name,c.code])),
  items:q('SELECT * FROM items ORDER BY created,uid').map(i=>({id:i.id,...Object.fromEntries(ITEM.map(k=>[k,k=='due'?!!i.due:i[k]])),out:i.qout,hist:ev[i.id]||[]}))}};
const sync=(b,me)=>tx(()=>{const ids={},now=Date.now();
 if(b.del&&b.del.length){if(me.role!='admin')throw Object.assign(new Error('Only admins can delete items'),{code:403});
  b.del.forEach(id=>{rmPhotos(q('SELECT photos FROM events WHERE item=?',id).flatMap(e=>JSON.parse(e.photos)));run('DELETE FROM items WHERE id=?',id)})}
 (b.items||[]).forEach(i=>{const v=ITEM.map(k=>k=='qout'?+i.out||0:k=='due'?i.due?1:0:k=='qty'?+i.qty||0:i[k]??null);
  if(one('SELECT 1 x FROM items WHERE id=?',i.id))run(`UPDATE items SET ${ITEM.map(k=>k+'=?')},updated=? WHERE id=?`,...v,now,i.id);
  else run(`INSERT INTO items(id,${ITEM},created,updated) VALUES(?${',?'.repeat(ITEM.length)},?,?)`,String(i.id),...v,now,now)});
 (b.events||[]).forEach(e=>{const r=run('INSERT INTO events(item,type,txt,author,ts,photos) VALUES(?,?,?,?,?,?)',e.item,e.type,e.txt,e.by,e.at||now,JSON.stringify(e.ph||[]));ids[e.ref]=Number(r.lastInsertRowid)});
 (b.evUpdates||[]).forEach(e=>{const o=one('SELECT photos FROM events WHERE id=?',e.id);if(!o)return;rmPhotos(JSON.parse(o.photos).filter(p=>!(e.ph||[]).includes(p)));run('UPDATE events SET photos=?,phdel=? WHERE id=?',JSON.stringify(e.ph||[]),e.phDel||0,e.id)});
 if(b.cats){run('DELETE FROM cats');Object.entries(b.cats).forEach(([n,c])=>run('INSERT OR IGNORE INTO cats VALUES(?,?)',n,c))}
 if(b.locs){run('DELETE FROM locs');b.locs.forEach((l,i)=>run('INSERT OR IGNORE INTO locs VALUES(?,?)',l,i))}
 const rev=+meta('rev')+1;meta('rev',rev);return{rev,ids}});
setInterval(()=>{try{const keep=photoIds();for(const f of fs.readdirSync(PH))if(!keep.has(f.replace('.jpg',''))&&Date.now()-fs.statSync(path.join(PH,f)).mtimeMs>36e5)fs.unlinkSync(path.join(PH,f))}catch{}},36e5).unref();

http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://x'),p=url.pathname,m=req.method;
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','same-origin');
 if(!p.startsWith('/api/')){if(m!='GET')return res.writeHead(405).end();res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(fs.readFileSync(path.join(__dirname,'public','index.html')))}
 if(m!='GET'&&!(req.headers['content-type']||'').includes('application/json'))return send(res,415,{error:'JSON only'});
 const b=m=='GET'?{}:await body(req),me=who(req),ip=req.socket.remoteAddress;
 if(p=='/api/config')return send(res,200,{google:gid()});
 if(p=='/api/register'&&m=='POST'){const n=String(b.name||'').trim(),pw=String(b.password||'');
  if(!/^[\w .-]{2,30}$/.test(n))return send(res,400,{error:'Username: 2-30 letters, numbers, space . _ -'});if(pw.length<6)return send(res,400,{error:'Password needs 6+ characters'});
  if(one('SELECT 1 x FROM users WHERE name=?',n))return send(res,409,{error:'Username already taken'});addUser(n,pw,'core',0);return send(res,200,{ok:1})}
 if(p=='/api/login'&&m=='POST'){const k=ip+String(b.name).toLowerCase();if(tooMany(k))return send(res,429,{error:'Too many attempts. Try again in 10 minutes.'});
  const u=one('SELECT * FROM users WHERE name=? AND google=0',String(b.name||'').trim());if(!u||!same(u.hash,hash(String(b.password||''),u.salt))){fails[k].push(Date.now());return send(res,401,{error:'Wrong username or password'})}
  if(!u.ok)return send(res,403,{error:'Your account is waiting for admin approval'});return start(req,res,u)}
 if(p=='/api/google'&&m=='POST'){const g=gid();if(!g)return send(res,400,{error:'Google sign-in is not configured'});
  const r=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(String(b.credential||''))),t=await r.json();
  if(!r.ok||t.aud!=g||t.email_verified!='true')return send(res,401,{error:'Google sign-in failed'});
  let u=one('SELECT * FROM users WHERE google=1 AND email=?',t.email);if(!u){addUser(t.email,'','core',0,{email:t.email,google:1});u=one('SELECT * FROM users WHERE name=?',t.email)}
  return u.ok?start(req,res,u):send(res,200,{pending:1})}
 if(p=='/api/logout'){run('DELETE FROM sessions WHERE token=?',cookies(req).sid||'');return send(res,200,{ok:1},{'Set-Cookie':'sid=; Max-Age=0; Path=/'})}
 if(!me)return send(res,401,{error:'Not signed in'});
 if(p=='/api/me')return send(res,200,{name:me.name,role:me.role});
 if(p=='/api/rev')return send(res,200,{rev:+meta('rev')});
 if(p=='/api/state'&&m=='GET')return send(res,200,state());
 if(p=='/api/sync'&&m=='POST'){try{return send(res,200,sync(b,me))}catch(e){return send(res,e.code||400,{error:e.code?e.message:'Could not save: '+e.message})}}
 if(p=='/api/password'&&m=='POST'){const pw=String(b.password||'');if(me.google||pw.length<6)return send(res,400,{error:'Password needs 6+ characters'});const s=crypto.randomBytes(16).toString('hex');run('UPDATE users SET salt=?,hash=? WHERE id=?',s,hash(pw,s),me.id);return send(res,200,{ok:1})}
 const pm=p.match(/^\/api\/photos(?:\/([a-f0-9]{16}))?$/);
 if(pm){const id=pm[1],f=id&&path.join(PH,id+'.jpg');
  if(m=='POST'&&!id){const jm=/^data:image\/jpeg;base64,(.+)$/.exec(String(b.data||''));if(!jm)return send(res,400,{error:'JPEG only'});const buf=Buffer.from(jm[1],'base64');
   if(buf.length>2e6||buf[0]!=0xff||buf[1]!=0xd8)return send(res,400,{error:'Photo invalid or too large'});const nid=crypto.randomBytes(8).toString('hex');fs.writeFileSync(path.join(PH,nid+'.jpg'),buf);return send(res,200,{id:nid})}
  if(m=='GET'&&id){if(!fs.existsSync(f))return send(res,404,{error:'Gone'});res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=3600'});return res.end(fs.readFileSync(f))}
  if(m=='DELETE'&&id){if(fs.existsSync(f))fs.unlinkSync(f);return send(res,200,{ok:1})}}
 if(me.role!='admin')return send(res,403,{error:'Admins only'});
 if(p=='/api/users'&&m=='GET')return send(res,200,{users:q('SELECT name,email,role,ok,google FROM users ORDER BY id').map(u=>({...u,google:!!u.google})),google:meta('google')||''});
 if(p=='/api/settings'&&m=='PUT'){meta('google',String(b.google||'').trim());return send(res,200,{ok:1})}
 if(p=='/api/backup'&&m=='GET')return send(res,200,state());
 const mm=p.match(/^\/api\/users\/(.+)$/);
 if(mm){const u=one('SELECT * FROM users WHERE name=?',decodeURIComponent(mm[1]));if(!u)return send(res,404,{error:'No such user'});if(u.id==me.id)return send(res,400,{error:"You can't change your own account here"});
  if(m=='PATCH'){if(b.ok!=null)run('UPDATE users SET ok=? WHERE id=?',b.ok?1:0,u.id);if(b.role)run('UPDATE users SET role=? WHERE id=?',b.role=='admin'?'admin':'core',u.id);return send(res,200,{ok:1})}
  if(m=='DELETE'){run('DELETE FROM users WHERE id=?',u.id);return send(res,200,{ok:1})}}
 send(res,404,{error:'Not found'})}catch(e){console.error(e);try{send(res,500,{error:'Server error'})}catch{}}}).listen(PORT,()=>console.log('Cadence running on http://localhost:'+PORT));

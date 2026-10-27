import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=dirname(fileURLToPath(import.meta.url)), PUBLIC=join(ROOT,'public');
const data=resolve(process.env.DATA_DIR||join(ROOT,'.local-data'));mkdirSync(data,{recursive:true});
const db=new DatabaseSync(join(data,'fixmaster.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE COLLATE NOCASE,phone TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'client');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),device TEXT NOT NULL,description TEXT NOT NULL,visit TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','working','parts','done')),master TEXT NOT NULL DEFAULT '',created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY,request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id),rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),text TEXT NOT NULL);`);
const devices=['Ноутбук','Стационарный ПК','Принтер/МФУ','Планшет'];
const statuses={new:'Новая',working:'В работе',parts:'Ожидает запчасти',done:'Выполнена'};
const masters=['Алексей Соколов','Мария Волкова','Дмитрий Орлов'];
const hash=p=>{const s=randomBytes(16).toString('hex');return s+':'+scryptSync(p,s,64).toString('hex')};
const check=(p,h)=>{const [s,v]=h.split(':');return timingSafeEqual(Buffer.from(v,'hex'),scryptSync(p,s,64))};
const digest=x=>createHash('sha256').update(x).digest('hex');
const demo=process.env.DEMO_MODE!=='0';
if(!db.prepare('SELECT id FROM users LIMIT 1').get()){
 if(!demo&&(!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12))throw Error('Задайте ADMIN_PASSWORD от 12 символов для DEMO_MODE=0');
 const add=db.prepare('INSERT INTO users(name,email,phone,password,role) VALUES(?,?,?,?,?)');
 add.run('Администратор',process.env.ADMIN_EMAIL||'admin@fixmaster.test','+79990000000',hash(process.env.ADMIN_PASSWORD||'FixAdmin!2026'),'admin');
 if(demo){
  add.run('Александр Иванов','client@fixmaster.test','+79991234567',hash('FixClient!2026'),'client');
  const addRequest=db.prepare('INSERT INTO requests(user_id,device,description,visit,status,master) VALUES(?,?,?,?,?,?)');
  const future=new Date(Date.now()+86400000*7).toISOString().slice(0,10)+'T12:00';
  addRequest.run(2,devices[0],'Ноутбук сильно нагревается и выключается при работе',future,'working',masters[0]);
  addRequest.run(2,devices[2],'Принтер не захватывает бумагу из нижнего лотка',future,'done',masters[1]);
  addRequest.run(2,devices[3],'После падения появились полосы на экране',future,'parts',masters[2]);
  const ph=hash(randomBytes(24).toString('hex'));
  for(let i=0;i<12;i++){
   const u=add.run(['Анна Кузнецова','Илья Смирнов','Елена Попова','Михаил Белов'][i%4],`demo${i}@example.test`,'+79991112233',ph,'client');
   addRequest.run(Number(u.lastInsertRowid),devices[i%4],['Не включается после отключения питания','Требуется диагностика и чистка устройства','Появился шум при работе вентилятора'][i%3],future,Object.keys(statuses)[i%4],i%4===0?'':masters[i%3]);
  }
 }
}
const safe=u=>u?{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role}:null;
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
const invalid=(res,errors,status=422)=>send(res,status,{message:'Проверьте заполненные поля.',errors});
const text=x=>typeof x==='string'?x.trim():'';
const token=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('fix_session='))?.slice(12);
const userFor=req=>{const t=token(req);return t?db.prepare('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(digest(t),Date.now()):null};
const session=(res,u)=>{const t=randomBytes(32).toString('hex');db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(t),u.id,Date.now()+86400000);res.setHeader('Set-Cookie',`fix_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.SECURE_COOKIE==='1'?'; Secure':''}`)};
async function json(req){let n=0;const a=[];for await(const c of req){n+=c.length;if(n>16384)throw Object.assign(Error('Слишком большой запрос'),{status:413});a.push(c)}try{const b=JSON.parse(Buffer.concat(a));if(!b||typeof b!=='object'||Array.isArray(b))throw 0;return b}catch{throw Object.assign(Error('Некорректный JSON'),{status:400})}}
const query='SELECT a.*,r.rating,r.text AS review_text FROM requests a LEFT JOIN reviews r ON r.request_id=a.id';
const attempts=new Map();
function allowed(req){const now=Date.now();for(const [k,v] of attempts)if(v.until<now)attempts.delete(k);const key=req.socket.remoteAddress,v=attempts.get(key)||{count:0,until:now+60000};v.count++;attempts.set(key,v);return v.count<=30}
async function api(req,res,url){
 const path=url.pathname,u=userFor(req);
 if(req.method==='GET'&&path==='/api/health')return send(res,200,{ok:true});
 if(req.method==='GET'&&path==='/api/me')return send(res,200,{user:safe(u),demo,devices,statuses,masters});
 if(req.method!=='GET'){
  if(req.headers.origin&&!['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin))return send(res,403,{message:'Источник запроса не разрешён.'});
  if(!String(req.headers['content-type']||'').startsWith('application/json'))return send(res,415,{message:'Ожидается JSON.'});
 }
 if(req.method==='POST'&&path==='/api/register'){
  if(!allowed(req))return send(res,429,{message:'Слишком много попыток. Повторите через минуту.'});
  const b=await json(req),e={},name=text(b.name),email=text(b.email).toLowerCase(),phone=text(b.phone).replace(/[^\d+]/g,'');
  if(name.length<2||name.length>100)e.name='Укажите имя от 2 до 100 символов.';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)e.email='Введите корректный email.';
  if(!/^\+7\d{10}$/.test(phone))e.phone='Введите телефон в формате +7 999 123-45-67.';
  if(typeof b.password!=='string'||b.password.length<8||b.password.length>128)e.password='Пароль должен содержать от 8 до 128 символов.';
  if(b.confirm!==b.password)e.confirm='Пароли не совпадают.';
  if(b.consent!==true)e.consent='Подтвердите согласие на обработку данных.';
  if(Object.keys(e).length)return invalid(res,e);
  if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return invalid(res,{email:'Этот email уже зарегистрирован.'},409);
  const id=db.prepare('INSERT INTO users(name,email,phone,password) VALUES(?,?,?,?)').run(name,email,phone,hash(b.password)).lastInsertRowid;
  const created=db.prepare('SELECT * FROM users WHERE id=?').get(id);session(res,created);return send(res,201,{user:safe(created)});
 }
 if(req.method==='POST'&&path==='/api/login'){
  if(!allowed(req))return send(res,429,{message:'Слишком много попыток. Повторите через минуту.'});
  const b=await json(req),found=db.prepare('SELECT * FROM users WHERE email=?').get(text(b.email));
  if(typeof b.password!=='string'||b.password.length>128||!found||!check(b.password,found.password))return invalid(res,{email:'Неверный email или пароль.'},401);
  session(res,found);return send(res,200,{user:safe(found)});
 }
 if(!u)return send(res,401,{message:'Войдите в аккаунт, чтобы продолжить.'});
 if(req.method==='POST'&&path==='/api/logout'){const t=token(req);if(t)db.prepare('DELETE FROM sessions WHERE token=?').run(digest(t));res.setHeader('Set-Cookie','fix_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');return send(res,200,{ok:true})}
 if(req.method==='GET'&&path==='/api/requests')return send(res,200,{requests:db.prepare(query+' WHERE a.user_id=? ORDER BY a.id DESC').all(u.id)});
 if(req.method==='POST'&&path==='/api/requests'){
  const b=await json(req),e={},description=text(b.description),visit=text(b.visit),date=new Date(visit);
  if(!devices.includes(b.device))e.device='Выберите устройство из списка.';
  if(description.length<10||description.length>2000)e.description='Опишите неисправность от 10 до 2000 символов.';
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(visit)||!Number.isFinite(+date)||date.getFullYear()!==Number(visit.slice(0,4))||date.getMonth()+1!==Number(visit.slice(5,7))||date.getDate()!==Number(visit.slice(8,10)))e.visit='Выберите корректные дату и время.';
  else if(+date<Date.now())e.visit='Выберите будущие дату и время.';
  else if(+date>Date.now()+366*86400000)e.visit='Выберите дату в пределах года.';
  if(Object.keys(e).length)return invalid(res,e);
  if(db.prepare('SELECT id FROM requests WHERE user_id=? AND device=? AND visit=?').get(u.id,b.device,visit))return invalid(res,{visit:'На это время уже есть заявка для данного устройства.'},409);
  const id=db.prepare('INSERT INTO requests(user_id,device,description,visit) VALUES(?,?,?,?)').run(u.id,b.device,description,visit).lastInsertRowid;return send(res,201,{id:Number(id)});
 }
 const review=path.match(/^\/api\/requests\/(\d+)\/review$/);
 if(req.method==='POST'&&review){
  const a=db.prepare('SELECT * FROM requests WHERE id=? AND user_id=?').get(Number(review[1]),u.id);
  if(!a)return send(res,404,{message:'Заявка не найдена.'});
  if(a.status!=='done')return send(res,403,{message:'Отзыв можно оставить после выполнения заявки и выдачи устройства.'});
  if(db.prepare('SELECT id FROM reviews WHERE request_id=?').get(a.id))return send(res,409,{message:'Отзыв уже опубликован.'});
  const b=await json(req),e={},t=text(b.text);if(!Number.isInteger(b.rating)||b.rating<1||b.rating>5)e.rating='Выберите оценку от 1 до 5.';if(t.length<10||t.length>2000)e.text='Отзыв должен содержать от 10 до 2000 символов.';
  if(Object.keys(e).length)return invalid(res,e);db.prepare('INSERT INTO reviews(request_id,rating,text) VALUES(?,?,?)').run(a.id,b.rating,t);return send(res,201,{ok:true});
 }
 if(path.startsWith('/api/admin/')&&u.role!=='admin')return send(res,403,{message:'Доступ разрешён только администратору.'});
 if(req.method==='GET'&&path==='/api/admin/requests'){
  const status=url.searchParams.get('status')||'',device=url.searchParams.get('device')||'',q=(url.searchParams.get('q')||'').trim().slice(0,100),f=[],p=[];
  if(status&&!Object.hasOwn(statuses,status))return invalid(res,{status:'Неизвестный статус.'});
  if(device&&!devices.includes(device))return invalid(res,{device:'Неизвестное устройство.'});
  if(status){f.push('a.status=?');p.push(status)}if(device){f.push('a.device=?');p.push(device)}if(q){f.push('(u.name LIKE ? OR u.email LIKE ? OR a.description LIKE ?)');p.push(...Array(3).fill('%'+q+'%'))}
  const where=f.length?' WHERE '+f.join(' AND '):'',total=db.prepare('SELECT COUNT(*) n FROM requests a JOIN users u ON u.id=a.user_id'+where).get(...p).n;
  const pages=Math.max(1,Math.ceil(total/5)),page=Math.min(pages,Math.max(1,Math.floor(Number(url.searchParams.get('page')))||1));
  const rows=db.prepare('SELECT a.*,u.name,u.phone,u.email,r.rating FROM requests a JOIN users u ON u.id=a.user_id LEFT JOIN reviews r ON r.request_id=a.id'+where+' ORDER BY a.id DESC LIMIT 5 OFFSET ?').all(...p,(page-1)*5);
  const counts={total:0,new:0,working:0,parts:0,done:0};for(const r of db.prepare('SELECT status,COUNT(*) n FROM requests GROUP BY status').all()){counts[r.status]=r.n;counts.total+=r.n}
  return send(res,200,{requests:rows,total,page,pages,counts});
 }
 const update=path.match(/^\/api\/admin\/requests\/(\d+)$/);
 if(req.method==='PATCH'&&update){
  const a=db.prepare('SELECT * FROM requests WHERE id=?').get(Number(update[1]));if(!a)return send(res,404,{message:'Заявка не найдена.'});
  const b=await json(req),status=b.status??a.status,master=b.master??a.master,e={};
  if(!Object.hasOwn(statuses,status))e.status='Выберите статус.';
  if(master!==''&&!masters.includes(master))e.master='Выберите мастера из списка.';
  if(status!=='new'&&!master)e.master='Сначала назначьте мастера.';
  if(Object.keys(e).length)return invalid(res,e);
  if(status!=='done'&&db.prepare('SELECT id FROM reviews WHERE request_id=?').get(a.id))return send(res,409,{message:'Заявка с отзывом должна оставаться выполненной.'});
  db.prepare('UPDATE requests SET status=?,master=? WHERE id=?').run(status,master,a.id);return send(res,200,{ok:true,message:master!==a.master?`Мастер ${master||'не назначен'} · заявка №${a.id}`:'Статус заявки обновлён.'});
 }
 return send(res,404,{message:'Адрес не найден.'});
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
 try{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end()}
 const path=resolve(PUBLIC,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
 if(!path.startsWith(PUBLIC+sep)||!existsSync(path)||!statSync(path).isFile()){res.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});return res.end('<html lang="ru"><meta charset="utf-8"><title>Не найдено</title><h1>Страница не найдена</h1><a href="/">На главную</a></html>')}
 res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:readFileSync(path));
 }catch(e){console.error(e.message);if(!res.headersSent)send(res,e.status||500,{message:e.status?e.message:'Не удалось выполнить запрос.'});else res.end()}
});
server.listen(Number(process.env.PORT??3200),process.env.HOST||'127.0.0.1',()=>console.log(`FixMaster http://localhost:${server.address().port}`));
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>server.close(()=>{db.close();process.exit(0)}));


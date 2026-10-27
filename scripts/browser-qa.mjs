import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
const base=process.env.BASE_URL||'http://localhost:3200';
mkdirSync('output/playwright',{recursive:true});
const results=[],errors=[];
try{
 for(const [label,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const ctx=await browser.newContext({viewport,locale:'ru-RU'}),p=await ctx.newPage();
  p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.type()==='error'&&!m.text().includes('status of 422'))errors.push(m.text())});
  for(const page of ['index','services','register','login','privacy']){
   await p.goto(base+'/'+page+'.html');await p.locator('.logo').waitFor();
   if(['register','login'].includes(page))await p.locator('form').waitFor();
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' overflow '+page);
   assert.ok(await p.locator('img').evaluateAll(imgs=>imgs.every(i=>i.complete&&i.naturalWidth>0)));
   await p.screenshot({path:`output/playwright/${label}-${page}.png`,fullPage:true});results.push(label+' '+page);
  }
  await p.goto(base+'/login.html');await p.getByRole('button',{name:'Заполнить данные клиента'}).click();await p.getByRole('button',{name:'Войти в аккаунт',exact:true}).click();await p.waitForURL('**/requests.html');await p.locator('.request').first().waitFor();
  await p.screenshot({path:`output/playwright/${label}-requests.png`,fullPage:true});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));results.push(label+' requests');
  await p.goto(base+'/new-request.html');await p.locator('#device').waitFor();await p.screenshot({path:`output/playwright/${label}-new-request.png`,fullPage:true});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));results.push(label+' new-request');
  if(label==='mobile'){
   await p.getByRole('button',{name:'Отправить заявку'}).click();await p.locator('#error-device').filter({hasText:'Выберите'}).waitFor();
   await p.locator('#device').selectOption('Ноутбук');await p.locator('#description').fill('Проверка интерфейса: при работе ноутбук перегревается');
   const dt=new Date(Date.now()+86400000*20);dt.setMinutes(dt.getMinutes()-dt.getTimezoneOffset());await p.locator('#visit').fill(dt.toISOString().slice(0,16));await p.getByRole('button',{name:'Отправить заявку'}).click();await p.waitForURL('**/requests.html');await p.locator('.request').filter({hasText:'Проверка интерфейса'}).waitFor();results.push('UI создание заявки');
   await p.getByRole('button',{name:'Оценить ремонт'}).click();await p.getByRole('dialog').waitFor();await p.screenshot({path:'output/playwright/mobile-review-dialog.png',fullPage:true});await p.getByRole('button',{name:'Закрыть',exact:true}).click();results.push('UI отзыв только у выполненной заявки');
  }
  await p.goto(base+'/login.html');await p.getByRole('button',{name:'Заполнить данные администратора'}).click();await p.getByRole('button',{name:'Войти в аккаунт',exact:true}).click();await p.waitForURL('**/admin.html');await p.locator('.save').first().waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:`output/playwright/${label}-admin.png`,fullPage:true});results.push(label+' admin');
  await p.getByRole('button',{name:'Далее →'}).click();await p.getByText('Страница 2 из').waitFor();results.push(label+' pagination');
  await p.locator('.filters [name=device]').selectOption('Ноутбук');await p.locator('.filters [name=status]').selectOption('new');await p.getByRole('button',{name:'Найти',exact:true}).click();await p.getByText('Страница 1 из').waitFor();assert.ok((await p.locator('#admin-list h3').allTextContents()).every(x=>x==='Ноутбук'));results.push(label+' filters');
  const row=p.locator('[data-request]').first();await row.locator('[name=master]').selectOption('Алексей Соколов');await row.getByRole('button',{name:'Сохранить',exact:true}).click();await p.locator('.toast.show').waitFor();results.push(label+' assignment toast');
  if(label==='mobile'){
   await p.goto(base+'/index.html');await p.locator('.slide.current').waitFor();const before=await p.locator('.slide.current .slide-label').textContent();await p.waitForTimeout(3100);assert.notEqual(await p.locator('.slide.current .slide-label').textContent(),before);await p.getByRole('button',{name:'Приостановить смену слайдов'}).click();const paused=await p.locator('.slide.current .slide-label').textContent();await p.waitForTimeout(3100);assert.equal(await p.locator('.slide.current .slide-label').textContent(),paused);await p.getByRole('button',{name:'Следующий слайд',exact:true}).click();assert.notEqual(await p.locator('.slide.current .slide-label').textContent(),paused);results.push('slider interval 3000ms, pause, manual control');
   await p.getByRole('button',{name:'Открыть меню'}).click();assert.equal(await p.locator('.menu').getAttribute('aria-expanded'),'true');results.push('mobile menu');
  }
  await ctx.close();
 }
 assert.deepEqual(errors,[]);
 writeFileSync('output/playwright/results.json',JSON.stringify({passed:results.length,results,errors},null,2));console.log(JSON.stringify({passed:results.length,results,errors},null,2));
}finally{await browser.close()}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cw-guild-ships-'));process.env.CW_DATA_DIR=dir;
const {loadProtocol}=await import('../src/proto.mjs');
const {readGuildShips,serviceGuildShips,guildShipBatch,guildShipDemands,watchGuildShipPushes,guildShipDiagnostics}=await import('../src/guild-ships.mjs');
const {createUsageLedger,hasExtraWork}=await import('../src/automation-settings.mjs');
const {guildShipFixture,config}=await import('./fixtures/guild-ships.mjs');
const {pendingOrderMaterialSpends}=await import('../src/order-reservations.mjs');
const protocol=loadProtocol();let passed=0;
const check=async(name,work)=>{await work();passed++;console.log('通过：'+name);};
const fixture=options=>guildShipFixture(protocol,dir,options);
const read=f=>readGuildShips(f.client,protocol,config,f.options);
const run=f=>serviceGuildShips(f.client,protocol,config,f.options);
const publishPeriod=(f,period)=>{
 watchGuildShipPushes(f.client);
 f.client.emit('message',{name:'SCGuildShipActivity',body:{period:{period:f.state.period,startTime:f.state.now-3600,...period}}});
};
const withServerClock=async(f,work)=>{
 const originalNow=Date.now;Date.now=()=>f.state.now*1000;f.advance(0);
 try{await work();}finally{Date.now=originalNow;}
};
try{
 await check('协议类型、完整int64身份、船舱和响应字段真实编解码',async()=>{const f=fixture();f.state.ships=[f.roundtripShip(f.state.ships[0])];const view=await read(f);assert.equal(view.ships[0].leaderId,'9007199254742222');assert.equal(view.candidates[0].costs[0].missing,0);for(const name of ['GuildShipRequest','GuildShipResponse','GuildShipOrderRequest','GuildShipSeekRequest','SCGuildShipActivity'])assert.equal(typeof protocol[name].encode,'function');});
 await check('默认关闭不读写，真实18级门槛，未入联盟和关闭活动不派船',async()=>{const f=fixture();f.settings.guildShip.enabled=false;assert((await run(f)).skipped);assert.equal(f.state.calls.length,0);f.settings.guildShip.enabled=true;f.player.level=17;assert.match((await run(f)).reason,/18/);f.player.level=30;f.player.guildId='0';assert.match((await run(f)).reason,/联盟/);f.player.guildId='9007199254742000';f.state.period=0;assert.match((await run(f)).reason,/未开放/);assert.equal(f.state.writes.length,0);});
 await check('按赛季动态批次，午夜沿用前一晚最后批次',async()=>{const f=fixture({hour:0,minute:30});const view=await read(f);assert.equal(view.batch.start,Date.parse('2026-11-13T23:00:00+08:00')/1000);const six=fixture({worldId:'6000001',hour:8,minute:30});assert.equal((await read(six)).batch.next,Date.parse('2026-11-14T09:00:00+08:00')/1000);assert.equal(guildShipBatch(f.state.now,[8,11,14,17,20,23]).start,view.batch.start);});
 await check('船员成功需本人船位证据，完整库存核销并防重复',async()=>{const f=fixture();const result=await run(f);assert.equal(result.ok,true,result.error);assert.equal(f.state.writes.length,1);assert.deepEqual(f.state.writes[0].body,{shipId:1,crewId:1});assert.equal(f.state.stock.橡胶圈,45);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);await run(f);assert.equal(f.state.writes.length,1);});
 await check('船长英雄普通星+专属星按客户端相加，角色开关互不代开',async()=>{const f=fixture();f.settings.guildShip.crew=false;f.state.ships=[f.ship({captain:false,heroStar:6})];assert.equal((await read(f)).candidates.length,0);f.state.ships=[f.ship({captain:false,heroStar:5})];assert.equal((await run(f)).ok,true);assert.equal(f.state.writes[0].name,'GuildShipSeekRequest');assert.equal(f.state.stock.橡胶圈,50);const g=fixture();g.settings.guildShip.captain=false;g.state.ships=[g.ship({captain:false})];assert.equal((await read(g)).candidates.length,0);});
 await check('水姆币最低奖励、奖励白名单和材料黑名单按开关生效',async()=>{const f=fixture();f.state.ships=[f.ship({coins:59})];assert.equal((await read(f)).candidates.length,0);f.settings.guildShip.coinFilter=false;assert((await read(f)).candidates.length>0);f.settings.guildShip.rewardFilter=true;f.settings.guildShip.rewardItems=['万能碎片'];assert.equal((await read(f)).candidates.length,0);f.settings.guildShip.rewardItems=['抽卡券'];f.settings.guildShip.disabledMaterials=['橡胶圈'];assert.equal((await read(f)).candidates.length,0);assert.equal(f.state.writes.length,0);});
 await check('中大/中小/小船模式和红船优先保留下一批队列',async()=>{const f=fixture();f.state.ships=[f.ship({id:1,type:1}),f.ship({id:2,type:2}),f.ship({id:3,type:3})];for(const [mode,types]of [['mediumLarge',[3,2]],['mediumSmall',[2,1]],['small',[1]]]){f.settings.guildShip.mode=mode;assert.deepEqual([...new Set((await read(f)).candidates.map(row=>row.type))],types);}f.settings.guildShip.mode='redFirst';const own=f.ship({id:99,type:3});own.leader={playerId:f.player.playerId};own.state=2;own.mvEndTime=f.state.now+9*3600;f.state.ownRun=[own];assert.deepEqual([...new Set((await read(f)).candidates.map(row=>row.type))],[3,1]);f.state.ownRun.push({...own,shipId:100});assert.equal((await read(f)).candidates.length,0);});
 await check('20分钟全程兜底放宽角色/奖励与预留，仍保留水姆币和禁用材料',async()=>{const f=fixture({minute:19});Object.assign(f.settings.guildShip,{mode:'full',crew:false,captain:false,rewardFilter:true,rewardItems:['不匹配']});assert.equal((await read(f)).candidates.length,0);f.advance(60);assert((await read(f)).candidates.length>0);f.state.ships[0].reward.asset[0].num=59;assert.equal((await read(f)).candidates.length,0);f.state.ships[0].reward.asset[0].num=80;f.settings.guildShip.disabledMaterials=['橡胶圈'];assert.equal((await read(f)).candidates.length,0);});
 await check('末日宽松兜底必须有服务器结束推送且只申请一船',async()=>{const f=fixture({hour:23,minute:26});Object.assign(f.settings.guildShip,{mode:'full',crew:false,captain:false});f.state.ships=[f.ship({id:1,coins:1}),f.ship({id:2,coins:1})];assert.equal((await read(f)).candidates.length,0);watchGuildShipPushes(f.client);f.client.emit('message',{name:'SCGuildShipActivity',body:{period:{period:3,startTime:f.state.now-3600,endTime:Date.parse('2026-11-15T00:00:00+08:00')/1000}}});assert.equal((await run(f)).ok,true);assert.match((await run(f)).reason,/一船/);assert.equal(f.state.writes.length,1);});
 await check('红船自定义时间只约束申请船长，协议没有手动出航',async()=>{const f=fixture({hour:19});f.state.ships=[f.ship({captain:false})];Object.assign(f.settings.guildShip,{redStartEnabled:true,redStartTime:'20:00'});assert.equal((await read(f)).candidates.length,0);f.advance(3600);assert.equal((await run(f)).ok,true);assert.equal(f.state.writes[0].name,'GuildShipSeekRequest');assert(!protocol.GuildShipRunRequest);});
 await check('材料预留和红船缺料需求遵守真实空舱与禁用物料',async()=>{const f=fixture();f.state.stock.橡胶圈=5;f.state.workerOrder=[{index:1,requirements:[{type:0,id:'橡胶圈',num:3}]}];f.settings.guildShip.produceMissing=true;const view=await read(f);assert.equal(view.candidates[0].costs[0].missing,3);assert.deepEqual(guildShipDemands(view,f.settings),[{source:'guildShip',requirements:[{id:'橡胶圈',num:5}],reserved:[{id:'橡胶圈',num:3}]}]);const r=await run(f);assert(r.skipped);assert.equal(f.state.writes.length,0);f.settings.guildShip.disabledMaterials=['橡胶圈'];assert.deepEqual(guildShipDemands(await read(f),f.settings),[]);f.settings.guildShip.enabled=false;assert.deepEqual(guildShipDemands(view,f.settings),[]);});
 await check('发送前关闭或船位改变不发送',async()=>{const f=fixture();let reads=0;f.state.hook=async name=>{if(name==='GuildShipRequest'&&++reads===3)f.settings.guildShip.enabled=false;};await run(f);assert.equal(f.state.writes.length,0);const g=fixture();let scans=0;g.state.hook=async name=>{if(name==='GuildShipRequest'&&++scans===3)g.state.ships[0].cabin.forEach(row=>{row.player={playerId:'999'}});};await run(g);assert.equal(g.state.writes.length,0);});
 await check('未知结果重建账本/客户端、跨日仍不重试，确定未发送释放',async()=>{const f=fixture();f.state.writeHook=async()=>{throw new Error('超时');};assert((await run(f)).pending);assert.equal(f.ledger.snapshot().uncertain,1);f.options.ledger=createUsageLedger('qa',{file:f.file,now:()=>f.state.now*1000});f.advance(86400);assert((await run(f)).pending);assert.equal(f.state.writes.length,1);const g=fixture();g.state.writeHook=async()=>{throw Object.assign(new Error('未发送'),{notSent:true});};assert.equal((await run(g)).pending,false);assert.equal(g.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(g.player).length,0);});
 await check('未知但实际成功可由本人船位核销，不能用其他船员占位替代',async()=>{const f=fixture();f.state.writeHook=async(name,body)=>{f.state.ships[0].cabin[body.crewId-1].player={playerId:f.player.playerId};f.state.stock.橡胶圈-=5;throw new Error('响应丢失');};assert((await run(f)).pending);f.state.writeHook=async()=>{};await run(f);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(f.state.writes.length,1);assert.equal(pendingOrderMaterialSpends(f.player).length,0);const g=fixture();g.state.writeHook=async()=>{g.state.ships[0].cabin[0].player={playerId:'999'};throw new Error('响应丢失');};await run(g);assert((await run(g)).pending);});
 await check('回读未发送错误不取消已上船的持久预占',async()=>{const f=fixture();f.state.hook=async name=>{if(name==='GuildShipRequest'&&f.state.writes.length)throw Object.assign(new Error('读取未发送'),{notSent:true});};assert((await run(f)).pending);assert.equal(f.ledger.snapshot().uncertain,1);f.state.hook=async()=>{};await run(f);assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(f.state.writes.length,1);});
 await check('基础生产调查独立读取红船缺料，关闭补料不保留旧本人船舱需求',async()=>{const {surveyBaseAutomation,baseDemands}=await import('../src/base-automation.mjs');const f=fixture();Object.assign(f.settings.factory,{demandFirst:false,demandPriority:[],speedUpSources:[],keepStock:0});f.settings.alliance.enabled=false;f.settings.guildShip.produceMissing=true;f.state.stock.橡胶圈=0;const world={now:f.state.now,buildings:[],factories:[],stockCap:100};const snapshot=await surveyBaseAutomation(f.client,protocol,config,f.player,f.settings,world,{ledger:f.ledger,enabled:f.options.enabled});assert(baseDemands(snapshot,config,f.settings).some(row=>row.source==='guildShip'));f.settings.guildShip.produceMissing=false;const before=f.state.calls.length;const off=await surveyBaseAutomation(f.client,protocol,config,f.player,f.settings,world,{ledger:f.ledger,enabled:f.options.enabled});assert(!baseDemands(off,config,f.settings).some(row=>row.source==='guildShip'));assert(!f.state.calls.slice(before).some(row=>row.name==='GuildShipRequest'));});
 await check('仅开启商船活动即为有效自动任务，不依赖挂机联盟总开关',async()=>{
  const {automationControlView,idleAutomationControls}=await import('../src/automation-controls.mjs');
  const f=fixture();
  Object.assign(f.settings.loop,{world:false,dailies:false,tasks:false,heroes:false});
  f.settings.alliance.enabled=false;f.settings.guildFort.enabled=false;f.settings.heroRaid.enabled=false;
  f.settings.silicon.enabled=false;f.settings.progression.enabled=false;
  assert(hasExtraWork(f.settings));
  assert.deepEqual(automationControlView(f.settings).find(row=>row.key==='guildShip.enabled').blockedBy,[]);
  assert(!idleAutomationControls.some(row=>row.key==='guildShip.enabled'));
  assert.equal((await run(f)).ok,true);
  f.settings.guildShip.enabled=false;assert.equal(hasExtraWork(f.settings),false);
 });
 await check('商船按服务端开始和结束时间门控，未开放不读写，到期自动参与',async()=>{
  const f=fixture();f.settings.alliance.enabled=false;
  const start=f.state.now+30,end=f.state.now+900;
  watchGuildShipPushes(f.client);
  f.client.emit('message',{name:'SCGuildShipActivity',body:{period:{period:3,startTime:start,endTime:end}}});
  assert.match((await run(f)).reason,/未开放/);assert.equal(f.state.calls.length,0);
  f.advance(30);assert.equal((await run(f)).ok,true);
  f.advance(end-f.state.now);f.state.ships=[f.ship({id:2})];
  assert.match((await run(f)).reason,/活动结束/);assert.equal(f.state.writes.length,1);
 });
 await check('完整挂机循环独立调度商船，精确到开放边界唤醒，关闭后不参与',async()=>{
  const {runLoop,formatLoopStep}=await import('../src/loop.mjs');
  for(const disable of [false,true]){
   const f=fixture(),originalNow=Date.now;let wall=f.state.now*1000;
   Date.now=()=>wall;f.advance(0);
   try{
    Object.assign(f.settings.loop,{world:false,tasks:false,dailies:false,heroes:false});
    for(const key of Object.keys(f.settings.schedule))f.settings.schedule[key]=false;
    f.settings.alliance.enabled=false;f.settings.guildFort.enabled=false;f.settings.heroRaid.enabled=false;
    f.settings.silicon.enabled=false;f.settings.progression.enabled=false;f.settings.dailies.enabled=false;
    const stop={aborted:false},sleeps=[],reports=[];
    watchGuildShipPushes(f.client);
    f.client.emit('message',{name:'SCGuildShipActivity',body:{period:{period:3,startTime:f.state.now+30,endTime:f.state.now+3600}}});
    await runLoop(f.client,protocol,{config,player:f.player,getSettings:()=>f.settings,usageLedger:f.ledger,
     rounds:2,everyMs:3600000,allowMutate:true,isEnabled:()=>false,stop,
     sleep:async ms=>{
      sleeps.push(ms);assert(sleeps.length<3,'不能忙轮询');
      if(sleeps.length===1){
       assert.equal(ms,30000,'在活动开始时唤醒，无需等待主轮或旧重试时间');
       assert.equal(f.state.writes.length,0);
       wall+=ms;f.advance(ms/1000);
       if(disable){f.settings.guildShip.enabled=false;f.client.emit('automationSettingsChanged');}
      }else stop.aborted=true;
     },onStep:row=>{reports.push(row);if(f.state.writes.length)stop.aborted=true;}});
    assert.equal(f.state.writes.length,disable?0:1);
    const shipLogs=reports.filter(row=>row.category==='guildShip.enabled').map(formatLoopStep);
    assert(shipLogs.length>0,'完整循环输出商船检查日志');
    assert(shipLogs.every(message=>message.startsWith('联盟商船 · ')&&!message.includes('guildShip.enabled')));
    assert(!reports.some(row=>row.error&&!row.skipped),JSON.stringify(reports.filter(row=>row.error)));
    assert.equal(f.client.listenerCount('automationSettingsChanged'),0);
   }finally{Date.now=originalNow;}
  }
 });
 await check('紫船候选缺料明确列出可用量和订单预留，不误称可上船或触发红船补产',async()=>{
  const f=fixture();f.state.ships=[f.ship({type:1})];f.settings.guildShip.produceMissing=true;
  f.state.stock.橡胶圈=5;f.state.workerOrder=[{index:1,requirements:[{type:0,id:'橡胶圈',num:3}]}];
  const view=await read(f),diagnostics=guildShipDiagnostics(view,f.settings,config);
  assert.equal(view.candidates.length,2);assert.equal(diagnostics.eligible,0);
  assert.match(diagnostics.reason,/紫船 #1 1号舱.*橡胶圈缺 3.*需 5，可用 2，已预留 3/);
  assert(diagnostics.notes.some(note=>note.includes('紫船和橙船缺料不会自动补产')));
  const result=await run(f);assert.equal(result.reason,diagnostics.reason);assert.deepEqual(result.demands,[]);
  assert.equal(f.state.writes.length,0);
  const {previewExtended}=await import('../src/extended-preview.mjs');
  const preview=await previewExtended('guildShip',f.client,protocol,config,f.player,f.settings,f.ledger);
  assert.equal(preview.counts.candidates,2);assert.equal(preview.counts.eligible,0);assert.equal(preview.counts.own,0);
  assert.equal(preview.guildShip.candidates[0].costs[0].missing,3);
  f.state.stock.橡胶圈=8;assert.equal((await run(f)).ok,true,'补足可用材料后原策略仍可上船');
 });
 await check('缺船长、奖励门槛等筛选原因随真实规则返回',async()=>{
  const f=fixture();f.settings.guildShip.captain=false;
  f.state.ships=[f.ship({id:1,captain:false}),f.ship({id:2,coins:59})];
  const diagnostics=guildShipDiagnostics(await read(f),f.settings,config);
  assert.equal(diagnostics.eligible,0);assert.match(diagnostics.reason,/尚无船长，且未开启申请船长/);
  assert.match(diagnostics.reason,/水姆币 59 低于门槛 60/);assert.equal(f.state.writes.length,0);
 });
 await check('检查间隔沿用真实缺料原因，实际复查后更新结果，重连不保留旧原因',async()=>{
  const {rewardSchedule}=await import('../src/reward-schedule.mjs');
  const f=fixture();f.options.scheduler=rewardSchedule(f.client);f.state.stock.橡胶圈=0;
  const reports=[];f.options.report=entry=>reports.push(entry);
  const first=await run(f),calls=f.state.calls.length;
  assert.match(first.reason,/材料不足/);assert.equal((await run(f)).reason,first.reason);
  assert.equal(reports.length,1,'间隔占位不覆盖真实业务日志');
  assert.equal(f.state.calls.length,calls,'间隔中不额外读游戏');
  f.state.stock.橡胶圈=50;f.advance(61);assert.equal((await run(f)).ok,true);
  assert.equal((await run(f)).reason,'等待下次检查');
  assert.equal(reports.length,2);
  f.client.emit('login');assert.equal(watchGuildShipPushes(f.client).lastResult,null);
 });
 await check('提前结算边界：剩余601秒可申请，600秒及以后船员、船长和末日兜底均停止',async()=>{
  for(const role of ['crew','captain','full'])for(const remaining of [601,600,599]){
   const f=fixture({hour:23,minute:40});
   await withServerClock(f,async()=>{
    Object.assign(f.settings.guildShip,{crew:role==='crew',captain:role==='captain',mode:role==='full'?'full':'redFirst'});
    f.state.ships=[f.ship({captain:role!=='captain',coins:role==='full'?1:80})];
    publishPeriod(f,{endTime:f.state.now+remaining});
    const result=await run(f);
    assert.equal(f.state.writes.length,remaining>600?1:0,role+'，活动剩余 '+remaining+' 秒');
    if(remaining>600)assert.equal(result.ok,true,result.error??result.reason);
    else{
     assert.equal(result.skipped,true);assert.match(result.reason,/结算|10.*分钟/);
     assert.equal(f.ledger.snapshot().uncertain,0);
     assert.equal(pendingOrderMaterialSpends(f.player).length,0);
    }
   });
  }
 });
 await check('结算期预览没有可申请候选，也不产生红船备料需求',async()=>{
  const f=fixture();
  await withServerClock(f,async()=>{
   f.settings.guildShip.produceMissing=true;f.state.stock.橡胶圈=0;
   publishPeriod(f,{endTime:f.state.now+600});
   const view=await read(f),diagnostics=guildShipDiagnostics(view,f.settings,config);
   assert.equal(view.candidates.length,0);assert.equal(diagnostics.eligible,0);
   assert.match(diagnostics.reason,/结算|10.*分钟/);assert.deepEqual(guildShipDemands(view,f.settings),[]);
   const {previewExtended}=await import('../src/extended-preview.mjs');
   const preview=await previewExtended('guildShip',f.client,protocol,config,f.player,f.settings,f.ledger);
   assert.equal(preview.counts.candidates,0);assert.equal(preview.counts.eligible,0);
   assert(preview.notes.some(note=>/结算|10.*分钟/.test(note)));assert.equal(f.state.writes.length,0);
  });
 });
 await check('没有结束推送、无效结束时间或其他期次不能推算本期提前结算',async()=>{
  for(const period of [null,{endTime:0},{period:99,endTime:1}]){
   const f=fixture();
   await withServerClock(f,async()=>{
    if(period)publishPeriod(f,period);
    assert((await read(f)).candidates.length>0);
    assert.equal((await run(f)).ok,true);assert.equal(f.state.writes.length,1);
   });
  }
 });
 await check('读取英雄或库存期间进入结算期，不返回过期候选也不再申请',async()=>{
  for(const request of ['AllHeroRequest','AllItemRequest']){
   const f=fixture();
   await withServerClock(f,async()=>{
    f.settings.guildShip.produceMissing=true;publishPeriod(f,{endTime:f.state.now+601});
    let crossed=false;
    f.state.hook=async name=>{if(name===request&&!crossed){crossed=true;f.advance(1);}};
    const view=await read(f);assert(crossed);assert.equal(view.candidates.length,0);
    assert.deepEqual(guildShipDemands(view,f.settings),[]);assert.match(view.reason,/结算|10.*分钟/);
    assert.equal((await run(f)).skipped,true);assert.equal(f.state.writes.length,0);
    assert.equal(f.ledger.snapshot().uncertain,0);assert.equal(pendingOrderMaterialSpends(f.player).length,0);
   });
  }
 });
 await check('发送前跨过结算边界或收到提前结束推送，取消船员和船长预占',async()=>{
  for(const role of ['crew','captain'])for(const change of ['clock','push']){
   const f=fixture();
   await withServerClock(f,async()=>{
    Object.assign(f.settings.guildShip,{crew:role==='crew',captain:role==='captain'});
    f.state.ships=[f.ship({captain:role==='crew'})];
    publishPeriod(f,{endTime:f.state.now+(change==='clock'?601:3600)});
    const reserve=f.ledger.reserve;let reserved=false;
    f.options.ledger={...f.ledger,reserve(...args){
     const ticket=reserve(...args);reserved=true;
     if(change==='clock')f.advance(1);else publishPeriod(f,{endTime:f.state.now+600});
     return ticket;
    }};
    const result=await run(f);assert(reserved,'必须经过发送前持久预占');
    assert.equal(result.skipped,true);assert.equal(f.state.writes.length,0);
    assert.equal(f.ledger.snapshot().uncertain,0);assert.deepEqual(f.ledger.keyRecords(),{});
    assert.equal(pendingOrderMaterialSpends(f.player).length,0);assert.equal(f.state.stock.橡胶圈,50);
   });
  }
 });
 await check('截止前已发送的申请跨入结算期后仍回读本人船位并核销材料',async()=>{
  for(const role of ['crew','captain']){
   const f=fixture();
   await withServerClock(f,async()=>{
    Object.assign(f.settings.guildShip,{crew:role==='crew',captain:role==='captain'});
    f.state.ships=[f.ship({captain:role==='crew'})];publishPeriod(f,{endTime:f.state.now+601});
    f.state.writeHook=async()=>f.advance(1);
    const result=await run(f);assert.equal(result.ok,true,result.error??result.reason);
    assert.equal(f.state.writes.length,1);assert.equal(f.ledger.snapshot().uncertain,0);
    assert.equal(pendingOrderMaterialSpends(f.player).length,0);
    assert.equal(f.state.stock.橡胶圈,role==='crew'?45:50);
    await run(f);assert.equal(f.state.writes.length,1,'结算期不再追加申请');
   });
  }
 });
 await check('结算期已确认上船的库存核销失败后继续重试，不再申请或遗留材料预占',async()=>{
  const f=fixture();
  await withServerClock(f,async()=>{
   publishPeriod(f,{endTime:f.state.now+601});
   f.state.writeHook=async()=>f.advance(1);
   let failed=false;
   f.state.hook=async name=>{
    if(name==='AllItemRequest'&&f.state.writes.length&&!failed){failed=true;throw new Error('库存暂未同步');}
   };
   const result=await run(f);assert.equal(result.ok,true,result.error??result.reason);assert(failed);
   assert.equal(f.ledger.snapshot().uncertain,0,'本人船位已确认，只有库存核销待重试');
   assert.equal(pendingOrderMaterialSpends(f.player).length,1);assert.equal(f.state.stock.橡胶圈,45);
   const retry=await run(f);assert.equal(retry.skipped,true);assert.match(retry.reason,/结算|10.*分钟/);
   assert.equal(pendingOrderMaterialSpends(f.player).length,0);assert.equal(f.state.writes.length,1);
   assert.equal(f.state.stock.橡胶圈,45);
  });
 });
 await check('进入结算期的未知申请只按本人船位补确认，未成功的记录保持防重',async()=>{
  for(const succeeded of [true,false]){
   const f=fixture();
   await withServerClock(f,async()=>{
    publishPeriod(f,{endTime:f.state.now+601});
    f.state.writeHook=async(name,body)=>{
     if(succeeded){f.state.ships[0].cabin[body.crewId-1].player={playerId:f.player.playerId};f.state.stock.橡胶圈-=5;}
     f.advance(1);throw new Error('响应丢失');
    };
    assert.equal((await run(f)).pending,true);assert.equal(f.ledger.snapshot().uncertain,1);
    f.state.writeHook=async()=>{};await run(f);
    assert.equal(f.state.writes.length,1);assert.equal(f.ledger.snapshot().uncertain,succeeded?0:1);
    assert.equal(pendingOrderMaterialSpends(f.player).length,succeeded?0:1);
   });
  }
 });
 console.log(`联盟商船 ${passed} 项测试通过。`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}

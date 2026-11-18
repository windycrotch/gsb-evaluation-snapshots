import { rewardData } from './missing-rewards.mjs';
import { claimOnce } from './extra-free-rewards.mjs';
import { fleetRecordReason, dispatchReservationReason, reserveDispatch, reconcileBossFleets } from './fleet-availability.mjs';
import { pendingPetrol } from './dispatch-preview.mjs';
import { exactAutomationId } from './automation-policy.mjs';
import { prepareWorldBossLineups, markWorldBossLineupsDispatched, markWorldBossLineupsCancelled, recoverWorldBossLineups } from './world-boss-lineups.mjs';

const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const day=t=>Math.floor((t+28800)/86400);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const read=(c,n)=>c.request(n+'Request',{},n+'Response').then(rewardData);
function dailyCount(counters,time){
 if(!Array.isArray(counters))throw Error('世界Boss每日计数未同步');
 const matches=counters.filter(r=>r.type==='DAILY_WORLD_BOSS_TIMES');
 if(matches.length>1)throw Error('世界Boss每日计数重复');
 if(!matches.length)return 0;
 const r=matches[0];if(!integer(r.num)||!integer(r.updateTime)||r.updateTime>time)throw Error('世界Boss每日计数无效');
 if(r.num>0&&r.updateTime===0)throw Error('世界Boss计数日期未确认');
 return day(r.updateTime)===day(time)?r.num:0;
}
export async function readWorldBoss(client,config,player,settings,ledger,{cityReservedFleetIds=null,ignoreLineupKeys=[]}={}){
 const snapshot={checkedAt:now(client),boss:null,count:null,fleets:[],fuel:null,cost:null,reason:''};
 const required=config?.tables?.ModuleOpenCfg?.data?.find(r=>r.moduleId==='世界')?.playerLevel;
 if(!required||!(player?.level>=required))return {...snapshot,reason:'尚未确认世界玩法开放'};
 const [boss,counters,own,water,bag]=await Promise.all(['WorldBossInfo','CounterInfo','MyFleets','OnWater','AllItem'].map(n=>read(client,n)));
 snapshot.boss=boss.info;snapshot.count=dailyCount(counters.counters,snapshot.checkedAt);
 if(!boss.info||!integer(boss.info.bossId)||boss.info.bossId<1||!integer(boss.info.gridIdx)||boss.info.gridIdx<1)snapshot.reason='当前没有开放的世界Boss';
 if(![own.fleets,water.building,bag.items].every(Array.isArray))throw Error('世界Boss派遣所需舰队、建筑或库存未同步');
 const fuel=bag.items.filter(r=>r.itemId==='汽油');
 snapshot.fuel=fuel.every(r=>integer(r.num))?fuel.reduce((n,r)=>n+r.num,0):null;
 snapshot.cost=config?.tables?.WorldParamCfg?.data?.find(r=>r.paramName==='进攻首领消耗汽油')?.paramValue;
 if(!integer(snapshot.fuel)||!integer(snapshot.cost))snapshot.reason||='世界Boss汽油消耗未确认';
 const p=settings.worldBoss;
 const records=Object.fromEntries(Object.entries(ledger.keyRecords()).filter(([key])=>!ignoreLineupKeys.includes(key)));
 snapshot.fleets=own.fleets.map(f=>({...f,reason:
  (p.fleetIds.length&&!p.fleetIds.includes(f.buildingId)?'未选择此舰队':'')||
  fleetRecordReason(records,f.buildingId,exactAutomationId(player.worldId))||(cityReservedFleetIds?.includes(f.buildingId)?'城战时段预留':dispatchReservationReason(client,settings,'worldBoss',f.buildingId,{ignoreOwners:cityReservedFleetIds===null?[]:['cityWar']}))||
  (!/^\d+远征船$/.test(f.buildingId)?'舰队编号未确认':f.state!==1||f.curGridIdx||f.treasureLootUid||f.chipWar?.rewardTs?'舰队正在执行其他任务':
   !integer(f.maxDura)||f.maxDura<1||!integer(f.durability)||f.durability<=0||f.durability<f.maxDura*p.minDurabilityPercent/100?'耐久不足或未同步':
   !water.building.some(b=>b.buildingId===f.buildingId&&b.level>0&&b.fleet?.formation?.heroPositions?.some(h=>h.heroId))&&!p.fleetPresets?.some(b=>b.buildingId===f.buildingId)?'缺少已保存的编队':'')}));
 const eligible=snapshot.fleets.filter(f=>!f.reason);
 snapshot.selectedFleetIds=(p.fleetIds.length?eligible:eligible.slice(0,1)).map(f=>f.buildingId);
 snapshot.totalCost=snapshot.cost*snapshot.selectedFleetIds.length;
 if(snapshot.count===0&&ledger.hasKey('world-boss:'+exactAutomationId(player.worldId)+':'+day(snapshot.checkedAt)))snapshot.reason||='今日首战已提交，结果待核对，未重复派遣';
 if(snapshot.count>0)snapshot.reason||='今日世界Boss首战已完成派遣';
 if(!snapshot.reason&&(!integer(snapshot.totalCost)||snapshot.fuel-pendingPetrol(ledger)<snapshot.totalCost))snapshot.reason='可用汽油不足以派出所选舰队';
 if(!snapshot.reason&&!snapshot.fleets.some(f=>!f.reason))snapshot.reason='没有空闲且符合条件的舰队';
 return snapshot;
}
export async function runWorldBoss(client,config,player,{getSettings,ledger,enabled,report}){
 const label='世界Boss每日首战';
 if(!enabled()||!getSettings().worldBoss.enabled)return;
 const settings=getSettings(),state=await readWorldBoss(client,config,player,settings,ledger);
 reconcileBossFleets(ledger,state.fleets,exactAutomationId(player.worldId));
 const key='world-boss:'+exactAutomationId(player.worldId)+':'+day(state.checkedAt);
 if(state.count>0&&ledger.hasKey(key)&&!ledger.keyRecords()[key].confirmed)ledger.resolveKey(key,true);
 if(state.reason){report({label,skipped:true,reason:state.reason});return state;}
 if(ledger.hasKey(key)){report({label,skipped:true,status:ledger.keyRecords()[key].confirmed?'confirmed':'pending',reason:'今日首战已提交，等待每日计数或战报确认，未重复派遣'});return state;}
 const ids=state.selectedFleetIds;
 reserveDispatch(client,'worldBoss',ids);
 let lineupKeys=[],tickets=[],sent=false;
 const connected=()=>client.connected!==false;
 try{
  lineupKeys=await prepareWorldBossLineups(client,config,player,{settings,ledger,fleetIds:ids,enabled:()=>enabled()&&connected()&&settings===getSettings(),report});
  const fresh=await readWorldBoss(client,config,player,getSettings(),ledger,{ignoreLineupKeys:lineupKeys});
  if(!enabled()||settings!==getSettings()||day(now(client))!==day(state.checkedAt))return state;
  if(fresh.reason||fresh.boss.bossId!==state.boss.bossId||fresh.boss.gridIdx!==state.boss.gridIdx||ids.some(id=>!fresh.fleets.some(f=>f.buildingId===id&&!f.reason))){report({label,skipped:true,reason:fresh.reason||'出征前Boss或舰队状态已变化'});return fresh;}
  const details={bossId:fresh.boss.bossId,grid:fresh.boss.gridIdx,day:day(state.checkedAt),sentAt:fresh.checkedAt,active:true};
  const ticket=ledger.reserve({worldBossPetrol:fresh.cost*ids.length},{},{},{uniqueKey:key,details:{...details,kind:'worldBossBatch',buildingIds:ids}});
  tickets.push(ticket);
  const dispatchKeys={};
  for(const id of ids){
   const child=key+':fleet:'+id.replace('远征船','');dispatchKeys[id]=child;
   tickets.push(ledger.reserve({},{},{},{uniqueKey:child,details:{...details,kind:'worldBoss',buildingId:id,batchKey:key}}));
  }
  try{
   const held=ids.map(id=>dispatchReservationReason(client,getSettings(),'worldBoss',id)).find(Boolean);
   if(!enabled()||client.connected===false||settings!==getSettings()||!getSettings().worldBoss.enabled||day(now(client))!==day(state.checkedAt)||held){
    report({label,skipped:true,reason:held||'发送前账号、设置或日期已变化，出征已取消'});return fresh;
   }
   markWorldBossLineupsDispatched(ledger,lineupKeys,dispatchKeys);
   sent=true;
   await client.request('ChallengeWorldBossRequest',{bossId:fresh.boss.bossId,fleetBuildingIds:ids},'OkResponse');
   for(const child of Object.values(dispatchKeys))ledger.updateKeyDetails(child,{...ledger.keyRecords()[child].details,dispatchAccepted:true});
   const [counter,own]=await Promise.all([read(client,'CounterInfo'),read(client,'MyFleets')]);
   const confirmed=dailyCount(counter.counters,now(client))>0||own.fleets?.some(fleet=>ids.includes(fleet.buildingId)&&([2,3].includes(fleet.state))&&(fleet.targetGridIdx===fresh.boss.gridIdx||fleet.curGridIdx===fresh.boss.gridIdx));
   if(!confirmed)throw Error('首战请求已发送，但每日计数或舰队目标尚未确认');
   ledger.confirm(ticket);reconcileBossFleets(ledger,own.fleets,exactAutomationId(player.worldId));report({label:label+' · '+ids.join('、'),ok:true,status:'confirmed',reason:'服务器已确认首战派遣；各队战果、返航和阵容恢复后续核对'});
  }catch(error){if(error.prompt&&error.request==='ChallengeWorldBossRequest')sent=false;report({label,ok:false,status:error.prompt?'rejected':'unknown',error:error.message});}
  return fresh;
 }finally{
  try{if(!sent){for(const ticket of tickets)ledger.cancel(ticket);markWorldBossLineupsCancelled(ledger,lineupKeys);await recoverWorldBossLineups(client,player,ledger,{enabled:connected,report});}}
  finally{reserveDispatch(client,'worldBoss',[]);}
 }
}
export async function claimWorldBossDamage(client,config,{player,enabled,ledger,report}){
 const label='世界Boss伤害达标奖励',state=(await read(client,'WorldBossInfo')).info;
 if(!state||!integer(state.bossId)||state.bossId===0){report({label,skipped:true,reason:'当前没有开放的世界Boss'});return;}
 if(!integer(state.bestDamage)||!integer(state.gotRewardLevel))throw Error('世界Boss伤害及已领档位未确认');
 const season=Math.floor(Number(exactAutomationId(player.worldId))/1e6)%1000;
 const tiers=config?.tables?.WorldBossDamageRewardCfg?.data?.filter(r=>r.season===season&&r.bossId===state.bossId&&r.damage<=state.bestDamage&&r.level>state.gotRewardLevel)??[];
 if(!tiers.length){report({label,skipped:true,reason:'最高伤害 '+state.bestDamage+'，已领至第 '+state.gotRewardLevel+' 档'});return;}
 const target=Math.max(...tiers.map(r=>r.level)),today=day(now(client));
 await claimOnce(client,{ledger,key:'world-boss-damage:'+today+':'+state.bossId+':'+target,title:label,request:'WorldBossGetDamageRewardRequest',enabled:()=>enabled()&&day(now(client))===today,report,verify:async r=>{
  const after=(await read(client,'WorldBossInfo')).info;return r.reward?.asset?.some(a=>Number(a.num)>0)&&after?.bossId===state.bossId&&after.gotRewardLevel>=target;
 }});
}

import {settleFleetSnapshot} from './fleet-settlement.mjs';
import {sendRepairAndConfirm} from './fleet-repair-confirmation.mjs';
// 战后补满：只维修现有配置所选的空闲舰队，不要求下一次出征目标或城战时段。
import {exactAutomationId} from './automation-policy.mjs';
import {rewardData} from './missing-rewards.mjs';
import {dispatchOrder,dispatchReservationReason,fleetRecordReason,reserveDispatch} from './fleet-availability.mjs';
const active=new WeakSet(),watchers=new WeakMap(),refused=new WeakMap();
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const now=c=>Math.floor((Date.now()+(c.serverClockOffsetMs||0))/1000);
const idle=f=>f?.state===1&&!f.curGridIdx&&!f.treasureLootUid&&!(f.chipWar?.rewardTs>0);
const keyFor=(world,id,source)=>(source==='cityWar'?'cityWar:':'treasureRepair:')+world+':'+id.replace('远征船','');
const fleetName=id=>'舰队'+id.replace('远征船','');
export function maintenancePolicies(settings){
 const order=dispatchOrder(settings??{}),result=new Map();
 const sources=['cityWar','treasure'].filter(name=>settings?.[name]?.enabled&&settings[name].autoRepair).sort((a,b)=>{
  const rank=name=>order.indexOf(name==='treasure'&&settings.treasure.follow?'follow':name);return rank(a)-rank(b);
 });
 for(const source of sources){const p=settings[source];for(const id of p.fleetIds??[]){if(result.has(id)||!/^\d+远征船$/.test(id))continue;
  result.set(id,{source,buildingId:id,label:source==='cityWar'?'城战维修参数':'巨轮维修参数',interval:p.checkEverySeconds??15});
 }}return [...result.values()];
}
export const fleetMaintenanceEnabled=settings=>maintenancePolicies(settings).length>0;
export const fleetMaintenanceInterval=settings=>Math.max(1000,Math.min(...maintenancePolicies(settings).map(p=>valid(p.interval)&&p.interval>0?p.interval:15),60)*1000);
export function watchFleetMaintenance(client){
 if(watchers.has(client))return watchers.get(client);
 const fleets=new Map(),listeners=new Set();let petrol=null,minimum=Infinity,held=[];
 const notify=()=>{for(const listener of listeners)listener();};
 const seedFleets=(items,push=false)=>{if(!Array.isArray(items))return;let changed=false;
  for(const raw of items){const f=rewardData(raw),before=fleets.get(f.buildingId);fleets.set(f.buildingId,f);
   if(push&&idle(f)&&valid(f.durability)&&valid(f.maxDura)&&((f.durability<f.maxDura&&(!before||!idle(before)||before.durability!==f.durability))||(before?.state===4)))changed=true;
  }if(changed)notify();
 };
 const seedItems=(items,push=false)=>{if(!Array.isArray(items))return;const raw=items.find(i=>i.itemId==='汽油');if(!raw)return;const value=rewardData(raw).num;if(!valid(value))return;
  const increased=petrol!==null&&value>petrol;petrol=value;
  if(push&&increased&&value>=minimum&&[...fleets.values()].some(f=>idle(f)&&valid(f.durability)&&f.durability<f.maxDura))notify();
 };
 const watcher={seedFleets,seedItems,setMinimum(value){minimum=Number.isFinite(value)?value:Infinity;},hold(ids){held=[...ids];reserveDispatch(client,'maintenance',held,Date.now()+90000);},held:()=>[...held],subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},clear(){fleets.clear();petrol=null;minimum=Infinity;held=[];reserveDispatch(client,'maintenance',[]);}};
 client.on?.('message',({name,body})=>{if(name==='SCMyFleetUpdate'||name==='MyFleetsResponse')seedFleets(body?.fleets,true);if(name==='SCUpdateItem'||name==='AllItemResponse')seedItems(body?.items,true);});
 client.on?.('close',()=>watcher.clear());watchers.set(client,watcher);return watcher;
}
export async function readFleetMaintenance(client,player,settings,ledger){
 const policies=maintenancePolicies(settings),snapshot={checkedAt:now(client),worldId:exactAutomationId(player?.worldId),enabled:policies.length>0,fuel:null,pendingFuel:0,rows:[],reason:'',usage:ledger.snapshot(),keys:ledger.keyRecords()};
 if(!policies.length)return snapshot;
 const ownId=exactAutomationId(player?.playerId);if(!snapshot.worldId||!ownId){snapshot.reason='角色或区服未同步';return snapshot;}
 const read=async(name,body={})=>rewardData(await client.request(name+'Request',body,name+'Response',8000));
 let own,bag;try{[own,bag]=await Promise.all([read('MyFleets'),read('AllItem')]);}catch{snapshot.reason='舰队或汽油未同步，暂不维修';return snapshot;}
 if(!Array.isArray(own?.fleets)||!Array.isArray(bag?.items)){snapshot.reason='舰队或库存数据未完整返回';return snapshot;}
 const fuel=bag.items.filter(i=>i.itemId==='汽油');if(fuel.length>1||fuel.some(i=>!valid(i.num))){snapshot.reason='汽油数量未确认';return snapshot;}snapshot.fuel=fuel[0]?.num??0;
 const pending=ledger.pendingCounters();for(const name of ['treasurePetrol','cityWarPetrol','radarPetrol','piratePetrol','worldBossPetrol','siliconPetrol']){if(!valid(pending[name]??0)){snapshot.reason='待确认汽油记录异常';return snapshot;}snapshot.pendingFuel+=pending[name]??0;}
 const watch=watchFleetMaintenance(client);watch.seedFleets(own.fleets);watch.seedItems(bag.items);
 for(const policy of policies){
  const matches=own.fleets.filter(f=>f.buildingId===policy.buildingId),fleet=matches[0];
  if(!matches.length)continue; // 完整舰队快照中不存在：旧配置的未解锁舰队，不制造维修状态或占用。
  const row={id:policy.buildingId,name:fleetName(policy.buildingId),policy,fleet,cost:null,condition:'',state:'waiting'};snapshot.rows.push(row);
  if(matches.length!==1){row.condition='舰队数据缺失或重复';row.state='unknown';continue;}
  if(fleet.owner&&exactAutomationId(fleet.owner.playerId)!==ownId){row.condition='舰队归属未确认';row.state='unknown';continue;}
  if(!valid(fleet.durability)||!valid(fleet.maxDura)||fleet.maxDura===0||fleet.durability>fleet.maxDura){row.condition='耐久数据未确认';row.state='unknown';continue;}
  if(fleet.durability===fleet.maxDura){row.condition='耐久已满';row.state='full';continue;}
  if(fleet.state===4){row.condition='正在维修，等待完成';row.state='repairing';continue;}
  if(!idle(fleet)){row.condition='舰队仍在行军、驻守或战斗，等待空闲';row.state='busy';continue;}
  try{const quote=await read('FleetRepairParam',{buildingId:fleet.buildingId});
   if(!(Number.isFinite(quote.unitRepairCost)&&quote.unitRepairCost>0&&Number.isFinite(quote.unitRepairTime)&&quote.unitRepairTime>0))throw Error('报价无效');
   row.cost=Math.ceil((fleet.maxDura-fleet.durability)*quote.unitRepairCost);row.seconds=Math.ceil((fleet.maxDura-fleet.durability)*quote.unitRepairTime);
   if(!valid(row.cost)||!row.cost)throw Error('费用无效');
  }catch{row.condition='普通维修报价未同步';row.state='unknown';}
 }return snapshot;
}
function effectiveKeys(snapshot){
 const keys={...snapshot.keys};
 for(const[key,record]of Object.entries(keys)){
  if(!key.startsWith('cityWar:'+snapshot.worldId+':')&&!key.startsWith('treasureRepair:'+snapshot.worldId+':'))continue;
  const row=snapshot.rows.find(r=>r.id===record.details?.buildingId);
  if(record.confirmed&&row&&idle(row.fleet)&&['cityDispatch','cityRepair','treasureRepair'].includes(record.details?.kind))delete keys[key];
 }return keys;
}
export function planFleetMaintenance(snapshot,settings,client){
 const result={enabled:snapshot.enabled,checkedAt:snapshot.checkedAt,fuel:snapshot.fuel,pendingFuel:snapshot.pendingFuel,reason:snapshot.reason,rows:[],actions:[],minimumFuel:Infinity};
 if(snapshot.reason)return result;
 const keys=effectiveKeys(snapshot);let available=snapshot.fuel-snapshot.pendingFuel;
 for(const row of snapshot.rows){
  const {policy,fleet}=row,view={id:row.id,name:row.name,source:policy.label,durability:fleet?.durability??null,maxDura:fleet?.maxDura??null,cost:row.cost,state:row.state,condition:row.condition};result.rows.push(view);
  if(view.condition)continue;
  const key=keyFor(snapshot.worldId,row.id,policy.source),record=keys[key];
  const reservation=dispatchReservationReason(client,settings,policy.source,row.id,{ignoreOwners:['maintenance']});
  if(reservation){view.condition=reservation;view.state='busy';continue;}
  let reason=record&&!record.confirmed?'前次维修/城战结果待确认':fleetRecordReason(keys,row.id,snapshot.worldId);
  if(!reason)result.minimumFuel=Math.min(result.minimumFuel,row.cost+snapshot.pendingFuel);
  if(!reason&&available<row.cost)reason='等待汽油：补满需 '+row.cost+'，可用 '+Math.max(0,available);
  if(reason){view.condition=reason;view.state=/待确认|未确认/.test(reason)?'unknown':'waiting';continue;}
  const step={kind:policy.source==='cityWar'?'cityRepair':'treasureRepair',request:'RepairFleetRequest',body:{buildingId:row.id},buildingId:row.id,source:policy.source,worldId:snapshot.worldId,uniqueKey:key,cost:row.cost,costs:[{id:'汽油',num:row.cost}],beforeDurability:fleet.durability,maxDura:fleet.maxDura,policy,label:row.name+'战后普通维修至满耐久'};
  result.actions.push(step);view.state='ready';view.condition='汽油满足，准备普通维修';available-=row.cost;
 }return result;
}
function reconcile(snapshot,ledger,onStep){
 if(snapshot.reason)return;
 const before=ledger.keyRecords();
 const changes=settleFleetSnapshot(ledger,{worldId:snapshot.worldId,fleets:snapshot.rows.map(r=>r.fleet).filter(Boolean),now:snapshot.checkedAt,kinds:['cityDispatch','cityRepair','treasureRepair']});
 for(const key of new Set(changes.map(c=>c.key))){const record=before[key],d=record?.details;if(!record?.confirmed&&d?.postBattle){
  const fleet=snapshot.rows.find(r=>r.id===d.buildingId)?.fleet;
  onStep?.({step:{kind:d.kind,buildingId:d.buildingId,label:fleetName(d.buildingId)+'战后维修复查'},ok:true,status:'confirmed',note:fleet?.durability>=fleet?.maxDura?'后续复查已确认耐久补满':'后续复查已确认普通维修'});
 }}
}
export async function runFleetMaintenance(client,player,{getSettings,ledger,enabled=()=>true,onStep,onView,sleep}={}){
 if(!enabled()||!fleetMaintenanceEnabled(getSettings?.())||active.has(client))return null;
 active.add(client);const failures=refused.get(client)??new Map();refused.set(client,failures);
 try{
  const initial=await readFleetMaintenance(client,player,getSettings(),ledger);reconcile(initial,ledger,onStep);initial.keys=ledger.keyRecords();
  const plan=planFleetMaintenance(initial,getSettings(),client),watch=watchFleetMaintenance(client);watch.setMinimum(plan.minimumFuel);
  const selected=new Set(maintenancePolicies(getSettings()).map(p=>p.buildingId));
  watch.hold(plan.reason?[...selected]:plan.rows.filter(r=>selected.has(r.id)&&!['full','busy'].includes(r.state)).map(r=>r.id));let remaining=initial.fuel;
  for(const proposed of plan.actions){
   if(!enabled()||!client.connected)break;
   const settings=getSettings(),fresh=await readFleetMaintenance(client,player,settings,ledger);
   if(fresh.reason){const row=plan.rows.find(r=>r.id===proposed.buildingId);row.condition=fresh.reason;row.state='unknown';continue;}
   reconcile(fresh,ledger,onStep);fresh.keys=ledger.keyRecords();fresh.fuel=Math.min(fresh.fuel,remaining);
   const reviewed=planFleetMaintenance(fresh,settings,client),step=reviewed.actions.find(a=>a.uniqueKey===proposed.uniqueKey&&a.cost===proposed.cost&&a.beforeDurability===proposed.beforeDurability);
   if(!step||settings!==getSettings()||!enabled()||!client.connected)continue;
   const signature=JSON.stringify([step.cost,fresh.fuel,step.beforeDurability,step.maxDura,step.policy]),failure=failures.get(step.uniqueKey),view=plan.rows.find(r=>r.id===step.buildingId);
   if(failure&&failure.until>Date.now()&&failure.signature===signature){view.condition='服务端此前拒绝，等待状态变化后复查';continue;}
   const counters=step.source==='cityWar'?{cityWarPetrol:step.cost,cityWarRepairs:1}:{treasurePetrol:step.cost,treasureRepairPetrol:step.cost,treasureRepairs:1};
   const ticket=ledger.reserve(counters,{},{}, {uniqueKey:step.uniqueKey,details:{kind:step.kind,buildingId:step.buildingId,beforeDurability:step.beforeDurability,maxDura:step.maxDura,sentAt:fresh.checkedAt,postBattle:true}});
   if(!enabled()||settings!==getSettings()||!client.connected){ledger.cancel(ticket);break;}
   let entry;
   try{
    const owner=exactAutomationId(player.playerId),world=exactAutomationId(player.worldId);
    const fleet=await sendRepairAndConfirm(client,{...step,sentAt:fresh.checkedAt},{now:()=>now(client),sleep,seed:watch.seedFleets,
     enabled:()=>enabled()&&exactAutomationId(player.playerId)===owner&&exactAutomationId(player.worldId)===world});
    const confirmed=!!fleet;
    if(confirmed)ledger.confirm(ticket);
    entry={step,ok:confirmed,status:confirmed?'confirmed':'unknown',full:confirmed&&fleet.durability>=fleet.maxDura,note:confirmed?(fleet.durability>=fleet.maxDura?'服务器已确认耐久补满':'服务器已确认普通维修，继续监控至满耐久'):'维修已发送，短时复查仍未确认；继续自动核对，期间不重复扣汽油'};
    if(confirmed){view.durability=fleet.durability;view.maxDura=fleet.maxDura;}
   }catch(error){const rejected=error.repairRejected;if(rejected){ledger.cancel(ticket);failures.set(step.uniqueKey,{until:Date.now()+300000,signature});}entry={step,ok:false,status:rejected?'rejected':'unknown',error:error.message};}
   onStep?.(entry);view.state=entry.full?'full':entry.status==='confirmed'?'repairing':entry.status==='unknown'?'unknown':'waiting';view.condition=entry.note||entry.error;
   if(entry.status!=='rejected')remaining-=step.cost;if(entry.status==='unknown')break;
  }
  if(!enabled()||!client.connected)watch.hold([]);
  else if(!plan.reason)watch.hold(plan.rows.filter(r=>selected.has(r.id)&&!['full','busy'].includes(r.state)).map(r=>r.id));
  onView?.(plan);return plan;
 }finally{active.delete(client);}
}

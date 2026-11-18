process.on('uncaughtException',error=>{console.error(error.stack);process.exitCode=1;});
// 排行榜仅查询专项：协议页码、活动窗口、精确ID和禁止写操作。
import assert from 'node:assert/strict';
import {loadProtocol} from '../src/proto.mjs';
import {activityRankCatalog,readActivityRanking} from '../src/activity-rankings.mjs';
import {automationWireId} from '../src/automation-policy.mjs';
const p=loadProtocol(),time=Math.floor(Date.now()/1000),player={level:37,playerId:'9007199254740993',worldId:'2000001'},config={tables:{ModuleOpenCfg:{data:['冲榜活动','每日跨服比拼','世界','跨服积分赛'].map(moduleId=>({moduleId,playerLevel:10}))},CrossRankSubjectCfg:{data:[{subjectId:4,name:'藏品培养'}]}}};
let count=0;const test=async(name,fn)=>{await fn();count++;console.log('通过：'+name);};
function client(handler){const c={openRankActivity:{activityTime:[1,2,3,4].map(type=>({type,startTime:time-100,endTime:time+1000}))},festivals:[],calls:[],request:async(n,b,r)=>{assert(!/Got|Claim|Challenge|Buy/.test(n),'排行榜不能发写请求');c.calls.push({n,b});p[n].decode(p[n].encode(b).finish());const value=await handler(n,b);return p[r].decode(p[r].encode(value).finish());}};return c;}
const mine={rank:2,playerId:automationWireId(player.playerId),nickname:'自己',power:1000,value:300};
await test('剿匪/杀敌/订单/闯关按各自枚举查询，自己ID不丢精度',async()=>{for(const[key,type]of [['pirate',3],['war',4],['orders',1],['stages',2]]){const c=client((n,b)=>{assert.equal(n,'OpenRankInfoRequest');assert.equal(b.type,type);return{endTime:time+300,leaderBoard:{item:[mine],myItem:mine,page:1,totalPage:2}};});const v=await readActivityRanking(c,config,player,key);assert.equal(v.rows[0].score,300);assert.equal(v.rows[0].own,true);assert.equal(v.mine.rank,2);assert.equal(v.totalPages,1);}});
await test('冲榜仅展示实证支持的首屏和本人名次，不发送已知超时分页',async()=>{const c=client(n=>{assert.equal(n,'OpenRankInfoRequest');return{endTime:time+300,leaderBoard:{item:[mine],myItem:mine,page:1,totalPage:2}};});const v=await readActivityRanking(c,config,player,'pirate',1);assert.equal(v.totalPages,1);assert.match(v.reason,/分页暂不可用/);await assert.rejects(()=>readActivityRanking(c,config,player,'pirate',2),/只支持首屏/);assert.equal(c.calls.length,1);});
await test('已结束活动不请求后续榜单，低等级不提供不可用入口',async()=>{const c=client(()=>({endTime:time-1}));assert.match((await readActivityRanking(c,config,player,'war')).reason,/未开放|结束/);assert.equal(c.calls.length,1);assert.equal(activityRankCatalog(c,config,{level:1}).length,0);});
await test('积分赛页码和世界Boss伤害字段正确；未返回本人名次不编造',async()=>{const c=client((n,b)=>{if(n==='LeagueRankRequest'){assert.equal(b.page,2);return{items:[{rank:21,playerId:5,nickname:'玩家',avatar:{image:1,frame:0},score:800,power:1000,worldId:1001001}],maxPage:3};}if(n==='WorldBossInfoRequest')return{info:{bossId:3,gridIdx:100,bestDamage:0,gotRewardLevel:0}};return{rankList:[{rank:1,playerId:5,nickname:'玩家',avatar:{image:1,frame:0},damage:3429469,power:1000}]};});const league=await readActivityRanking(c,config,player,'league',2);assert.equal(league.mine,null);assert.equal(league.rows[0].score,800);assert.equal((await readActivityRanking(c,config,player,'world-boss')).rows[0].score,3429469);});
await test('酆都榜只在子活动开放时加入，活动ID精确编码',async()=>{const c=client((n,b)=>{assert.equal(n,'ActivityRankRequest');assert.deepEqual(b.activityId,automationWireId('9007199254740995'));assert.equal(b.type,p.ActivityRankType.AR_DAILY_COMPASS);assert.equal(b.page,1);return{item:[],page:1,totalPage:1};});c.festivals=[{activityId:'9007199254740995',type:'酆都活动',startTime:time-100,endTime:time+300,subActivity:[{subActivityType:28,openTime:time-50,closeTime:time+200},{subActivityType:27,openTime:time+20}]}];const tabs=activityRankCatalog(c,config,player).filter(t=>t.kind==='festival');assert.equal(tabs.length,1);assert.match((await readActivityRanking(c,config,player,tabs[0].key)).reason,/暂无玩家/);});
await test('无Boss、比拼分组中和接口异常分别保留真实状态',async()=>{const c=client(n=>n==='WorldBossInfoRequest'?{info:{bossId:0,gridIdx:0,bestDamage:0,gotRewardLevel:0}}:{grouping:true});assert.match((await readActivityRanking(c,config,player,'world-boss')).reason,/没有开放/);assert.match((await readActivityRanking(c,config,player,'week-cross')).reason,/分组/);const failed=client(()=>{throw Error('读取超时');});await assert.rejects(()=>readActivityRanking(failed,config,player,'league'),/读取超时/);});
await test('非法类型、过期活动、非法页码不能注入任意协议请求',async()=>{const c=client(()=>{throw Error('不应请求');});await assert.rejects(()=>readActivityRanking(c,config,player,'GotRewardRequest'),/暂不支持/);await assert.rejects(()=>readActivityRanking(c,config,player,'league',0),/页码/);await assert.rejects(()=>readActivityRanking(c,config,player,'activity:123:7'),/暂不支持/);assert.equal(c.calls.length,0);});
await test('冲榜0基首屏同样不伪造后续页，活动窗口排除过期与未来类型',async()=>{const c=client(()=>({endTime:time+300,leaderBoard:{item:[mine],myItem:mine,page:0,totalPage:2}}));assert.equal((await readActivityRanking(c,config,player,'pirate')).totalPages,1);c.openRankActivity.activityTime=[{type:1,startTime:time-100,endTime:time-1},{type:2,startTime:time+100,endTime:time+200},{type:3,startTime:time-10,endTime:time+300}];const tabs=activityRankCatalog(c,config,player);assert(tabs.some(t=>t.key==='pirate'));assert(!tabs.some(t=>['orders','stages'].includes(t.key)));});
function crossClient(state,{at='2026-11-18T12:00:00+08:00'}={}){
 const calls=[];
 return {calls,serverClockOffsetMs:Date.parse(at)-Date.now(),async request(name,body,response){
  calls.push({name,body,response});
  assert.equal(name,'CrossRankInfoRequest','军备榜只允许查询状态');
  assert.deepEqual(body,{});assert.equal(response,'CrossRankInfoResponse');
  return typeof state==='function'?state():structuredClone(state);
 }};
}
const crossNow=Date.parse('2026-11-18T12:00:00+08:00')/1000;
const crossState=rankList=>({subjectId:4,roomLevel:37,grouping:false,settleTime:crossNow+3600,rankList});

await test('军备目录使用每日跨服比拼等级与首赛季开服第8天，后续赛季不受开服天数限制',async()=>{
 const c=crossClient(crossState([]));
 const cfg={tables:{ModuleOpenCfg:{data:[{moduleId:'周活动',playerLevel:17},{moduleId:'每日跨服比拼',playerLevel:20}]},
  CrossRankParamCfg:{data:[{paramName:'每日跨服比拼开启',paramValue:8}]}}};
 const tab=actor=>activityRankCatalog(c,cfg,actor).find(row=>row.key==='week-cross');
 assert.equal(tab({...player,level:19}),undefined);
 assert.equal(tab({...player,worldId:'1000001',worldOpenTime:Date.parse('2026-11-12T00:00:00+08:00')/1000}),undefined);
 assert.equal(tab({...player,worldId:'1000001',worldOpenTime:Date.parse('2026-11-11T23:59:59+08:00')/1000})?.label,'军备竞赛');
 assert.equal(tab({...player,worldId:'2000001'})?.module,'每日跨服比拼');
 assert.equal(tab({...player,worldId:undefined}),undefined);
 assert.equal(tab({...player,worldId:'1000001',worldOpenTime:undefined}),undefined);
 await assert.rejects(()=>readActivityRanking(c,cfg,{...player,level:19},'week-cross'),/未开放/);
 assert.deepEqual(c.calls,[],'未开放时不查询任何协议');
});

await test('军备榜保持服务端名次并排序、精确匹配本人64位ID与大积分',async()=>{
 const own={rank:8,playerId:automationWireId(player.playerId),nickname:'自己',score:automationWireId('9007199254740993'),level:37,worldId:automationWireId('9007199254740995'),avatar:{image:1,frame:0}};
 const neighbor={...own,rank:2,playerId:automationWireId('9007199254740992'),nickname:'邻近ID',score:800};
 const first={...own,rank:1,playerId:automationWireId('9007199254740995'),nickname:'第一名',score:999};
 const c=client(n=>{assert.equal(n,'CrossRankInfoRequest');return {subjectId:4,roomLevel:37,grouping:false,settleTime:time+300,rankList:[own,neighbor,first]};});
 const v=await readActivityRanking(c,config,player,'week-cross');
 assert.equal(v.label,'军备竞赛');assert.equal(v.status,'active');assert.equal(v.subjectId,4);assert.equal(v.subjectName,'藏品培养');
 assert.equal(v.roomLevel,37);assert.equal(v.grouping,false);assert.equal(v.settleTime,time+300);assert.equal(v.endTime,v.settleTime);
 assert.deepEqual(v.rows.map(row=>row.rank),[1,2,8],'不按积分重新编排名，名次缺口原样保留');
 assert.deepEqual(v.rows.map(row=>row.own),[false,false,true]);
 assert.equal(v.mine.playerId,player.playerId);assert.equal(v.mine.rank,8);
 assert.equal(v.mine.score,'9007199254740993');assert.equal(v.mine.scoreText,'9,007,199,254,740,993');
 assert.equal(v.mine.level,37);assert.equal(v.mine.worldId,'9007199254740995','真实CrossRankItem区服ID保持精度');
 assert.equal(v.mine.power,null,'实际CrossRankItem没有战力字段时不能补零');
 assert.equal(JSON.parse(JSON.stringify(v)).mine.score,'9007199254740993','结果必须可无损通过JSON接口');
 assert.equal(c.calls.length,1);
});

await test('军备大积分支持Long和十进制字符串；缺失等级、区服、战力和不安全数值不伪造',async()=>{
 const values=[
  [0,0,'0'],[12345,12345,'12,345'],
  [automationWireId('9223372036854775807'),'9223372036854775807','9,223,372,036,854,775,807'],
  ['9007199254740993','9007199254740993','9,007,199,254,740,993'],
  [Number.MAX_SAFE_INTEGER+1,null,null],[undefined,null,null],[-1,null,null],['9223372036854775808',null,null],
 ];
 for(const [raw,expected,text]of values){
  const c=crossClient(crossState([{playerId:player.playerId,nickname:'自己',score:raw}]));
  const v=await readActivityRanking(c,config,player,'week-cross');
  assert.equal(v.mine.rank,null);assert.equal(v.mine.score,expected);assert.equal(v.mine.scoreText,text);
  assert.equal(v.mine.level,null);assert.equal(v.mine.worldId,null);assert.equal(v.mine.power,null);
 }
 const c=crossClient(crossState([{rank:9,nickname:'缺少ID',score:4},{playerId:player.playerId},{rank:3,playerId:'7',score:2}]));
 const v=await readActivityRanking(c,config,player,'week-cross');
 assert.deepEqual(v.rows.map(row=>row.rank),[3,9,null]);assert.equal(v.mine.score,null);assert.equal(v.rows[1].playerId,null);
});

await test('军备空榜、本人未返回与本人重复均不虚构本人排名或积分',async()=>{
 const empty=await readActivityRanking(crossClient(crossState([])),config,player,'week-cross');
 assert.equal(empty.status,'active');assert.deepEqual(empty.rows,[]);assert.equal(empty.mine,null);assert.match(empty.reason,/暂无玩家/);
 const absent=await readActivityRanking(crossClient(crossState([{rank:1,playerId:'7',score:0}])),config,player,'week-cross');
 assert.equal(absent.mine,null);assert.match(absent.reason,/未返回本人/);assert.equal(absent.rows[0].score,0);
 const duplicate=await readActivityRanking(crossClient(crossState([{rank:1,playerId:player.playerId,score:10},{rank:2,playerId:player.playerId,score:5}])),config,player,'week-cross');
 assert.equal(duplicate.mine,null);assert.match(duplicate.reason,/重复/);
});

await test('军备分组、已结算和状态缺失明确返回，不将旧榜误作当前排行榜',async()=>{
 for(const [state,status,reason]of [
  [{...crossState([{rank:1,playerId:player.playerId,score:100}]),grouping:true},'grouping',/分组/],
  [{...crossState([{rank:1,playerId:player.playerId,score:100}]),settleTime:crossNow},'settled',/已结算/],
  [{subjectId:4,grouping:false},'unavailable',/未完整/],
  [crossState(undefined),'unavailable',/列表未完整/],
 ]){
  const c=crossClient(state),v=await readActivityRanking(c,config,player,'week-cross');
  assert.equal(v.status,status);assert.match(v.reason,reason);assert.deepEqual(v.rows,[]);assert.equal(v.mine,null);assert.equal(c.calls.length,1);
 }
 const absent=await readActivityRanking(crossClient({}),config,player,'week-cross');
 assert.equal(absent.subjectId,null);assert.equal(absent.subjectName,null);assert.equal(absent.roomLevel,null);
 assert.equal(absent.grouping,null);assert.equal(absent.settleTime,null);
 const shifted=crossClient(crossState([]),{at:'2026-11-18T13:00:00+08:00'});
 assert.equal((await readActivityRanking(shifted,config,player,'week-cross')).status,'settled','结算按服务器时钟偏移判断');
});

await test('军备榜不支持分页且始终只有一条只读查询，接口失败原样报告',async()=>{
 const c=crossClient(crossState([]));
 await assert.rejects(()=>readActivityRanking(c,config,player,'week-cross',2),/没有分页/);assert.deepEqual(c.calls,[]);
 await readActivityRanking(c,config,player,'week-cross');
 assert.deepEqual(c.calls,[{name:'CrossRankInfoRequest',body:{},response:'CrossRankInfoResponse'}]);
 const failed=crossClient(()=>{throw Error('军备排名读取超时');});
 await assert.rejects(()=>readActivityRanking(failed,config,player,'week-cross'),/读取超时/);
});
console.log('只读排行榜专项 '+count+'/'+count+' 通过');

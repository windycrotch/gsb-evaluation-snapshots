// 活动排行榜只读查询；请求白名单不包含领奖、挑战或购买。
import {rewardData} from './missing-rewards.mjs';
import {exactAutomationId,automationWireId} from './automation-policy.mjs';
const now=client=>Math.floor((Date.now()+(client.serverClockOffsetMs||0))/1000);
export function openRankWindows(client){
 const windows=client.openRankActivity?.activityTime;
 return Array.isArray(windows)?windows.filter(row=>Number.isSafeInteger(row.type)&&row.startTime<=now(client)&&now(client)<row.endTime):[];
}
const definitions=[
 {key:'pirate',label:'剿匪榜',module:'冲榜活动',kind:'open',type:3,scoreLabel:'积分'},
 {key:'war',label:'杀敌榜',module:'冲榜活动',kind:'open',type:4,scoreLabel:'积分'},
 {key:'orders',label:'订单榜',module:'冲榜活动',kind:'open',type:1,scoreLabel:'积分'},
 {key:'stages',label:'闯关榜',module:'冲榜活动',kind:'open',type:2,scoreLabel:'关卡'},
 {key:'week-cross',label:'军备竞赛',module:'每日跨服比拼',kind:'cross',scoreLabel:'积分'},
 {key:'world-boss',label:'世界Boss个人榜',module:'世界',kind:'boss',scoreLabel:'伤害'},
 {key:'league',label:'积分赛',module:'跨服积分赛',kind:'league',scoreLabel:'积分'},
];
function crossRankOpen(client,config,player){
 const world=exactAutomationId(player?.worldId),season=world?Number(BigInt(world)/1000000n%1000n):0;
 if(season>1)return true;
 const minimum=config?.tables?.CrossRankParamCfg?.data?.find(row=>row.paramName==='每日跨服比拼开启')?.paramValue;
 const opened=player?.worldOpenTime;
 return season===1&&Number.isSafeInteger(minimum)&&minimum>0&&Number.isSafeInteger(opened)&&opened>0
  &&Math.floor((now(client)+28800)/86400)-Math.floor((opened+28800)/86400)+1>=minimum;
}

// Preserve int64 before normalization: converting a protobuf Long to Number
// would irreversibly round high scores. Safe values retain the old number API.
function rankQuantity(value){
 let integer;
 if(typeof value==='number')return Number.isSafeInteger(value)&&value>=0?value:null;
 if(typeof value==='bigint')integer=value;
 else if(typeof value==='string'&&/^\d{1,19}$/.test(value))integer=BigInt(value);
 else if(Number.isInteger(value?.low)&&Number.isInteger(value?.high))integer=(BigInt(value.high)<<32n)+BigInt(value.low>>>0);
 else return null;
 if(integer<0n||integer>(1n<<63n)-1n)return null;
 return integer<=BigInt(Number.MAX_SAFE_INTEGER)?Number(integer):integer.toString();
}
const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;
const quantityText=value=>value===null?null:String(value).replace(/\B(?=(\d{3})+(?!\d))/g,',');
async function readCrossRanking(client,config,player,output){
 if(output.page!==1)throw Error('军备竞赛榜单没有分页');
 const state=await client.request('CrossRankInfoRequest',{},'CrossRankInfoResponse');
 const subjectId=positive(state?.subjectId),roomLevel=positive(state?.roomLevel),settleTime=positive(state?.settleTime);
 const subjectName=config?.tables?.CrossRankSubjectCfg?.data?.find(row=>row.subjectId===subjectId)?.name;
 Object.assign(output,{subjectId,subjectName:typeof subjectName==='string'&&subjectName.trim()?subjectName:null,
  roomLevel,grouping:typeof state?.grouping==='boolean'?state.grouping:null,settleTime,endTime:settleTime,status:'unavailable',checkedAt:now(client)});
 if(output.grouping===true)return {...output,status:'grouping',reason:'军备竞赛正在分组，榜单尚未就绪'};
 if(settleTime!==null&&settleTime<=now(client))return {...output,status:'settled',reason:'本场军备竞赛已结算，等待服务器下发下一场榜单'};
 if(output.grouping===null||subjectId===null||roomLevel===null||settleTime===null)return {...output,reason:'军备竞赛主题、分组或结算状态未完整返回'};
 if(!Array.isArray(state.rankList))return {...output,reason:'军备竞赛排行榜列表未完整返回'};
 const own=exactAutomationId(player?.playerId);
 output.status='active';
 output.rows=state.rankList.map(item=>{
  const playerId=exactAutomationId(item?.playerId),score=rankQuantity(item?.score);
  return {rank:positive(item?.rank),name:typeof item?.nickname==='string'&&item.nickname?item.nickname:'未返回名称',
   playerId,score,scoreText:quantityText(score),level:positive(item?.level),worldId:exactAutomationId(item?.worldId),
   power:rankQuantity(item?.power),own:!!own&&playerId===own};
 }).sort((left,right)=>(left.rank??Infinity)-(right.rank??Infinity));
 const mine=output.rows.filter(row=>row.own);
 output.mine=mine.length===1?mine[0]:null;
 if(!output.rows.length)output.reason='当前榜单暂无玩家记录';
 else if(mine.length>1)output.reason='服务器返回重复的本人记录，暂不能确认个人名次和积分';
 else if(!output.mine)output.reason='服务器榜单未返回本人记录，个人名次和积分尚未同步';
 return output;
}
export function activityRankCatalog(client,config,player){
 const unlocked=module=>{const level=config?.tables?.ModuleOpenCfg?.data?.find(r=>r.moduleId===module)?.playerLevel;return Number.isSafeInteger(level)&&player?.level>=level;};
 const active=new Set(openRankWindows(client).map(row=>row.type));
 const result=definitions.filter(d=>unlocked(d.module)&&(d.kind!=='open'||active.has(d.type))&&(d.kind!=='cross'||crossRankOpen(client,config,player))).map(d=>({...d}));
 for(const event of client.festivals??[]){
  const id=exactAutomationId(event.activityId);if(!id||!(event.startTime<=now(client)&&now(client)<event.endTime))continue;
  for(const [subType,type,label]of [[27,6,'走江踏浪榜'],[28,7,'龙王罗盘榜']]){
   const sub=event.subActivity?.find(s=>s.subActivityType===subType);if(!sub||(sub.openTime&&now(client)<sub.openTime)||(sub.closeTime&&now(client)>=sub.closeTime))continue;
   result.push({key:'activity:'+id+':'+type,label:(event.type?event.type.replace(/活动$/,'')+' · ':'')+label,kind:'festival',activityId:id,type,scoreLabel:'积分'});
  }
 }
 return result;
}
export async function readActivityRanking(client,config,player,key,page=1){
 if(!Number.isSafeInteger(page)||page<1||page>200)throw Error('排行榜页码无效');
 const tab=activityRankCatalog(client,config,player).find(t=>t.key===key);if(!tab)throw Error('该排行榜当前未开放或暂不支持');
 const ask=(name,body={})=>client.request(name+'Request',body,name+'Response').then(rewardData);
 const output={key,label:tab.label,scoreLabel:tab.scoreLabel,page,totalPages:1,rows:[],mine:null,reason:'',checkedAt:now(client)};
 let list,mine,scoreKey;
 if(tab.kind==='open'){
  // 当前客户端只显示Info返回的首屏。真实服务器未响应独立分页请求，不提供不可用的翻页。
  if(page!==1)throw Error('冲榜暂只支持首屏及本人名次');
  const state=await ask('OpenRankInfo',{type:tab.type});
  if(!Number.isSafeInteger(state.endTime)||state.endTime<=now(client))return {...output,reason:'当前冲榜活动未开放或已结束'};
  const board=state.leaderBoard;
  if(!board)throw Error('服务器未返回排行榜');list=board.item;mine=board.myItem;scoreKey='value';output.endTime=state.endTime;
  if(board.totalPage>1)output.reason='仅展示当前返回的前 '+(board.item?.length??0)+' 名及本人名次；后续分页暂不可用。';
 }else if(tab.kind==='boss'){
  const info=(await ask('WorldBossInfo')).info;if(!info?.bossId)return {...output,reason:'当前没有开放的世界Boss'};
  if(page!==1)throw Error('世界Boss榜单没有分页');
  const state=await ask('WorldBossPlayerRank');list=state.rankList;mine=state.myRank;scoreKey='damage';
 }else if(tab.kind==='league'){
  const state=await ask('LeagueRank',{page});list=state.items;scoreKey='score';output.totalPages=Math.max(1,state.maxPage||1);
 }else if(tab.kind==='cross'){
  return readCrossRanking(client,config,player,output);
 }else{
  const state=await ask('ActivityRank',{activityId:automationWireId(tab.activityId),type:tab.type,page});list=state.item;mine=state.myItem;scoreKey='score';output.totalPages=Math.max(1,state.totalPage||1);
 }
 if(!Array.isArray(list))throw Error('排行榜列表未完整返回');
 const own=exactAutomationId(player.playerId),row=item=>({rank:Number.isSafeInteger(item.rank)?item.rank:null,name:item.nickname||'未返回名称',playerId:exactAutomationId(item.playerId),score:Number.isSafeInteger(item[scoreKey])?item[scoreKey]:null,power:Number.isSafeInteger(item.power)?item.power:null,own:!!own&&exactAutomationId(item.playerId)===own});
 output.rows=list.map(row);output.mine=mine?row(mine):output.rows.find(r=>r.own)??null;
 if(!output.rows.length)output.reason='当前榜单暂无玩家记录';
 return output;
}

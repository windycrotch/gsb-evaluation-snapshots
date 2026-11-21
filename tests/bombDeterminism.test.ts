import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from '../src/game/simulation.ts';
import {EMPTY_INPUT,type Actor,type PlayerInput} from '../src/game/types.ts';
import {setActiveMap} from '../src/game/map.ts';
import {PLANT_SECONDS,BOMB_SECONDS,DEFUSE_SECONDS,KIT_DEFUSE_SECONDS} from '../src/game/objectiveInteraction.ts';

const HZ_LIST=[30,60,120] as const;
const HOLD={...EMPTY_INPUT,interact:true};
// Arena fallback bomb site A (OBJECTIVE_SITES in simulation.ts).
const SITE_A={id:'A' as const,x:-10,z:-5,radius:2.6};
// Open floor away from MAP_BOXES, used by bot defuser fixtures so that the
// 2.4 m interaction ray and navigation paths are never occluded by a wall.
const OPEN_BOMB={x:0,z:-5,y:0};

function makeSim(seed=101):Simulation{
 setActiveMap('desert');
 const sim=new Simulation(seed);
 sim.start('demolition');
 // Full local control: suppress every combat AI decision while keeping the
 // objective, movement and round rules driven by real simulation ticks.
 for(const a of sim.state.actors)a.player=true;
 sim.state.roundTime=100;
 return sim;
}
function place(a:Actor,p:{x:number;y?:number;z:number}){
 Object.assign(a,{x:p.x,z:p.z,y:p.y??0,groundY:p.y??0,verticalSpeed:0,climbing:false,moving:false,crouched:false,shotTime:-10});
}
function carrier(sim:Simulation):Actor{
 const t=sim.state.actors.find(a=>a.hasBomb)!;
 sim.state.player=t;place(t,SITE_A);
 return t;
}
function ticks(sim:Simulation,seconds:number,hz:number,input:PlayerInput=EMPTY_INPUT){
 const n=Math.round(seconds*hz);
 for(let i=0;i<n;i++)sim.update(1/hz,input);
 return n;
}
function plantBomb(sim:Simulation,hz=60):Actor{
 const t=carrier(sim);
 ticks(sim,PLANT_SECONDS,hz,HOLD);
 assert.equal(sim.state.bomb.status,'planted');
 assert.equal(sim.state.phase,'planted');
 assert.equal(sim.state.bomb.site,'A');
 return t;
}
function putBombForDefuse(sim:Simulation,kit=false):Actor{
 plantBomb(sim);
 const ct=sim.state.actors[0];
 sim.state.player=ct;ct.defuseKit=kit;
 place(ct,{x:sim.state.bomb.x,y:sim.state.bomb.y??0,z:sim.state.bomb.z});
 return ct;
}
/** Move the planted bomb onto verified open floor and keep its 40 s fuse. */
function relocatePlantedBomb(sim:Simulation){
 Object.assign(sim.state.bomb,{...OPEN_BOMB,status:'planted',timer:BOMB_SECONDS,progress:0,defuserId:null,defuseSeconds:null,assignedDefuserId:null,defuseAssignAt:-1});
 sim.state.phase='planted';
}
function count(sim:Simulation,type:string):number{
 return sim.state ? sim.events.filter(e=>e.type===type).length : 0;
}

for(const hz of HZ_LIST)test(`[${hz}Hz] plant accumulates only while stationary inside the site and finishes exactly once`,()=>{
 const sim=makeSim(7),t=carrier(sim);
 // Final 0.2 s of planting must land completion on the same tick at every rate.
 ticks(sim,PLANT_SECONDS-.2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'carried');
 const before=sim.state.bomb.plantProgress??0;
 assert.ok(before<.999&&before>.9,`progress near end: ${before}`);
 ticks(sim,.2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'planted');
 assert.equal(count(sim,'plantComplete'),1);
 assert.equal(count(sim,'plantStart'),1);
 assert.equal(sim.state.phase,'planted');
 // Leaving the site wipes progress instantly, even while holding interact.
 place(t,{x:0,z:15});ticks(sim,.1,hz,HOLD);
 assert.equal(sim.state.bomb.plantProgress??0,0);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] moving or jumping resets plant progress immediately`,()=>{
 const sim=makeSim(8),t=carrier(sim);
 ticks(sim,1,hz,HOLD);
 assert.ok((sim.state.bomb.plantProgress??0)>0.3);
 // Stepping outside the site while holding interact drops eligibility at once.
 place(t,{x:0,z:15});ticks(sim,.05,hz,HOLD);
 assert.equal(sim.state.bomb.plantProgress??0,0,'leaving the site clears plant progress');
 place(t,SITE_A);
 ticks(sim,1,hz,HOLD);
 assert.ok((sim.state.bomb.plantProgress??0)>0.3);
 // A real jump leaves the ground on the first jump frame; the airborne
 // carrier is immediately ineligible, so no progress can accumulate.
 const grounded=(sim.state.bomb.plantProgress??0);
 sim.update(1/hz,{...HOLD,jump:true});
 assert.ok((sim.state.bomb.plantProgress??0)<=grounded,'jump never advances plant progress');
 ticks(sim,.2,hz,HOLD);
 assert.equal(sim.state.bomb.plantProgress??0,0,'airborne carrier cannot plant');
});

for(const hz of HZ_LIST)for(const kit of [false,true])test(`[${hz}Hz] defuse takes ${kit?5:10}s and the last 0.2s resolves once`,()=>{
 const sim=makeSim(9),ct=putBombForDefuse(sim,kit);
 sim.events=[];
 const seconds=kit?KIT_DEFUSE_SECONDS:DEFUSE_SECONDS;
 ticks(sim,seconds-.2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'planted');
 assert.ok(sim.state.bomb.progress<.999&&sim.state.bomb.progress>.8);
 ticks(sim,.2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(sim.state.bomb.progress,1);
 assert.equal(sim.state.winner,'blue');
 assert.equal(sim.state.blueScore,1);
 assert.equal(count(sim,'defuseComplete'),1);
 assert.equal(count(sim,'defuseStart'),1);
 assert.match(sim.state.roundReason!,/拆除/);
 assert.ok(ct.health>0);
 // The round stays settled: further ticks never emit a second settlement.
 ticks(sim,2,hz);
 assert.equal(count(sim,'defuseComplete'),1);
 assert.equal(sim.state.blueScore,1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] a defuser dying mid-defuse reassigns and the replacement restarts from zero`,()=>{
 const sim=makeSim(10);putBombForDefuse(sim,false);
 ticks(sim,4,hz,HOLD);
 assert.ok(sim.state.bomb.progress>.35);
 const first=sim.state.actors[0];
 first.health=0;
 // A second living bot CT is already standing on the bomb and takes over.
 const second=sim.state.actors[1];second.player=false;sim.state.player=second;
 place(second,{x:sim.state.bomb.x,y:sim.state.bomb.y??0,z:sim.state.bomb.z});
 // The old holder's accumulated fraction is discarded; the replacement runs
 // its own attempt from zero (its first frame adds at most one objective step).
 ticks(sim,.1,hz);
 assert.equal(sim.state.bomb.defuserId,second.id);
 assert.ok(sim.state.bomb.progress<=.1,'new defuser starts its own attempt from zero');
 assert.equal(count(sim,'defuseStart'),2,'each holder owns one defuse attempt');
 ticks(sim,DEFUSE_SECONDS,hz);
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(count(sim,'defuseComplete'),1);
 assert.equal(sim.state.blueScore,1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] swapping the defuser without a death also zeroes progress`,()=>{
 const sim=makeSim(11);putBombForDefuse(sim,true);
 ticks(sim,2,hz,HOLD);
 assert.ok(sim.state.bomb.progress>.3);
 const first=sim.state.actors[0];
 // First defuser walks away: no eligible holder, progress clears.
 place(first,{x:first.x+4,y:sim.state.bomb.y??0,z:first.z});
 ticks(sim,.1,hz,HOLD);
 assert.equal(sim.state.bomb.defuserId,null);
 assert.equal(sim.state.bomb.progress,0);
 const second=sim.state.actors[1];second.player=false;sim.state.player=second;
 place(second,{x:sim.state.bomb.x,y:sim.state.bomb.y??0,z:sim.state.bomb.z});
 ticks(sim,DEFUSE_SECONDS,hz);
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(count(sim,'defuseComplete'),1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] changing the defuse kit mid-attempt restarts progress with the new duration`,()=>{
 const sim=makeSim(22);const ct=putBombForDefuse(sim,false);
 sim.events=[];
 ticks(sim,5,hz,HOLD);
 assert.equal(sim.state.bomb.defuseSeconds,DEFUSE_SECONDS);
 assert.ok(sim.state.bomb.progress>.45);
 // Picking up a kit changes the required seconds; the old fraction is discarded.
 ct.defuseKit=true;
 ticks(sim,.1,hz,HOLD);
 assert.ok(sim.state.bomb.progress<=.1,'old fraction is discarded; new attempt starts from zero');
 assert.equal(sim.state.bomb.defuseSeconds,KIT_DEFUSE_SECONDS);
 assert.equal(count(sim,'defuseStart'),2,'the restart emits one additional defuseStart');
 ticks(sim,KIT_DEFUSE_SECONDS,hz,HOLD);
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(count(sim,'defuseComplete'),1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] after planting, eliminating every T does not end the round until defuse/explosion`,()=>{
 const sim=makeSim(12);plantBomb(sim);
 for(const a of sim.state.actors.filter(a=>a.faction==='t'))a.health=0;
 ticks(sim,.5,hz);
 assert.equal(sim.state.phase,'planted');
 assert.equal(sim.state.winner,null);
 assert.equal(sim.state.redScore,0);
 assert.equal(sim.state.blueScore,0);
 const ct=sim.state.actors[0];sim.state.player=ct;ct.defuseKit=true;
 place(ct,{x:sim.state.bomb.x,z:sim.state.bomb.z});
 sim.events=[];
 ticks(sim,KIT_DEFUSE_SECONDS,hz,HOLD);
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(sim.state.winner,'blue');
 assert.equal(sim.state.blueScore,1);
 assert.equal(count(sim,'defuseComplete'),1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] after planting, eliminating every CT wins the round for T immediately`,()=>{
 const sim=makeSim(13);plantBomb(sim);
 for(const a of sim.state.actors.filter(a=>a.faction==='ct'))a.health=0;
 ticks(sim,.1,hz);
 assert.equal(sim.state.phase,'roundEnd');
 assert.equal(sim.state.winner,'red');
 assert.equal(sim.state.redScore,1);
 assert.equal(sim.state.bomb.status,'planted','bomb itself is neither defused nor exploded');
 // The bomb does not keep ticking into an explosion after the round is settled.
 const timer=sim.state.bomb.timer;
 ticks(sim,3,hz);
 assert.equal(sim.state.bomb.status,'planted');
 assert.equal(sim.state.bomb.timer,timer);
 assert.equal(sim.state.redScore,1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] before planting, T wipe and CT wipe each settle exactly one round`,()=>{
 // T eliminated before plant -> CT win.
 const simA=makeSim(14);carrier(simA);simA.events=[];
 for(const a of simA.state.actors.filter(a=>a.faction==='t'))a.health=0;
 ticks(simA,.1,hz);
 assert.equal(simA.state.winner,'blue');
 assert.equal(simA.state.blueScore,1);
 assert.equal(count(simA,'round'),1);
 ticks(simA,2,hz);
 assert.equal(simA.state.blueScore,1);

 // CT eliminated before plant -> T win.
 const simB=makeSim(15);carrier(simB);simB.events=[];
 for(const a of simB.state.actors.filter(a=>a.faction==='ct'))a.health=0;
 ticks(simB,.1,hz);
 assert.equal(simB.state.winner,'red');
 assert.equal(simB.state.redScore,1);
 assert.equal(count(simB,'round'),1);
 ticks(simB,2,hz);
 assert.equal(simB.state.redScore,1);
});

for(const hz of HZ_LIST)test(`[${hz}Hz] bot defuser is the nearest reachable living CT and is reassigned on death`,()=>{
 const sim=makeSim(16);plantBomb(sim);relocatePlantedBomb(sim);
 // Remove the human and all Ts; leave two bot CTs at different distances.
 sim.state.player.health=0;
 for(const a of sim.state.actors.filter(a=>a.faction==='t'))a.health=0;
 const near=sim.state.actors[1],far=sim.state.actors[2];
 sim.state.actors.forEach(a=>{if(a!==near&&a!==far&&a.faction==='ct')a.health=0;});
 near.player=false;far.player=false;far.defuseKit=true;
 place(near,{x:OPEN_BOMB.x+1.2,y:OPEN_BOMB.y,z:OPEN_BOMB.z});
 place(far,{x:OPEN_BOMB.x+4,y:OPEN_BOMB.y,z:OPEN_BOMB.z});
 ticks(sim,.3,hz);
 assert.equal(sim.state.bomb.assignedDefuserId,near.id);
 near.health=0;
 ticks(sim,.3,hz);
 assert.equal(sim.state.bomb.assignedDefuserId,far.id,'dead defuser is replaced');
 // The replacement walks in and finishes; progress must never stall forever.
 let stalled=0,last=-1,maxStall=0;
 for(let frame=0;frame<40*hz&&sim.state.bomb.status==='planted';frame++){
  sim.update(1/hz,EMPTY_INPUT);
  if(sim.state.bomb.defuserId===far.id){
   if(Math.abs(sim.state.bomb.progress-last)<1e-9)stalled++;else stalled=0;
   maxStall=Math.max(maxStall,stalled);
   last=sim.state.bomb.progress;
  }
 }
 assert.equal(sim.state.bomb.status,'defused');
 assert.equal(count(sim,'defuseComplete'),1);
 assert.ok(maxStall<2*hz,'defuse progress does not stall while a bot is assigned');
});

for(const hz of HZ_LIST)test(`[${hz}Hz] bot defuser assignment skips a living CT that cannot reach the bomb`,()=>{
 const sim=makeSim(17);plantBomb(sim);relocatePlantedBomb(sim);
 sim.state.player.health=0;
 for(const a of sim.state.actors.filter(a=>a.faction==='t'))a.health=0;
 const trapped=sim.state.actors[1],openBot=sim.state.actors[2];
 sim.state.actors.forEach(a=>{if(a!==trapped&&a!==openBot&&a.faction==='ct')a.health=0;});
 trapped.player=false;openBot.player=false;
 // Different floor level: the height gap alone makes the bomb unreachable, even
 // though the trapped bot is closer in XZ distance.
 place(trapped,{x:OPEN_BOMB.x-3,y:OPEN_BOMB.y+3,z:OPEN_BOMB.z});
 place(openBot,{x:OPEN_BOMB.x+4,y:OPEN_BOMB.y,z:OPEN_BOMB.z});
 ticks(sim,.3,hz);
 assert.equal(sim.state.bomb.assignedDefuserId,openBot.id,'unreachable nearer CT is never assigned');
});

for(const hz of HZ_LIST)test(`[${hz}Hz] pause freezes every bomb clock and resumes from the same progress`,()=>{
 // Plant progress frozen.
 const sim=makeSim(18),t=carrier(sim);
 ticks(sim,1.2,hz,HOLD);
 const plantAt=sim.state.bomb.plantProgress??0;
 assert.ok(plantAt>0);
 sim.setPaused(true);
 const snapshot=JSON.stringify(sim.state);
 for(let i=0;i<2*hz;i++)sim.update(1/hz,HOLD);
 assert.equal(JSON.stringify(sim.state),snapshot);
 sim.setPaused(false);
 ticks(sim,PLANT_SECONDS-1.2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'planted');
 assert.equal(count(sim,'plantComplete'),1);

 // Defuse progress and fuse frozen.
 const ct=sim.state.actors[0];sim.state.player=ct;
 place(ct,{x:sim.state.bomb.x,y:sim.state.bomb.y??0,z:sim.state.bomb.z});ct.defuseKit=true;
 ticks(sim,2,hz,HOLD);
 const defuseAt=sim.state.bomb.progress,timerAt=sim.state.bomb.timer;
 assert.ok(defuseAt>0);
 sim.setPaused(true);
 const frozen=JSON.stringify(sim.state);
 for(let i=0;i<3*hz;i++)sim.update(1/hz,HOLD);
 assert.equal(JSON.stringify(sim.state),frozen);
 sim.setPaused(false);
 ticks(sim,KIT_DEFUSE_SECONDS-2,hz,HOLD);
 assert.equal(sim.state.bomb.status,'defused');
 assert.ok(Math.abs(timerAt-sim.state.bomb.timer-(KIT_DEFUSE_SECONDS-2))<.05,'fuse resumes where it stopped');
 assert.equal(count(sim,'defuseComplete'),1);
});

test('plant and defuse can never jump from 0 to 1 inside one frame',()=>{
 for(const hz of HZ_LIST){
  // Oversized delta times (lag spikes / low frame rates) must not instant-plant.
  const sim=makeSim(19),t=carrier(sim);
  sim.update(.5,HOLD);
  assert.equal(sim.state.bomb.status,'carried');
  assert.ok((sim.state.bomb.plantProgress??0)>0&&(sim.state.bomb.plantProgress??0)<1,`plant ${hz}`);
  sim.update(5,HOLD);
  assert.notEqual(sim.state.bomb.plantProgress,1);

  const sim2=makeSim(20);putBombForDefuse(sim2,true);sim2.events=[];
  sim2.update(.5,HOLD);
  assert.equal(sim2.state.bomb.status,'planted');
  assert.ok(sim2.state.bomb.progress>0&&sim2.state.bomb.progress<1,`defuse ${hz}`);
  // The first frame is capped below completion; only a subsequent frame can finish.
  assert.equal(sim2.state.bomb.progress,.1,`fresh defuse is capped at one objective step (${hz})`);
  sim2.update(5,HOLD);
  assert.equal(sim2.state.bomb.status,'defused');
  assert.equal(count(sim2,'defuseComplete'),1);
 }
});

for(const hz of HZ_LIST)test(`[${hz}Hz] detonation wins for T and emits the explosion settlement exactly once`,()=>{
 const sim=makeSim(21);plantBomb(sim);
 sim.state.bomb.timer=.5;
 for(const a of sim.state.actors.filter(a=>a.faction==='ct'))a.health=1;
 ticks(sim,.5+1/hz,hz);
 assert.equal(sim.state.bomb.status,'exploded');
 assert.equal(sim.state.winner,'red');
 assert.equal(sim.state.redScore,1);
 assert.equal(count(sim,'bombExplode'),1);
 assert.match(sim.state.roundReason!,/引爆/);
 ticks(sim,2,hz);
 assert.equal(count(sim,'bombExplode'),1);
 assert.equal(sim.state.redScore,1);
});

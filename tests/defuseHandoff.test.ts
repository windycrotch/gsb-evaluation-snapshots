import test from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from '../src/game/simulation';
import {setActiveMap,type MapId} from '../src/game/map';
import {blocked} from '../src/game/collision';
import {EMPTY_INPUT,type Actor} from '../src/game/types';
import {squadOrder} from '../src/game/botCombat';
import {findBotCover,concealedAt,defuseAssignee,orderedDefuseCandidates,allyOccupies,botObjective} from '../src/game/botTactics';
import {DEFUSE_SECONDS} from '../src/game/objectiveInteraction';

function onMap<T>(map:MapId,run:()=>T):T{try{setActiveMap(map);return run();}finally{setActiveMap('desert');}}

/** A demolition round on a real arena map: two CT bots (ids 1 and 2) plus the
 * passive human (id 0). Red attackers are already eliminated so only defuse
 * logic runs. The human is parked far away and is never driven by input. */
function plantedRound(map:MapId='snow',seed=77){
 const sim=new Simulation(seed);sim.setBotCounts(2,1);sim.start('demolition');
 const s=sim.state;s.phase='planted';
 const bomb={...s.bomb,status:'planted' as const,carrierId:null,x:0,z:0,y:0,site:'A' as const,timer:40,progress:0,defuserId:null,defuseAssigneeId:null};
 s.bomb=bomb;
 for(const a of s.actors)if(a.faction==='t')a.health=0;
 const ct=s.actors.filter(a=>a.faction==='ct');
 const human=ct.find(a=>a.player)!;Object.assign(human,{x:0,z:16});
 const bots=ct.filter(a=>!a.player);
 return {sim,s,bomb,bots,human};
}
function place(a:Actor,x:number,z:number){a.x=x;a.z=z;a.y=0;a.groundY=0;a.moving=false;a.crouched=false;a.climbing=false;a.verticalSpeed=0;}
function frames(sim:Simulation,count:number,hz=60){for(let i=0;i<count;i++)sim.update(1/hz,EMPTY_INPUT);}

test('normal firefight: two CT bots keep squad roles and actually fire',()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound();
 s.phase='playing';
 const enemy=s.actors.find(a=>a.faction==='t')!;enemy.health=100;
 Object.assign(enemy,{x:0,z:-4,y:0});
 bots.forEach((b,i)=>place(b,i===0?-.8:.8,2));
 for(let i=0;i<60*3;i++){
  s.time+=1/60;for(const a of s.actors){for(const g of Object.values(a.guns))g.cooldown=Math.max(0,g.cooldown-1/60);}
  (sim as any).bot(bots[0],1/60);(sim as any).bot(bots[1],1/60);
 }
 const diagnostics=sim.botDiagnostics().filter(d=>bots.some(b=>b.id===d.id));
 assert.ok(diagnostics.length===2);
 assert.ok(sim.events.some(e=>e.type==='shot'&&bots.some(b=>b.id===e.actorId)),'a covering CT must still shoot');
 assert.equal(blocked(bots[0].x,bots[0].z),false);assert.equal(blocked(bots[1].x,bots[1].z),false);
}));

test('killing the defuser hands the task to another reachable CT; progress restarts at zero',()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound();
 const [a,b]=bots;place(a,1.1,0);place(b,0,4.2);
 // Let A own and partially defuse the bomb.
 frames(sim,120);
 assert.equal(s.bomb.defuserId,a.id,'nearest CT becomes the single defuser');
 assert.ok(s.bomb.progress>.2,'progress accumulates while stationary');
 const deathTime=s.time;
 // Defuser dies: a living partner must take over within a bounded window.
 a.health=0;
 let handoffAt=-1;
 for(let i=0;i<60*12;i++){
  sim.update(1/60,EMPTY_INPUT);
  if(handoffAt<0&&s.bomb.defuserId===b.id&&s.bomb.progress>0)handoffAt=s.time;
  if(s.bomb.status==='defused')break;
 }
 assert.ok(handoffAt>=0,'a living teammate takes over');
 assert.ok(handoffAt-deathTime<8,`handoff completed within bounded time (${(handoffAt-deathTime).toFixed(2)}s)`);
 assert.ok(sim.events.some(e=>e.type==='defuseStart'&&e.actorId===b.id));
 assert.equal(s.bomb.status,'defused','the new defuser finishes before the fuse');
 assert.equal(s.bomb.defuserId,null);
}));

test('a brief leave-and-return never creates two simultaneous defusers',()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound();
 const [a,b]=bots;
 place(a,1.1,0);place(b,0,1.2); // both physically on the bomb
 frames(sim,60); // establish A as the single defuser
 assert.equal(s.bomb.defuserId,a.id);
 const owner=a.id;
 // Measure a clean single-rate window with both candidates adjacent.
 const start=s.bomb.progress,before=s.time;
 for(let i=0;i<60;i++){place(b,0,1.2);sim.update(1/60,EMPTY_INPUT);assert.equal(s.bomb.defuserId,owner,'only the assignee ever owns progress');}
 const rate=(s.bomb.progress-start)/(s.time-before);
 assert.ok(Math.abs(rate-1/DEFUSE_SECONDS)<1/DEFUSE_SECONDS*.35,`progress rate is single, got ${rate.toFixed(3)} vs ${(1/DEFUSE_SECONDS).toFixed(3)}`);
 // Step out of use range for a short interval (below the handoff grace) while
 // the partner stays on the bomb.
 const progressBefore=s.bomb.progress;
 for(let i=0;i<Math.round(.45*60);i++){place(a,3.4,0);place(b,0,1.2);sim.update(1/60,EMPTY_INPUT);assert.ok(s.bomb.defuserId===owner||s.bomb.defuserId===null,'no second defuser while the owner is briefly away');}
 assert.equal(s.bomb.defuserId,null,'progress pauses (and resets) while out of range');
 assert.ok(s.bomb.progress<.02,'no silent accumulation by the bystander');
 // Return within the grace window: the original owner resumes exactly once.
 for(let i=0;i<30;i++){place(a,1.1,0);place(b,0,1.2);sim.update(1/60,EMPTY_INPUT);if(s.bomb.defuserId!==null){assert.equal(s.bomb.defuserId,owner,'the original owner resumes');break;}}
 assert.ok(s.bomb.progress>=0&&s.bomb.progress<progressBefore,'progress restarts from zero rather than jumping');
 const events=sim.events.filter(e=>e.type==='defuseStart').length;
 assert.ok(events<=2,'at most one restart, never thrashing between two defusers');
}));

test('two simultaneous candidates still produce exactly one effective defuser at every tick',()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound();
 const [a,b]=bots;
 place(a,1.0,0);place(b,-1.0,0);
 let seenA=false,seenB=false;
 for(let i=0;i<60*2;i++){
  // Force both to stay on the bomb so both are simultaneously eligible.
  place(a,1.0,0);place(b,-1.0,0);
  sim.update(1/60,EMPTY_INPUT);
  const owners=[a,b].filter(x=>s.bomb.defuserId===x.id);
  if(s.bomb.defuserId!==null)assert.equal(owners.length,1,'at most one actor owns progress');
  if(s.bomb.defuserId===a.id)seenA=true;if(s.bomb.defuserId===b.id)seenB=true;
 }
 assert.ok(seenA||seenB,'one candidate actually defuses');
 assert.ok(!(seenA&&seenB),'ownership never alternates between the two bystanders');
}));

for(const hz of [30,60,120])test(`defuse handoff after defuser death is consistent at ${hz} Hz without wall clipping`,()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound('snow',123);
 const [a,b]=bots;place(a,1.1,0);place(b,0,4.5);
 frames(sim,hz*2); // A reaches + defuses a little
 assert.equal(s.bomb.defuserId,a.id);
 a.health=0;
 let handoffAt=-1;
 for(let i=0;i<hz*14&&s.bomb.status==='planted';i++){
  sim.update(1/hz,EMPTY_INPUT);
  for(const actor of s.actors)if(actor.health>0)assert.equal(blocked(actor.x,actor.z),false,`actor ${actor.id} stayed out of walls at ${hz} Hz`);
  if(handoffAt<0&&s.bomb.defuserId===b.id&&s.bomb.progress>0)handoffAt=s.time;
 }
 assert.ok(handoffAt>=0,`handoff occurred at ${hz} Hz`);
 assert.equal(s.bomb.status,'defused',`defuse completed at ${hz} Hz`);
 assert.ok(sim.events.filter(e=>e.type==='defuseStart').length<=2,'the task changed hands at most once');
}));

test('a clean single-defuser run takes the same wall-clock time at 30/60/120 Hz',()=>{
 // The defuse rate is elapsed-time based, so completion time must not depend on
 // tick size. The other candidate stands within reach but never accumulates.
 const durations:number[]=[];
 for(const hz of [30,60,120])onMap('snow',()=>{
  const {sim,s,bots}=plantedRound('snow',5);
  const [a,b]=bots;place(a,1.1,0);place(b,0,1.2);
  s.bomb.timer=60;
  const start=s.time;
  for(let i=0;i<hz*20&&s.bomb.status==='planted';i++){
   if(s.bomb.defuserId!==null){place(a,s.bomb.defuserId===a.id?1.1:3.4,0);if(s.bomb.defuserId!==a.id)place(b,0,1.2);}
   sim.update(1/hz,EMPTY_INPUT);
  }
  assert.equal(s.bomb.status,'defused',`completed at ${hz} Hz`);
  durations.push(s.time-start);
 });
 const spread=Math.max(...durations)-Math.min(...durations);
 assert.ok(spread<.25,`completion time is tick-independent within tolerance: ${JSON.stringify(durations)}`);
});

test('defuse assignee is unique and prefers a CT that can reach the bomb',()=>onMap('snow',()=>{
 const {s,bots}=plantedRound();
 const [a,b]=bots;place(a,0,1);place(b,0,1);
 s.bomb.defuseAssigneeId=null;
 const ordered=orderedDefuseCandidates(s,false);
 assert.deepEqual(ordered.map(x=>x.id),[a.id,b.id].sort((x,y)=>x-y),'deterministic distance/id order');
 assert.equal(defuseAssignee(s,false)?.id,a.id);
 s.bomb.defuseAssigneeId=b.id;
 assert.equal(defuseAssignee(s,false)?.id,b.id,'the committed slot wins');
 const roles=s.actors.filter(x=>x.faction==='ct'&&!x.player).map(x=>botObjective(x,s).role);
 assert.equal(roles.filter(r=>r==='defuse').length,1,'one bot owns defuse, the other guards');
}));

test('defusing guards stand apart instead of stacking on the bomb',()=>onMap('snow',()=>{
 const {s,bots}=plantedRound();
 place(bots[0],1,0);place(bots[1],-1,0);
 s.bomb.defuseAssigneeId=bots[1].id;
 const roles=s.actors.filter(x=>x.faction==='ct'&&!x.player).map(x=>({id:x.id,role:botObjective(x,s).role,point:botObjective(x,s).point}));
 const guard=roles.find(r=>r.id===bots[0].id)!;
 assert.equal(guard.role,'guard');
 assert.ok(Math.hypot(guard.point.x-s.bomb.x,guard.point.z-s.bomb.z)>2.5,'guard holds an offset post, not the bomb tile');
}));

test('reloading, low-health, inactive and knife-only allies are never support anchors',()=>{
 const sim=new Simulation(5);sim.setBotCounts(3,1);sim.start('deathmatch');
 const s=sim.state;s.actors.forEach(a=>a.health=0);
 // Observer holds only a knife, so it can never be the anchor itself.
 const observer=s.actors[1],first=s.actors[2],second=s.actors[3];
 for(const a of [observer,first,second]){a.health=100;a.x=0;a.z=0;a.weapon='rifle';}
 observer.weapon='knife';
 first.x=1;first.z=0;second.x=-1;second.z=0;
 const enemy=s.actors.at(-1)!;enemy.health=100;enemy.x=0;enemy.z=-5;
 const order=()=>squadOrder(observer,s.actors.map(actor=>({actor,seeing:true})),enemy,s.time,'deathmatch').supportId;
 // Both firearm teammates are ready: the lower id anchors.
 first.guns.rifle.reloadLeft=0;second.guns.rifle.reloadLeft=0;
 assert.equal(order(),first.id);
 // A reloading teammate is skipped in favour of the ready one.
 first.guns.rifle.reloadLeft=1.2;assert.equal(order(),second.id);
 // A low-health teammate is skipped too.
 first.guns.rifle.reloadLeft=0;second.health=20;assert.equal(order(),first.id);
 // An inactive teammate never anchors covering fire.
 second.health=100;first.active=false;assert.equal(order(),second.id);
 assert.notEqual(order(),observer.id,'a knife-only observer is not its own fire base');
});

test('a guarding teammate still lays covering fire while the defuser works',()=>onMap('snow',()=>{
 const {sim,s,bots}=plantedRound();
 const [a,b]=bots;
 place(a,0,-1);place(b,0,6); // A on the bomb, B guarding behind
 s.bomb.defuseAssigneeId=a.id;
 // One live attacker down the open central lane, visible to the guard.
 const enemy=s.actors.find(x=>x.faction==='t')!;enemy.health=500;Object.assign(enemy,{x:0,z:-11,y:0,yaw:Math.PI});
 sim.events=[];
 for(let i=0;i<60*4;i++){
  // Keep the defuser pinned on the bomb so the role split is stable.
  if(s.bomb.defuserId===a.id){place(a,0,-1);}
  sim.update(1/60,EMPTY_INPUT);
 }
 assert.ok(sim.events.some(e=>e.type==='shot'&&e.actorId===b.id),'the guard fires at the visible attacker');
 assert.ok(sim.events.some(e=>e.type==='defuseStart'&&e.actorId===a.id),'the defuser holds the objective');
 // While B is reloading it must not be treated as the squad fire base.
 b.guns[b.weapon].reloadLeft=2;
 const anchor=squadOrder(b,[{actor:a,seeing:true},{actor:b,seeing:true}],enemy,s.time,'demolition').supportId;
 assert.notEqual(anchor,b.id,'a reloading guard is not its own support anchor');
}));

test('an occupied cover point yields another reachable point that blocks the threat line',()=>onMap('desert',()=>{
 const sim=new Simulation(9);sim.start('demolition');const s=sim.state;
 const a=s.actors[1],b=s.actors[2],threat={x:0,z:2};
 a.x=3;a.z=7;b.x=3;b.z=7; // B occupies A's spot
 const first=findBotCover(a,threat)!;assert.ok(first);
 // Occupy the chosen cover with a living ally: a new point must be selected.
 b.x=first.x;b.z=first.z;
 const second=findBotCover(a,threat,[b])!;
 assert.ok(second,'cover search still returns a point');
 assert.ok(Math.hypot(second.x-first.x,second.z-first.z)>=1.15,'not the occupied spot');
 assert.equal(blocked(second.x,second.z,.4),false,'the new point is walkable');
 assert.ok(concealedAt(second,threat,true),'the new point conceals the body from the threat');
 assert.equal(allyOccupies(a,second,[b]),false,'the chosen point is not also occupied');
}));

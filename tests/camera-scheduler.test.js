import test from 'node:test';
import assert from 'node:assert/strict';
import {autoQuickFormats,createAutoScanScheduler,hasColorSignal} from '../src/scanner/camera-scheduler.js';

test('Auto quick scans cover every regular symbology and keep QR on every pass',()=>{
 const quick=Array.from({length:5},(_,i)=>autoQuickFormats(i));
 assert.ok(quick.every(list=>list.includes('QRCode')));
 const formats=new Set(quick.flat());
 for(const type of ['QRCode','DataMatrix','Aztec','Code128','EAN13','MicroQRCode','MicroPDF417','DataBarExpStk'])
   assert.ok(formats.has(type),'Auto quick coverage missing '+type);
 assert.deepEqual(autoQuickFormats(5),quick[0]);
 assert.deepEqual(autoQuickFormats(-1),quick[4]);
});

test('Auto gives at least four regular scans between specialized work',()=>{
 const scanner=createAutoScanScheduler(0);
 const tasks=[];
 let now=0;
 for(let i=0;i<250;i++){
   const kind=scanner.next(now);
   tasks.push({kind,time:now});
   const duration=kind==='standard'?115:kind==='pdf417'?570:kind==='chroma'?1200:1500;
   now+=duration+240;
   scanner.report(kind,now,duration);
 }
 const quick=tasks.filter(t=>t.kind==='standard').length;
 assert.ok(quick>=tasks.length*.72,'Auto must prioritize common codes');
 for(const kind of ['pdf417','dotcode','chroma','iris'])
   assert.ok(tasks.some(t=>t.kind===kind),'Auto must eventually try '+kind);
 for(let i=0;i<tasks.length;i++){
   if(tasks[i].kind==='standard')continue;
   assert.ok(i>=4,'Auto started specialized scans too soon');
   assert.ok(tasks.slice(i-4,i).every(t=>t.kind==='standard'),
     'Auto ran specialized scans without four quick reads');
 }
});

test('Slow color scans are cooled down while the other formats continue',()=>{
 const scanner=createAutoScanScheduler(0);
 let now=0,first=null,second=null,iris=0;
 for(let i=0;i<700;i++){
  const kind=scanner.next(now);
  if(kind==='chroma'){
   if(first!==null){second=now;break}
   first=now;scanner.report(kind,now+3400,3400);now+=3400;
  }else{
   if(kind==='iris'){iris++;scanner.report('iris',now+1600,1600)}
   now+=kind==='standard'?630:1400;
  }
 }
 assert.ok(first!==null&&second!==null,'ChromaQR must still run');
 assert.ok(second-first>=30000,'Slow ChromaQR needs a reasonable cooldown');
 assert.ok(iris>=1,'IRIS must retain periodic scanning');
});

test('Fresh camera sessions reset the format schedule',()=>{
 const first=createAutoScanScheduler(500);
 const second=createAutoScanScheduler(500);
 for(let i=0;i<5;i++)assert.equal(first.next(i*300+500),second.next(i*300+500));
});


test('DotCode is scheduled in Auto without monopolizing the camera',()=>{
 const scanner=createAutoScanScheduler(0);
 const tasks=[];
 let now=0;
 for(let i=0;i<360;i++){
  const kind=scanner.next(now),duration=kind==='standard'?120:kind==='dotcode'?750:kind==='pdf417'?430:1050;
  tasks.push({kind,time:now});now+=duration+240;scanner.report(kind,now,duration);
 }
 const dot=tasks.filter(x=>x.kind==='dotcode');
 assert.ok(dot.length>=2,'DotCode must be attempted periodically in Auto');
 assert.ok(dot.length<tasks.length*.08,'DotCode must stay infrequent to protect frame rate');
 for(const task of dot){
  const index=tasks.indexOf(task);
  assert.ok(index>=4&&tasks.slice(index-4,index).every(x=>x.kind==='standard'),
   'DotCode must follow at least four common-code reads');
 }
});

test('Slow DotCode decoding receives a longer Auto cooldown',()=>{
 const scanner=createAutoScanScheduler(0);
 const seen=[];
 let now=0,first=null;
 for(let i=0;i<180;i++){
  const kind=scanner.next(now);
  if(kind==='dotcode'){
   if(first!==null){assert.ok(now-first>=11000,'DotCode ran before cooldown');return}
   first=now;scanner.report(kind,now+3500,3500);now+=3500;
  }else now+=kind==='standard'?420:1200;
  seen.push(kind);
 }
 assert.fail('Auto never resumed DotCode after cooldown');
});

test('Auto starts with common codes, not expensive readers',()=>{
 const scanner=createAutoScanScheduler(0);
 assert.ok(Array.from({length:12},(_,i)=>scanner.next(i*250)).every(kind=>kind==='standard'));
});

test('Auto tries DotCode repeatedly rather than once every 20 seconds',()=>{
 const scanner=createAutoScanScheduler(0);
 let now=0,dot=0,first=Infinity;
 for(let i=0;i<130;i++){
  const kind=scanner.next(now);
  if(kind==='dotcode'){dot++;first=Math.min(first,now)}
  now+=kind==='standard'?580:1350;
 }
 assert.ok(dot>=3,'Auto should try DotCode multiple times');
 assert.ok(first>=4000&&first<10000,'Auto should begin DotCode attempts promptly');
});


test('ChromaQR and IRIS get early opportunities without starving standard scans',()=>{
 const scheduler=createAutoScanScheduler(0);
 const first={};
 let now=0,regular=0,heavy=0;
 for(let i=0;i<140;i++){
  const kind=scheduler.next(now);
  if(!(kind in first))first[kind]=now;
  if(kind==='standard')regular++;else heavy++;
  const decodeMs=kind==='standard'?180:kind==='dotcode'?900:kind==='chroma'?1400:1100;
  now+=decodeMs+620;
  scheduler.report(kind,now,decodeMs);
 }
 assert.ok(first.chroma>=5000&&first.chroma<=18000,'ChromaQR should scan soon');
 assert.ok(first.iris>=7000&&first.iris<=22000,'IRIS should scan soon');
 assert.ok(regular>=heavy*4,'Common formats remain the priority');
});

test('A skipped monochrome color pass retries without heavy worker decoding',()=>{
 const scheduler=createAutoScanScheduler(0);
 const tasks=[];
 let now=0;
 for(let i=0;i<100;i++){
  const kind=scheduler.next(now);
  if(kind==='chroma')tasks.push(now);
  const cost=kind==='standard'?100:kind==='chroma'?5:600;
  now+=cost+620;
  scheduler.report(kind,now,cost,kind==='chroma');
 }
 assert.ok(tasks.length>=3,'Skipped color checks must reschedule promptly');
 assert.ok(tasks[1]-tasks[0]<20000,'Skipped ChromaQR is not delayed for 30 seconds');
});

test('Color pre-check distinguishes monochrome from a colored code',()=>{
 const rgba=new Uint8ClampedArray(100*100*4);
 for(let i=0;i<rgba.length;i+=4){rgba[i]=rgba[i+1]=rgba[i+2]=220;rgba[i+3]=255}
 assert.equal(hasColorSignal({data:rgba}),false);
 for(let i=0;i<rgba.length;i+=80){rgba[i]=235;rgba[i+1]=45;rgba[i+2]=80}
 assert.equal(hasColorSignal({data:rgba}),true);
 assert.equal(hasColorSignal(null),false);
});

test('Auto shortens color scan intervals without changing the standard format cycle',()=>{
 const scheduler=createAutoScanScheduler(0);
 let now=0,quick=0;
 const color={chroma:[],iris:[]};
 const other={dotcode:0,pdf417:0};
 for(let i=0;i<250;i++){
  const kind=scheduler.next(now);
  if(kind==='standard')quick++;
  if(kind==='chroma'||kind==='iris')color[kind].push(now);
  if(kind==='dotcode'||kind==='pdf417')other[kind]++;
  const decodeMs=kind==='standard'?115:kind==='chroma'?800:kind==='iris'?750:550;
  now+=decodeMs+(kind==='standard'?580:900);
  scheduler.report(kind,now,decodeMs);
 }
 assert.ok(quick>=200,'Auto must keep standard passes dominant');
 assert.ok(other.dotcode>0&&other.pdf417>0,'Other specialized formats must stay scheduled');
 for(const [kind,initial,period] of [['chroma',5000,15000],['iris',7000,18000]]){
  const times=color[kind];
  assert.ok(times.length>=2,kind+' must be retried');
  assert.ok(times[0]>=initial,kind+' must respect its first deadline');
  for(let i=1;i<times.length;i++)
   assert.ok(times[i]-times[i-1]>=period,kind+' must respect minimum spacing');
 }
});

test('Long color decodes still enter protective cooldowns',()=>{
 const scheduler=createAutoScanScheduler(0);
 let now=0,first=null,second=null;
 for(let i=0;i<250;i++){
  const kind=scheduler.next(now);
  if(kind==='iris'){
   if(first!==null){second=now;break}
   first=now;
   scheduler.report(kind,now+2700,2700);
   now+=2700+900;
  }else now+=kind==='standard'?700:1350;
 }
 assert.ok(first!==null&&second!==null,'IRIS must resume after the long decode');
 assert.ok(second-first>=35000,'Slow IRIS must not overload the phone');
});

test('ChromaQR and IRIS first attempts land near five and seven seconds',()=>{
 const scheduler=createAutoScanScheduler(0);
 const first={};
 for(let now=0;now<=20000&&(first.chroma===undefined||first.iris===undefined);now+=100){
  const kind=scheduler.next(now);
  if(kind!=='standard'&&!(kind in first)){
   first[kind]=now;
   scheduler.report(kind,now+300,300);
  }
 }
 assert.ok(first.chroma>=5000&&first.chroma<=5600,'ChromaQR first attempt around 5s, got '+first.chroma);
 assert.ok(first.iris>=7000&&first.iris<=7600,'IRIS first attempt around 7s, got '+first.iris);
});

test('Earliest due specialized format wins when several are due',()=>{
 const scheduler=createAutoScanScheduler(0);
 const order=[];
 let now=30000; // every format is past its first deadline by now
 for(let round=0;round<4;round++){
  for(let i=0;i<4;i++){assert.equal(scheduler.next(now),'standard');now+=100}
  order.push(scheduler.next(now));now+=100;
 }
 assert.deepEqual(order,['dotcode','chroma','iris','pdf417'],
  'Due formats must run in deadline order, not in a fixed or noisy order');
});

test('Every specialized scan is followed by at least four quick reads',()=>{
 const scheduler=createAutoScanScheduler(0);
 let now=50000; // dotcode, chroma, iris and pdf417 are all already due
 for(let i=0;i<4;i++){assert.equal(scheduler.next(now),'standard');now+=100}
 assert.equal(scheduler.next(now),'dotcode');now+=100;
 // ChromaQR, IRIS and PDF417 remain due, but the quick-read counter restarted.
 for(let i=0;i<4;i++){assert.equal(scheduler.next(now),'standard');now+=100}
 assert.equal(scheduler.next(now),'chroma');
});

test('Cooldowns apply only past their decode-time thresholds',()=>{
 const cases=[
  ['chroma',1800,30000],
  ['iris',1600,35000],
  ['pdf417',1000,22000],
  ['dotcode',1500,11000]
 ];
 for(const [kind,threshold,cooldown] of cases){
  for(const [decodeMs,expectCooldown] of [[threshold,false],[threshold+1,true]]){
   const scheduler=createAutoScanScheduler(0);
   let now=0,firstFinish=null,second=null,guard=0;
   while(second===null&&guard++<5000){
    const k=scheduler.next(now);
    if(k===kind){
     if(firstFinish===null){
      firstFinish=now+decodeMs;
      scheduler.report(k,firstFinish,decodeMs);
      now=firstFinish+120;
     }else second=now;
    }else{
     if(k!=='standard')scheduler.report(k,now+400,400);
     now+=k==='standard'?150:550;
    }
   }
   assert.ok(second!==null,kind+' must run twice');
   const gap=second-firstFinish;
   if(expectCooldown)
    assert.ok(gap>=cooldown,kind+' past '+threshold+'ms must cool down '+cooldown+'ms, got '+gap);
   else
    assert.ok(gap<cooldown,kind+' at exactly '+threshold+'ms must avoid the cooldown, got '+gap);
  }
 }
});

test('Skipped color passes reschedule within their short retry windows',()=>{
 for(const [kind,window,normalInterval] of [['chroma',6500,15000],['iris',8500,18000]]){
  const scheduler=createAutoScanScheduler(0);
  let now=0,first=null,firstFinish=null,second=null,guard=0;
  while(second===null&&guard++<2000){
   const k=scheduler.next(now);
   if(k===kind){
    if(first===null){
     first=now;firstFinish=now+50;
     scheduler.report(k,firstFinish,50,true); // monochrome scene: skipped
    }else second=now;
   }else if(k!=='standard')scheduler.report(k,now+50,50);
   now+=100;
  }
  assert.ok(first!==null&&second!==null,kind+' must be retried after a skip');
  assert.ok(second>=firstFinish+window-1,
   kind+' retry must not beat its rescheduled slot, got '+(second-firstFinish));
  // The retry deadline is set within the window; execution can slip by one
  // quick-read cycle when another due format resets the counter nearby.
  assert.ok(second<=firstFinish+window+1000,
   kind+' retry must land near the ~'+window+'ms slot, got '+(second-firstFinish));
  assert.ok(second-first<normalInterval,
   'Skipped '+kind+' must not wait the full '+normalInterval+'ms interval');
 }
});

test('A skipped color pass never earns a cooldown, however slow the report',()=>{
 const scheduler=createAutoScanScheduler(0);
 let now=0,first=null,second=null,guard=0;
 while(second===null&&guard++<5000){
  const kind=scheduler.next(now);
  if(kind==='chroma'){
   if(first===null){
    first=now;
    // Skipped means the decoder never ran: a huge reported cost is irrelevant.
    scheduler.report(kind,now+80,99999,true);
    now+=200;
   }else second=now;
  }else{
   if(kind!=='standard')scheduler.report(kind,now+300,300);
   now+=kind==='standard'?150:450;
  }
 }
 assert.ok(second!==null,'ChromaQR must be retried after a skip');
 assert.ok(second-first<30000,'A skipped pass must not trigger the 30s slow-decode cooldown');
});

test('Repeated skips keep retrying without bunching up before the rescheduled slot',()=>{
 const scheduler=createAutoScanScheduler(0);
 const runs=[];
 let now=0,guard=0;
 while(runs.length<4&&guard++<1000){
  const kind=scheduler.next(now);
  if(kind==='chroma'){
   runs.push(now);
   scheduler.report(kind,now+50,50,true);
  }else if(kind!=='standard')scheduler.report(kind,now+50,50);
  now+=100;
 }
 assert.ok(runs.length>=4,'Skipped ChromaQR must keep being rescheduled');
 for(let i=1;i<runs.length;i++){
  const gap=runs[i]-runs[i-1];
  assert.ok(gap>=6500,'Retry must not run earlier than its rescheduled deadline, gap '+gap);
  assert.ok(gap<=7000,'Retry must stay close to the 6.5s window, gap '+gap);
 }
});

test('Standard scans stay in the majority under skips and slow decodes',()=>{
 const scheduler=createAutoScanScheduler(0);
 const counts={standard:0,dotcode:0,pdf417:0,chroma:0,iris:0};
 let now=0;
 for(let i=0;i<400;i++){
  const kind=scheduler.next(now);
  counts[kind]++;
  if(kind==='standard'){now+=260;scheduler.report(kind,now,120)}
  else if(kind==='chroma'){const skip=i%2===0;now+=skip?60:2100;scheduler.report(kind,now,skip?60:2100,skip)}
  else if(kind==='iris'){now+=900;scheduler.report(kind,now,900)}
  else if(kind==='dotcode'){now+=1900;scheduler.report(kind,now,1900)} // slow DotCode
  else{now+=700;scheduler.report(kind,now,700)}
 }
 const specialized=counts.dotcode+counts.pdf417+counts.chroma+counts.iris;
 assert.ok(specialized>0,'specialized formats must run');
 assert.ok(counts.standard>=4*specialized,
  'every specialized pass requires four quick reads: '+JSON.stringify(counts));
 for(const kind of ['dotcode','pdf417','chroma','iris'])
  assert.ok(counts[kind]>=2,kind+' must keep being attempted');
});

test('Color pre-check handles empty, malformed and grayscale frames',()=>{
 assert.equal(hasColorSignal(),false);
 assert.equal(hasColorSignal(undefined),false);
 assert.equal(hasColorSignal(null),false);
 assert.equal(hasColorSignal({}),false);
 assert.equal(hasColorSignal({data:[]}),false);
 assert.equal(hasColorSignal({data:new Uint8ClampedArray(0)}),false);
 assert.equal(hasColorSignal({data:new Uint8ClampedArray(6)}),false,'non RGBA-aligned length');
 for(const gray of [0,80,160,255]){
  const rgba=new Uint8ClampedArray(40*40*4);
  for(let i=0;i<rgba.length;i+=4){rgba[i]=rgba[i+1]=rgba[i+2]=gray;rgba[i+3]=255}
  assert.equal(hasColorSignal({data:rgba}),false,'gray level '+gray+' has no color signal');
 }
});

test('Color pre-check keeps small colored codes and respects its thresholds',()=>{
 // A handful of strongly saturated pixels inside a gray frame is enough.
 const rgba=new Uint8ClampedArray(40*40*4);
 for(let i=0;i<rgba.length;i+=4){rgba[i]=rgba[i+1]=rgba[i+2]=200;rgba[i+3]=255}
 for(let p=0;p<8;p++){const i=p*4*50;rgba[i]=240;rgba[i+1]=30;rgba[i+2]=60}
 assert.equal(hasColorSignal({data:rgba}),true,'a few saturated pixels must keep the pass');
 const solid=(r,g,b,pixels)=>{
  const frame=new Uint8ClampedArray(pixels*4);
  for(let i=0;i<frame.length;i+=4){frame[i]=r;frame[i+1]=g;frame[i+2]=b;frame[i+3]=255}
  return {data:frame};
 };
 // Boundary: brightness 85 and saturation span 40 both count as colored.
 assert.equal(hasColorSignal(solid(85,45,45,64)),true,'boundary pixel counts as color');
 assert.equal(hasColorSignal(solid(84,44,44,64)),false,'too dark to trust as color');
 assert.equal(hasColorSignal(solid(200,162,162,64)),false,'too desaturated to trust as color');
});

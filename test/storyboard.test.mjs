import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {buildFfmpegTools,resolveConfig} from '../lib/index.js'

function fixture(t,{probe,exitAt,emptyAt,abortAt,exitSeeks=[],emptySeeks=[],failAllSamples=false}={}){
 const root=mkdtempSync(join(tmpdir(),'storyboard-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const input=join(root,'source.mp4');writeFileSync(input,'original-video')
 const controller=new AbortController(),calls=[],scratch=[]
 const runner={async run(argv,options){
  calls.push({argv,options});const n=calls.length
  if(n===1)return{exitCode:0,signal:null,stderr:'',stdout:JSON.stringify(probe||{format:{duration:'12'},streams:[{codec_type:'video',codec_name:'h264',width:640,height:360,avg_frame_rate:'2/1',duration:'12'}]})}
  const file=argv.at(-1);scratch.push(dirname(file))
  // 真实采样命令带 -ss 且输入是源视频；占位图（lavfi color）与拼格不算采样
  const seekIndex=argv.indexOf('-ss')
  const isSample=seekIndex>=0&&argv.includes(input)
  const seek=isSample?Number(argv[seekIndex+1]):null
  const shouldFail=isSample&&(failAllSamples||exitSeeks.includes(seek))
  const shouldBeEmpty=isSample?emptySeeks.includes(seek):n===emptyAt
  if(!shouldBeEmpty)writeFileSync(file,shouldFail?'failed-'+n:'completed-'+n)
  if(n===abortAt)controller.abort(new Error('user-cancelled'))
  return{exitCode:n===exitAt||shouldFail?1:0,signal:null,stderr:n===exitAt||shouldFail?'decode-failed':'',stdout:''}
 }}
 const tool=buildFfmpegTools(resolveConfig({timeoutMs:10000}),runner).find(x=>x.name==='ffmpeg_storyboard')
 return{root,input,controller,calls,scratch,tool,exec:{signal:controller.signal,agent:{session:{header:{cwd:root}}}}}
}

/** 取真实采样调用（-ss 指向源视频），按顺序返回其目标秒数。 */
function sampleSeeks(f){
 return f.calls.filter(c=>c.argv.indexOf('-ss')>=0&&c.argv.includes(f.input)).map(c=>Number(c.argv[c.argv.indexOf('-ss')+1]))
}
/** 黑场占位图调用。 */
function placeholderCalls(f){
 return f.calls.filter(c=>c.argv.includes('lavfi')&&c.argv.some(a=>a.startsWith('color=c=black')))
}
/** 拼格调用。 */
function tileCalls(f){
 return f.calls.filter(c=>c.argv.some(a=>a.startsWith('tile=')))
}

test('storyboard produces one complete grid and keeps target-time cells in reading order',async t=>{
 const f=fixture(t),value=await f.tool.execute({input:'source.mp4',count:4,columns:2,width:160,start:2,end:10},f.exec)
 assert.deepEqual(value.frames.map(x=>[x.row,x.column,x.seconds]),[[1,1,2],[1,2,4],[2,1,6],[2,2,8]])
 assert.deepEqual(value.frames.map(x=>x.ok),[true,true,true,true])
 assert.equal(value.width,344);assert.equal(value.height,204);assert.equal(value.timestampKind,'requested-seek-time')
 assert.equal(readFileSync(value.output,'utf8'),'completed-'+f.calls.length);assert.equal(readFileSync(f.input,'utf8'),'original-video')
 assert.ok(f.calls.every(c=>c.options.signal===f.controller.signal&&c.options.timeoutMs>0&&c.options.timeoutMs<=10000))
 assert.ok(f.scratch.every(p=>!existsSync(p)));assert.match(f.tool.output.render({},value)[0].text,/#4（2 行 2 列）：8 秒/)
})

test('storyboard preserves existing outputs and source aliases',async t=>{
 const f=fixture(t),old=join(f.root,'source-storyboard.png');writeFileSync(old,'old-sheet')
 const value=await f.tool.execute({input:f.input,count:2},f.exec)
 assert.equal(readFileSync(old,'utf8'),'old-sheet');assert.match(value.output,/_1\.png$/)
 await assert.rejects(f.tool.execute({input:f.input,output:f.input},f.exec),/输入文件相同|同一文件/)
 assert.equal(readFileSync(f.input,'utf8'),'original-video')
})

test('cancelled sampling removes scratch and never publishes a partial sheet',async t=>{
 const f=fixture(t,{abortAt:3}),output=join(f.root,'cancelled.png')
 await assert.rejects(f.tool.execute({input:f.input,output,count:4},f.exec),/user-cancelled/)
 assert.ok(!existsSync(output));assert.ok(f.scratch.every(p=>!existsSync(p)));assert.equal(f.calls.length,3)
})

test('storyboard refuses invalid sizes, audio-only media, unknown duration and invalid ranges',async t=>{
 const f=fixture(t)
 for(const args of [{count:1},{count:37},{columns:7},{width:159},{width:640.5}])await assert.rejects(f.tool.execute({input:f.input,...args},f.exec),/必须是/)
 assert.equal(f.calls.length,0)
 for(const [probe,args,pattern]of [
  [{format:{duration:'12'},streams:[{codec_type:'audio'}]},{},/没有视频画面/],
  [{format:{},streams:[{codec_type:'video',width:20,height:20}]},{},/无法确定视频时长/],
  [undefined,{start:11,end:10},/采样范围/],
  [undefined,{end:13},/采样范围/],
  [undefined,{start:11.9},/太靠近结尾/],
 ]){const sample=fixture(t,{probe});await assert.rejects(sample.tool.execute({input:sample.input,...args},sample.exec),pattern)}
})

test('fractional-frame-rate short clips never round a seek past their last frame',async t=>{
 const f=fixture(t,{probe:{format:{duration:'0.1001'},streams:[{codec_type:'video',width:160,height:90,avg_frame_rate:'30000/1001',duration:'0.1001'}]}})
 const value=await f.tool.execute({input:f.input,count:12},f.exec),last=2*1001/30000
 assert.ok(value.frames.every(frame=>frame.seconds<=last))
 const seeks=sampleSeeks(f)
 assert.equal(seeks.length,12);assert.ok(seeks.every(time=>time<=last));assert.equal(seeks.at(-1),0.066733)
 assert.ok(value.frames.every(frame=>frame.ok===true))
})

test('a failed cell falls back to earlier in-range times, keeps requested seconds and marks ok=true',async t=>{
 const f=fixture(t,{exitSeeks:[6]}),output=join(f.root,'fallback.png')
 const value=await f.tool.execute({input:f.input,output,count:4,start:2,end:10},f.exec)
 // 返回的 seconds 仍是请求的采样时间，不改成实际回退时间
 assert.deepEqual(value.frames.map(x=>x.seconds),[2,4,6,8])
 assert.deepEqual(value.frames.map(x=>x.ok),[true,true,true,true])
 const seeks=sampleSeeks(f)
 // 第 3 格目标 6 秒失败后，按 0.25 格距（0.5 秒）回退一次即成功：6 → 5.5
 assert.deepEqual(seeks,[2,4,6,5.5,8])
 assert.ok(seeks.every(time=>time>=2&&time<10),'每次尝试都必须落在 start–end 范围内且不早于 start')
 assert.equal(placeholderCalls(f).length,0)
 assert.equal(tileCalls(f).length,1)
 assert.ok(existsSync(output));assert.equal(readFileSync(output,'utf8'),'completed-'+f.calls.length)
 assert.ok(f.scratch.every(p=>!existsSync(p)))
})

test('a cell whose fallbacks all fail gets a black placeholder, ok=false while other cells still sample',async t=>{
 const f=fixture(t,{exitSeeks:[6,5.5,5,4.5]}),output=join(f.root,'placeholder.png')
 const value=await f.tool.execute({input:f.input,output,count:4,columns:2,width:160,start:2,end:10},f.exec)
 assert.deepEqual(value.frames.map(x=>x.seconds),[2,4,6,8])
 assert.deepEqual(value.frames.map(x=>x.ok),[true,true,false,true])
 assert.deepEqual(sampleSeeks(f),[2,4,6,5.5,5,4.5,8])
 assert.ok(sampleSeeks(f).every(time=>time>=2&&time<10))
 const placeholders=placeholderCalls(f)
 assert.equal(placeholders.length,1)
 assert.equal(placeholders[0].argv[placeholders[0].argv.indexOf('-i')+1],'color=c=black:s=160x90')
 assert.equal(tileCalls(f).length,1)
 // 总览图照常发布一次，命名仍是请求的输出路径
 assert.ok(existsSync(output));assert.equal(readFileSync(output,'utf8'),'completed-'+f.calls.length)
 assert.match(f.tool.output.render({},value)[0].text,/#3（2 行 1 列）：6 秒（占位）/)
 assert.ok(f.scratch.every(p=>!existsSync(p)))
})

test('every cell failing all attempts rejects the run, publishes nothing and keeps scratch private',async t=>{
 const f=fixture(t,{failAllSamples:true}),output=join(f.root,'all-failed.png')
 await assert.rejects(f.tool.execute({input:f.input,output,count:4,start:2,end:10},f.exec),/所有采样点都无法取得真实画面/)
 assert.ok(!existsSync(output))
 // 后三格各 4 个候选（目标 + 3 次回退），首格目标即 start、回退被夹回 start 后去重为 1 个：共 13 次采样 + 4 张占位图；不拼格不发布
 assert.equal(sampleSeeks(f).length,13)
 assert.equal(placeholderCalls(f).length,4)
 assert.equal(tileCalls(f).length,0)
 assert.ok(sampleSeeks(f).every(time=>time>=2&&time<10))
 assert.ok(f.scratch.every(p=>!existsSync(p)))
 assert.equal(readFileSync(f.input,'utf8'),'original-video')
})

test('fallback attempts never seek before start and never repeat the same time',async t=>{
 const f=fixture(t,{exitSeeks:[4,3.5,3]}),output=join(f.root,'first-cell.png')
 const value=await f.tool.execute({input:f.input,output,count:4,columns:2,width:160,start:2,end:10},f.exec)
 // 第 2 格目标 4 秒连续失败后回退 3.5/3/2.5，2.5 成功；全部候选都不早于 start=2
 assert.deepEqual(sampleSeeks(f),[2,4,3.5,3,2.5,6,8])
 assert.ok(sampleSeeks(f).every(time=>time>=2&&time<10))
 assert.deepEqual(new Set(sampleSeeks(f)).size,sampleSeeks(f).length,'候选时间去重，不重复尝试同一秒')
 assert.deepEqual(value.frames.map(x=>x.ok),[true,true,true,true])
 assert.equal(placeholderCalls(f).length,0)
 assert.ok(existsSync(output))
})

test('a cell pinned at start gets only one attempt, then a placeholder, instead of seeking before start',async t=>{
 const f=fixture(t,{exitSeeks:[2]}),output=join(f.root,'pinned-start.png')
 const value=await f.tool.execute({input:f.input,output,count:4,columns:2,width:160,start:2,end:10},f.exec)
 // 首格目标即 start=2：回退点全部被夹到 start，去重后只尝试一次，失败即占位
 assert.deepEqual(sampleSeeks(f),[2,4,6,8])
 assert.deepEqual(value.frames.map(x=>x.ok),[false,true,true,true])
 assert.equal(placeholderCalls(f).length,1)
 assert.ok(existsSync(output));assert.ok(f.scratch.every(p=>!existsSync(p)))
})

test('empty ffmpeg output is treated as a failed sample and also falls back',async t=>{
 const f=fixture(t,{emptySeeks:[4]}),output=join(f.root,'empty.png')
 const value=await f.tool.execute({input:f.input,output,count:4,start:2,end:10},f.exec)
 assert.deepEqual(sampleSeeks(f),[2,4,3.5,6,8])
 assert.deepEqual(value.frames.map(x=>x.ok),[true,true,true,true])
 assert.equal(placeholderCalls(f).length,0)
 assert.ok(existsSync(output))
})

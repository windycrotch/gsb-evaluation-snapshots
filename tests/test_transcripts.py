import tempfile
import threading
import time
import unittest
from pathlib import Path
from fastapi import FastAPI, HTTPException
import transcripts

class Transcripts(unittest.TestCase):
    def test_phrase_search_crosses_cues_and_preserves_source_times(self):
        words=[{'start':i,'end':i+.8,'text':text} for i,text in enumerate(['hello','GTA','six','नमस्ते','दुनिया'])]
        result=transcripts.search(words,'gta SIX')
        self.assertEqual(len(result),1);self.assertEqual(result[0]['match_start'],1);self.assertEqual(result[0]['match_end'],2.8)
        self.assertEqual(len(transcripts.search(words,'नमस्ते दुनिया')),1)
        self.assertEqual(transcripts.search(words,'absent'),[])
        self.assertEqual(transcripts.search(words,'',1,1),[])
        many=[dict(start=i,end=i+.8,text='word') for i in range(120)]
        self.assertEqual(transcripts.search(many,'',2,2)[0]['start'],40)
        self.assertEqual(transcripts.search(many,'word',2,2)[0]['match_start'],2)

    def test_import_cache_search_and_no_asr(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);(data/'source.mp4').touch();app=FastAPI();state={}
            def forbidden(*args):raise AssertionError('Must not transcribe imported transcript')
            transcripts.attach(app,data,state,lambda p:{'duration':100},forbidden)
            routes={r.path:r.endpoint for r in app.routes}
            source={'id':'source','text':'1\n00:00:10,000 --> 00:00:12,000\nHello world\n'}
            imported=routes['/transcripts/import'](source)
            cached=routes['/transcripts/load']({'id':'source'})
            self.assertTrue(cached['cached']);self.assertEqual(cached['transcript'],imported)
            self.assertEqual(routes['/transcripts/search']({'key':imported['key'],'query':'hello world'})['matches'][0]['start'],10)
            self.assertEqual(list(data.glob('*.json')),[])
            # Replacing source content invalidates the old cache identity.
            (data/'source.mp4').write_bytes(b'new source')
            self.assertTrue(routes['/transcripts/load']({'id':'source'})['missing'])

    def attach_routes(self,data,state,transcribe,duration=100):
        (data/'source.mp4').write_bytes(b'source v1');app=FastAPI()
        transcripts.attach(app,data,state,lambda p:{'duration':duration},transcribe)
        return {r.path:r.endpoint for r in app.routes}

    def wait_job(self,state,job):
        for _ in range(100):
            if state[job]['status']!='running':return state[job]
            time.sleep(.05)
        self.fail('Transcript job did not finish')

    def test_import_origins_are_distinct_and_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={}
            routes=self.attach_routes(data,state,lambda *args:None)
            timed=routes['/transcripts/import']({'id':'source','words':[{'start':0,'end':1,'text':'exact'}]})
            self.assertEqual(timed['origin'],'Imported word-timed transcript')
            self.assertEqual(routes['/transcripts/load']({'id':'source'})['transcript']['origin'],timed['origin'])
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={}
            routes=self.attach_routes(data,state,lambda *args:None)
            estimated=routes['/transcripts/import']({'id':'source','text':'1\n00:00:01,000 --> 00:00:03,000\nHello there\n'})
            self.assertEqual(estimated['origin'],'Imported subtitles (estimated within-cue word timings)')
            self.assertEqual(routes['/transcripts/load']({'id':'source'})['transcript']['origin'],estimated['origin'])

    def test_concurrent_generate_shares_one_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={};calls=[];hold=threading.Event()
            def transcribe(*args):
                calls.append(1);hold.wait(5);return {'words':[{'start':0,'end':1,'text':'hi'}]}
            routes=self.attach_routes(data,state,transcribe)
            first={};thread=threading.Thread(target=lambda:first.update(routes['/transcripts/load']({'id':'source','generate':True})))
            thread.start();time.sleep(.2)
            second=routes['/transcripts/load']({'id':'source','generate':True})
            hold.set();thread.join()
            self.assertEqual(first['job'],second['job']);self.assertEqual(len(calls),1)
            self.assertEqual(self.wait_job(state,first['job'])['status'],'done')

    def test_failed_job_leaves_no_cache_and_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={};calls=[]
            def transcribe(*args):
                calls.append(1)
                if len(calls)==1:raise RuntimeError('boom')
                return {'words':[{'start':0,'end':1,'text':'hi'}]}
            routes=self.attach_routes(data,state,transcribe)
            failed=routes['/transcripts/load']({'id':'source','generate':True})['job']
            self.assertEqual(self.wait_job(state,failed)['status'],'error')
            self.assertEqual(list((data/'transcripts').glob('*.json')),[])
            self.assertTrue(routes['/transcripts/load']({'id':'source'})['missing'])
            retry=routes['/transcripts/load']({'id':'source','generate':True})['job']
            self.assertNotEqual(retry,failed)
            self.assertEqual(self.wait_job(state,retry)['status'],'done')
            self.assertTrue(routes['/transcripts/load']({'id':'source'})['cached'])

    def test_source_replaced_during_generation_is_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={};started=threading.Event();proceed=threading.Event()
            def transcribe(*args):
                started.set();proceed.wait(5);return {'words':[{'start':0,'end':1,'text':'stale'}]}
            routes=self.attach_routes(data,state,transcribe)
            job=routes['/transcripts/load']({'id':'source','generate':True})['job']
            self.assertTrue(started.wait(5))
            (data/'source.mp4').write_bytes(b'source v2 replaced')
            proceed.set()
            self.assertEqual(self.wait_job(state,job)['status'],'error')
            self.assertEqual(list((data/'transcripts').glob('*.json')),[])
            self.assertIsNone(transcripts.cached_source(data,data/'source.mp4'))
            self.assertTrue(routes['/transcripts/load']({'id':'source'})['missing'])
            # The new source can be transcribed fresh and is then reused.
            retry=routes['/transcripts/load']({'id':'source','generate':True})['job']
            self.assertEqual(self.wait_job(state,retry)['status'],'done')
            self.assertEqual(transcripts.cached_source(data,data/'source.mp4'),[{'start':0,'end':1,'text':'stale'}])

    def test_make_branch_uses_only_matching_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={}
            routes=self.attach_routes(data,state,lambda *args:{'words':[{'start':0,'end':1,'text':'hi'}]})
            job=routes['/transcripts/load']({'id':'source','generate':True})['job']
            self.assertEqual(self.wait_job(state,job)['status'],'done')
            self.assertEqual(transcripts.cached_source(data,data/'source.mp4'),[{'start':0,'end':1,'text':'hi'}])
            self.assertIsNone(transcripts.cached_source(data,data/'source.mp4','en'))
            (data/'source.mp4').write_bytes(b'source v2 replaced')
            self.assertIsNone(transcripts.cached_source(data,data/'source.mp4'))

    def test_search_pagination_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp);state={}
            routes=self.attach_routes(data,state,lambda *args:None,duration=100000)
            words=[{'start':i,'end':i+.5,'text':'w%d'%i} for i in range(2500)]
            key=routes['/transcripts/import']({'id':'source','words':words})['key']
            page0=routes['/transcripts/search']({'key':key})
            page1=routes['/transcripts/search']({'key':key,'offset':100})
            self.assertEqual(len(page0['matches']),100);self.assertTrue(page0['has_more'])
            self.assertEqual(len(page1['matches']),25);self.assertFalse(page1['has_more'])
            self.assertEqual(page0['matches'][-1]['last']+1,page1['matches'][0]['first'])
            for bad in (-1,200001,'next'):
                with self.assertRaises(HTTPException):routes['/transcripts/search']({'key':key,'offset':bad})
            self.assertEqual(routes['/transcripts/search']({'key':key,'offset':200000})['matches'],[])

if __name__=='__main__':unittest.main()

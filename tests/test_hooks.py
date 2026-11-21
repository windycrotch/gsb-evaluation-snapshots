from pathlib import Path
import tempfile
import unittest
import captions,hooks
class HookHeadings(unittest.TestCase):
    def test_heading_lasts_eight_seconds_and_has_separate_black_backing(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);captions.write([],'gta',p,'hook','THE PLAN WENT WRONG',width=1080,height=1920)
            text=(p/'hook.ass').read_text(encoding='utf-8')
            self.assertIn('Dialogue: 2,0:00:00.00,0:00:08.00',text)
            self.assertIn('Dialogue: 3,0:00:00.00,0:00:08.00',text)
            self.assertIn('\\1c&H000000&',text)
    def test_duration_and_background_are_explicit(self):
        self.assertEqual(hooks.settings({'hook_duration':12,'hook_background':False}),(12,False))
        events=hooks.events(['HELLO'],720,1280,200,.667,{'hook_background':False,'hook_duration':12})
        self.assertEqual(len(events),1);self.assertIn('0:00:12.00',events[0])
        for duration in (0,1,61,float('nan')):
            with self.assertRaises(ValueError):hooks.settings({'hook_duration':duration})
if __name__=='__main__':unittest.main()

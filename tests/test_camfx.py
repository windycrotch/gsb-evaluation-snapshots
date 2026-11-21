import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import camfx, hooks, layouts


class CamFxTests(unittest.TestCase):
    def test_defaults_change_nothing(self):
        self.assertEqual(camfx.filter({}), '')
        self.assertEqual(camfx.filter({'cam_contrast': 1, 'cam_brightness': 0, 'cam_saturation': 1, 'cam_clarity': 0}), '')

    def test_filter_text(self):
        f = camfx.filter({'cam_contrast': 1.3, 'cam_clarity': 0.8})
        self.assertTrue(f.startswith(','))
        self.assertIn('eq=contrast=1.300', f)
        self.assertIn('unsharp=5:5:0.80', f)

    def test_validation(self):
        for body in ({'cam_contrast': 5}, {'cam_brightness': -1}, {'cam_clarity': 'x'}, {'cam_saturation': float('nan')}):
            with self.assertRaises(ValueError):
                camfx.settings(body)
        with self.assertRaises(ValueError):
            hooks.settings({'cam_contrast': 9})
        self.assertIn('cam_contrast', hooks.KEYS)

    def test_only_the_facecam_layer_is_touched(self):
        rects = [(0, 0, 400, 300), (400, 0, 880, 720)]
        plain = layouts.render_graph('stack', rects, .32, 1080, 1920)
        fx = layouts.render_graph('stack', rects, .32, 1080, 1920, camfx.filter({'cam_contrast': 1.3}))
        self.assertNotIn('eq=', plain)
        self.assertEqual(fx.count('eq=contrast'), 1)


if __name__ == '__main__':
    unittest.main()


class LivenessTests(unittest.TestCase):
    def test_static_picture_is_not_a_webcam(self):
        import facecam_detect as fd
        self.assertFalse(fd.is_live(0.0))
        self.assertFalse(fd.is_live(0.2))
        self.assertTrue(fd.is_live(1.5))


class JsRuntimeTests(unittest.TestCase):
    def test_node_and_deno_are_allowed_when_installed(self):
        import ytdl
        from unittest import mock
        with mock.patch('shutil.which', lambda n: '/x/' + n if n == 'node' else None):
            self.assertEqual(ytdl.js_runtimes(), {'node': {}})
            opts = [o for o, d in ytdl.variants({'quiet': True})]
            self.assertTrue(all(o.get('js_runtimes') == {'node': {}} for o in opts))
        with mock.patch('shutil.which', lambda n: None):
            self.assertEqual(ytdl.js_runtimes(), {})
            self.assertTrue(all('js_runtimes' not in o for o, d in ytdl.variants({'quiet': True})))

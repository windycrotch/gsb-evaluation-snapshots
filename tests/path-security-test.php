<?php
/**
 * Path confinement checks for the file operation endpoints of music.php.
 *
 * The script builds a throw-away installation in the system temp directory:
 *
 *   <tmp>/app       copy of music.php + its ini files
 *   <tmp>/app/library         the configured song root
 *   <tmp>/app/music.pls       the configured playlist directory
 *   <tmp>/outside   files that must never be reachable
 *
 * It then starts PHP's built-in web server on that copy and requests both
 * legitimate and malicious URLs. A correct server accepts the former, rejects
 * the latter with a clear error, never leaks an absolute path and leaves the
 * library, playlist directory and the "outside" directory untouched. A second
 * copy configured with an absolute `root` covers that deployment shape.
 *
 * Usage:
 *   php tests/path-security-test.php
 *
 * Archives (folder and playlist downloads) shell out to `7z` on Windows and
 * `zip` elsewhere, exactly like music.php. When neither is found those four
 * archive checks are reported as SKIP; everything else always runs.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

$repo = dirname(__DIR__);
$failures = 0;
$skipped = 0;
$passes = 0;

function say($line) {
	echo $line . PHP_EOL;
}

function ok($name) {
	global $passes;
	$passes++;
	say('  PASS  '. $name);
}

function fail($name, $detail) {
	global $failures;
	$failures++;
	say('  FAIL  '. $name . ($detail !== '' ? ' -- '. $detail : ''));
}

function skip($name, $why) {
	global $skipped;
	$skipped++;
	say('  SKIP  '. $name .' ('. $why .')');
}

function check($name, $condition, $detail = '') {
	if ($condition) ok($name);
	else fail($name, $detail);
}

function rmtree($path) {
	if (!file_exists($path) && !is_link($path))
		return;
	if (is_dir($path) && !is_link($path)) {
		foreach (scandir($path) as $f) {
			if ($f === '.' || $f === '..')
				continue;
			rmtree($path .'/'. $f);
		}
		@rmdir($path);
	} else
		@unlink($path);
}

function find_archiver() {
	$win = DIRECTORY_SEPARATOR == '\\';
	$names = $win ? ['7z.exe', '7za.exe', '7zr.exe'] : ['zip'];
	$dirs = explode(PATH_SEPARATOR, getenv('PATH'));
	if ($win)
		$dirs[] = 'C:\\Program Files\\7-Zip';
	foreach ($names as $name) {
		foreach ($dirs as $dir) {
			if ($dir === '')
				continue;
			// 7zr cannot create zip archives; music.php needs zip support
			if ($name === '7zr.exe')
				continue;
			if (is_file($dir . DIRECTORY_SEPARATOR . $name))
				return $dir . DIRECTORY_SEPARATOR . $name;
		}
	}
	return false;
}

/** Snapshot (relative path => sha1) of a directory tree. */
function snapshot($dir) {
	$out = [];
	if (!is_dir($dir))
		return $out;
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
		RecursiveIteratorIterator::SELF_FIRST
	);
	foreach ($it as $file) {
		$rel = str_replace('\\', '/', substr($file->getPathname(), strlen($dir) + 1));
		$out[$rel] = $file->isDir() ? 'dir' : sha1_file($file->getPathname());
	}
	ksort($out);
	return $out;
}

function differences($before, $after) {
	$changed = [];
	foreach ($before as $path => $hash)
		if (!isset($after[$path]) || $after[$path] !== $hash)
			$changed[] = 'removed/changed: '. $path;
	foreach ($after as $path => $hash)
		if (!isset($before[$path]))
			$changed[] = 'added: '. $path;
	return $changed;
}

$lastStatus = 0;
$lastType = '';
function request($url, $method = 'GET', $body = null) {
	global $lastStatus, $lastType;
	$header = "Connection: close\r\n";
	$options = [
		'http' => [
			'method' => $method,
			'ignore_errors' => true,
			'timeout' => 20,
		],
	];
	if ($body !== null) {
		$header .= "Content-Type: application/json\r\n";
		$options['http']['content'] = $body;
	}
	$options['http']['header'] = $header;
	$http_response_header = [];
	$result = @file_get_contents($url, false, stream_context_create($options));
	$lastStatus = 0;
	$lastType = '';
	if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m))
		$lastStatus = (int) $m[1];
	foreach ($http_response_header as $h)
		if (stripos($h, 'Content-Type:') === 0)
			$lastType = trim(substr($h, 13));
	return $result === false ? '' : $result;
}

function expect_status($name, $expected, $method = 'GET', $body = null, $url = null) {
	global $base, $lastStatus;
	$body = request($url === null ? $base : $url, $method, $body);
	check($name, $lastStatus === $expected, 'expected HTTP '. $expected .', got '. $lastStatus);
	return $body;
}

function expect_rejected($name, $url, $forbidden, $absoluteHint) {
	global $base, $lastStatus;
	$body = request($base . $url);
	$okStatus = $lastStatus >= 400 && $lastStatus < 500;
	$noLeak = strpos($body, $absoluteHint) === false && !preg_match('#[A-Za-z]:[\\\\/]#', $body) && strpos($body, $forbidden) === false;
	check($name, $okStatus, 'expected 4xx, got HTTP '. $lastStatus .' body '. var_export(substr($body, 0, 120), true));
	check($name .' (no path leak)', $noLeak, 'response leaked data: '. var_export(substr($body, 0, 160), true));
}

// ---------------------------------------------------------------- test setup

$tmp = rtrim(sys_get_temp_dir(), '\\/') . DIRECTORY_SEPARATOR .'mfp_path_test_'. getmypid();
rmtree($tmp);
$app = $tmp . DIRECTORY_SEPARATOR .'app';
$outside = $tmp . DIRECTORY_SEPARATOR .'outside';
$library = $app . DIRECTORY_SEPARATOR .'library';
$pls = $app . DIRECTORY_SEPARATOR .'music.pls';
$songs = $library . DIRECTORY_SEPARATOR .'AlbumA';
$outsideFile = $outside . DIRECTORY_SEPARATOR .'secret.txt';
$marker = 'OUTSIDE-SECRET-MARKER-'. getmypid();

mkdir($songs, 0777, true);
mkdir($pls, 0777, true);
mkdir($outside, 0777, true);

foreach (['music.php', 'music.defaults.ini', 'music.lang.en.ini'] as $f) {
	if (!copy($repo . DIRECTORY_SEPARATOR . $f, $app . DIRECTORY_SEPARATOR . $f)) {
		say('Cannot copy '. $f .' to the test installation');
		rmtree($tmp);
		exit(2);
	}
}
mkdir($library . DIRECTORY_SEPARATOR .'AlbumB', 0777, true);
file_put_contents($songs . DIRECTORY_SEPARATOR .'track1.mp3', 'TRACK-ONE-BYTES');
file_put_contents($songs . DIRECTORY_SEPARATOR .'track2.mp3', 'TRACK-TWO-BYTES');
file_put_contents($library . DIRECTORY_SEPARATOR .'AlbumB' . DIRECTORY_SEPARATOR .'track3.mp3', 'TRACK-THREE-BYTES');
file_put_contents($outsideFile, $marker);
mkdir($outside . DIRECTORY_SEPARATOR .'evil', 0777, true);
file_put_contents($outside . DIRECTORY_SEPARATOR .'evil' . DIRECTORY_SEPARATOR .'evil.mp3', 'EVIL');

// Playlists are stored as JSON encoded twice, as music.js does
file_put_contents($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json',
	json_encode(json_encode([
		['path' => 'AlbumA/track1.mp3'],
		['path' => 'AlbumA/track2.mp3'],
	])));
file_put_contents($pls . DIRECTORY_SEPARATOR .'Prefixed.mfp.json',
	json_encode(json_encode([['path' => 'library/AlbumB/track3.mp3']])));
file_put_contents($pls . DIRECTORY_SEPARATOR .'Escape.mfp.json',
	json_encode(json_encode([['path' => '../outside/secret.txt']])));
file_put_contents($pls . DIRECTORY_SEPARATOR .'Absolute.mfp.json',
	json_encode(json_encode([['path' => 'C:/Windows/win.ini']])));

$archiver = find_archiver();
$hasArchiver = $archiver !== false;

// -------------------------------------------------------------- start server

$port = 0;
$proc = null;
$pipes = [];
$lastError = '';
$serverLog = $tmp . DIRECTORY_SEPARATOR .'server.log';
for ($attempt = 0; $attempt < 10 && $proc === null; $attempt++) {
	$candidate = 20000 + (getmypid() * 7 + $attempt * 13) % 20000;
	// Server output goes to a file: an unread pipe would fill up and block it
	$descriptors = [
		['pipe', 'r'],
		['file', $serverLog, 'a'],
		['file', $serverLog, 'a'],
	];
	$env = null;
	if ($hasArchiver) {
		// Pass a usable PATH for the zip helper; inherit the rest of the
		// environment so the server behaves like a normal CLI invocation.
		$env = [];
		foreach ($_SERVER as $k => $v)
			if (is_string($v))
				$env[$k] = $v;
		$env['PATH'] = dirname($archiver) . PATH_SEPARATOR . getenv('PATH');
	}
	$p = proc_open(
		escapeshellarg(PHP_BINARY) .' -S 127.0.0.1:'. $candidate .' -t '. escapeshellarg($app),
		$descriptors, $pipes, $app, $env);
	if (!is_resource($p))
		continue;
	// Wait for the server to accept connections
	$ready = false;
	for ($i = 0; $i < 100; $i++) {
		usleep(50000);
		$sock = @fsockopen('127.0.0.1', $candidate, $errno, $errstr, 0.2);
		if ($sock) {
			fclose($sock);
			$ready = true;
			break;
		}
		$status = proc_get_status($p);
		if (!$status['running'])
			break;
	}
	if ($ready) {
		$port = $candidate;
		$proc = $p;
	} else {
		$lastError = is_file($serverLog) ? trim(file_get_contents($serverLog)) : '';
		proc_terminate($p);
		proc_close($p);
		$pipes = [];
	}
}
if ($proc === null) {
	say('Could not start the PHP built-in server: '. $lastError);
	rmtree($tmp);
	exit(2);
}

$base = 'http://127.0.0.1:'. $port .'/music.php';
$absoluteHint = $tmp;

// Requests run through the built-in server, whose working directory is the
// test application directory; `php -S` changes directory per request.
say('Test installation: '. $tmp);
say('Server: '. $base);
say('Archiver: '. ($hasArchiver ? $archiver : 'not found (folder/playlist archives skipped)'));
say('');

// ------------------------------------------------------- legitimate requests

say('Legitimate requests');

$body = expect_status('library listing loads', 200);
check('library listing contains songs', strpos($body, 'track1.mp3') !== false, 'track1.mp3 missing from library');

$body = expect_status('download a song', 200, 'GET', null, $base .'?dl=library/AlbumA/track1.mp3');
check('song download returns the song', $body === 'TRACK-ONE-BYTES', 'unexpected body: '. var_export(substr($body, 0, 80), true));

$body = expect_status('download a song with . segments', 200, 'GET', null, $base .'?dl=library/./AlbumA/track1.mp3');
check('dot segments are normalized, not rejected', $body === 'TRACK-ONE-BYTES', 'unexpected body');

if ($hasArchiver) {
	$body = expect_status('download a folder', 200, 'GET', null, $base .'?dl=library/AlbumA');
	check('folder download is a zip', substr($body, 0, 2) === 'PK', 'not a zip ('. strlen($body) .' bytes)');
	$body = expect_status('download a playlist', 200, 'GET', null, $base .'?dlpl=Mix');
	check('playlist download is a zip', substr($body, 0, 2) === 'PK', 'not a zip ('. strlen($body) .' bytes)');
	$body = expect_status('download a playlist with root-prefixed entries', 200, 'GET', null, $base .'?dlpl=Prefixed');
	check('root-prefixed playlist download is a zip', substr($body, 0, 2) === 'PK', 'not a zip');
} else {
	skip('download a folder', 'no zip/7z executable');
	skip('download a playlist', 'no zip/7z executable');
	skip('download a playlist with root-prefixed entries', 'no zip/7z executable');
}

$body = expect_status('list online playlists', 200, 'GET', null, $base .'?pl');
check('playlist listing contains fixtures', strpos($body, 'Mix') !== false, 'Mix missing');

$body = expect_status('open a sub-library', 200, 'GET', null, $base .'?play=library/AlbumA');
check('sub-library lists its songs', strpos($body, 'track1.mp3') !== false, 'track1.mp3 missing');

$body = expect_status('open a single song', 200, 'GET', null, $base .'?play=library/AlbumA/track2.mp3');
check('single song mode is returned', strpos($body, 'var library=') !== false, 'no library output');

$savedName = 'Saved-'. getmypid();
$savedFile = $pls . DIRECTORY_SEPARATOR . $savedName .'.mfp.json';
$savedSongs = json_encode([['path' => 'AlbumA/track1.mp3']]);
expect_status('save a playlist', 200, 'POST', json_encode(['name' => $savedName, 'songs' => $savedSongs]));
check('saved playlist exists', is_file($savedFile), 'file not written');
check('saved playlist content round-trips', is_file($savedFile) && json_decode(file_get_contents($savedFile)) === $savedSongs, 'content mismatch');

expect_status('overwrite an existing playlist', 200, 'POST', json_encode(['name' => 'Mix', 'songs' => $savedSongs]));
$mix = json_decode(file_get_contents($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json'));
check('overwrite replaced the playlist', $mix === $savedSongs, 'Mix not overwritten');
check('overwrite kept a timestamped backup', count(glob($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json.*')) >= 1, 'no backup');

expect_status('delete a playlist', 200, 'DELETE', json_encode(['name' => $savedName]));
check('playlist file was deleted', !file_exists($savedFile), 'file still exists');

// Restore Mix for the later snapshot and malicious-name checks
file_put_contents($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json',
	json_encode(json_encode([['path' => 'AlbumA/track1.mp3']])));
foreach (glob($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json.*') as $backup)
	@unlink($backup);

// --------------------------------------------------------- malicious requests

say('');
say('Malicious requests');

$before = [
	'library' => snapshot($library),
	'app' => snapshot($app),
	'outside' => snapshot($outside),
];

$downloads = [
	'traversal to a sibling directory' => '?dl=../outside/secret.txt',
	'traversal through the library root' => '?dl=library/../../outside/secret.txt',
	'traversal with backslashes' => '?dl=library%5C..%5C..%5Coutside%5Csecret.txt',
	'traversal with encoded dots' => '?dl=library/%2e%2e/%2e%2e/outside/secret.txt',
	'absolute unix path' => '?dl=/etc/passwd',
	'absolute windows path' => '?dl=C:/Windows/win.ini',
	'root with parent segment' => '?dl=library/..',
	'server script itself' => '?dl=music.php',
	'playlist directory' => '?dl=music.pls/Mix.mfp.json',
	'empty path' => '?dl=',
	'prefix look-alike directory' => '?dl=library2/track.mp3',
];
foreach ($downloads as $name => $query)
	expect_rejected('reject download: '. $name, $query, $marker, $absoluteHint);

$plays = [
	'traversal' => '?play=../outside',
	'backslash traversal' => '?play=library%5C..%5C..%5Coutside',
	'absolute path' => '?play=/etc/passwd',
	'server script itself' => '?play=music.php',
];
foreach ($plays as $name => $query)
	expect_rejected('reject library path: '. $name, $query, $marker, $absoluteHint);

$playlistDownloads = [
	'traversal' => '?dlpl=../outside/secret',
	'separator in name' => '?dlpl=a/b',
	'absolute path' => '?dlpl=/etc/passwd',
	'playlist containing a traversal entry' => '?dlpl=Escape',
	'playlist containing an absolute entry' => '?dlpl=Absolute',
	'empty name' => '?dlpl=',
];
foreach ($playlistDownloads as $name => $query)
	expect_rejected('reject playlist download: '. $name, $query, $marker, $absoluteHint);

$badNames = [
	'parent traversal' => '../outside/pwn',
	'traversal with backslashes' => '..\\outside\\pwn',
	'absolute unix path' => '/tmp/pwn',
	'absolute windows path' => 'C:/Windows/pwn',
	'separator in name' => 'a/b',
	'backslash separator' => 'a\\b',
	'empty name' => '',
	'current directory' => '.',
	'parent directory' => '..',
	'hidden name' => '.hidden',
];
foreach ($badNames as $name => $value) {
	$body = request($base, 'POST', json_encode(['name' => $value, 'songs' => '["x"]']));
	check('reject saving playlist: '. $name, $lastStatus === 400, 'expected HTTP 400, got '. $lastStatus);
	$body = request($base, 'DELETE', json_encode(['name' => $value]));
	check('reject deleting playlist: '. $name, $lastStatus === 400, 'expected HTTP 400, got '. $lastStatus);
}

// A literal wildcard in the name must never act as a pattern: only a file
// with that exact name may disappear, and here no such file exists.
$wildcardBody = request($base, 'DELETE', json_encode(['name' => 'Mix*']));
check('wildcard playlist name is treated literally', $lastStatus === 200 || $lastStatus === 400,
	'unexpected HTTP '. $lastStatus);
check('wildcard playlist name did not delete Mix', is_file($pls . DIRECTORY_SEPARATOR .'Mix.mfp.json'), 'Mix.mfp.json was removed');
check('wildcard playlist name did not create files', !file_exists($pls . DIRECTORY_SEPARATOR .'Mix*.mfp.json'), 'literal file created?');

// No request above may have changed anything on disk
$after = [
	'library' => snapshot($library),
	'app' => snapshot($app),
	'outside' => snapshot($outside),
];
foreach ($before as $area => $snap) {
	$diff = differences($snap, $after[$area]);
	// The playlist listing may have added library.json only when caching is on;
	// it is disabled by default, and backups created by the legitimate save
	// above happened before the snapshot, so any difference is a real failure.
	check('malicious requests left "'. $area .'" untouched', count($diff) === 0, implode('; ', $diff));
}
check('outside file still holds its marker', file_get_contents($outsideFile) === $marker, 'outside file changed');

// ------------------------------------------- absolute library root deployment

// Some installations configure an absolute `root`. Clients then send that same
// absolute prefix, which must keep working while every other absolute path is
// still refused. This runs against a second copy of the application.
say('');
say('Absolute library root deployment');

$absApp = $tmp . DIRECTORY_SEPARATOR .'abs-app';
$absLib = $tmp . DIRECTORY_SEPARATOR .'abs-library';
$absPls = $absApp . DIRECTORY_SEPARATOR .'pls';
$absSongs = $absLib . DIRECTORY_SEPARATOR .'Album';
$absOutside = $tmp . DIRECTORY_SEPARATOR .'abs-outside';
mkdir($absApp, 0777, true);
mkdir($absSongs, 0777, true);
mkdir($absPls, 0777, true);
mkdir($absOutside, 0777, true);
foreach (['music.php', 'music.defaults.ini', 'music.lang.en.ini'] as $f)
	copy($repo . DIRECTORY_SEPARATOR . $f, $absApp . DIRECTORY_SEPARATOR . $f);
file_put_contents($absSongs . DIRECTORY_SEPARATOR .'abs.mp3', 'ABS-SONG-BYTES');
file_put_contents($absOutside . DIRECTORY_SEPARATOR .'secret.txt', $marker);

$absConfig = $absApp . DIRECTORY_SEPARATOR .'music.defaults.ini';
$config = file_get_contents($absConfig);
$config = str_replace('root = library', 'root = '. str_replace('\\', '/', $absLib), $config);
$config = str_replace('playlistdir = music.pls', 'playlistdir = '. str_replace('\\', '/', $absPls), $config);
file_put_contents($absConfig, $config);

$absPort = $port + 1;
$absProc = proc_open(
	escapeshellarg(PHP_BINARY) .' -S 127.0.0.1:'. $absPort .' -t '. escapeshellarg($absApp),
	[['pipe', 'r'], ['file', $serverLog, 'a'], ['file', $serverLog, 'a']],
	$absPipes, $absApp);
$absReady = false;
for ($i = 0; $i < 100 && is_resource($absProc); $i++) {
	usleep(50000);
	$sock = @fsockopen('127.0.0.1', $absPort, $errno, $errstr, 0.2);
	if ($sock) {
		fclose($sock);
		$absReady = true;
		break;
	}
}
if (!$absReady) {
	skip('absolute library root deployment', 'could not start a second server');
} else {
	$absBase = 'http://127.0.0.1:'. $absPort .'/music.php';
	$absPrefix = str_replace('\\', '/', $absLib);

	$body = request($absBase .'?dl='. $absPrefix .'/Album/abs.mp3');
	check('absolute root: download with the configured prefix', $lastStatus === 200 && $body === 'ABS-SONG-BYTES',
		'expected the song, got HTTP '. $lastStatus .' '. var_export(substr($body, 0, 60), true));

	$body = request($absBase .'?play='. $absPrefix .'/Album');
	check('absolute root: open a sub-library', $lastStatus === 200 && strpos($body, 'abs.mp3') !== false,
		'expected the sub-library, got HTTP '. $lastStatus);

	$outsideAbs = [
		'another absolute path' => '?dl=C:/Windows/win.ini',
		'an absolute escape from the root' => '?dl='. $absPrefix .'/../../abs-outside/secret.txt',
		'a look-alike prefix' => '?dl='. $absPrefix .'-evil/x.mp3',
		'the outside directory' => '?dl='. str_replace('\\', '/', $absOutside) .'/secret.txt',
	];
	foreach ($outsideAbs as $name => $query) {
		$body = request($absBase . $query);
		check('absolute root rejects '. $name, $lastStatus >= 400 && $lastStatus < 500, 'expected 4xx, got HTTP '. $lastStatus);
		$leaked = strpos($body, $marker) !== false || strpos($body, $absPrefix) !== false;
		check('absolute root does not leak paths for '. $name, !$leaked, 'response leaked a path');
	}

	$body = request($absBase, 'DELETE', json_encode(['name' => '../abs-outside/secret']));
	check('absolute root rejects traversing playlist names', $lastStatus === 400, 'expected HTTP 400, got '. $lastStatus);
	check('absolute root outside file untouched', file_get_contents($absOutside . DIRECTORY_SEPARATOR .'secret.txt') === $marker, 'outside file changed');
}

// --------------------------------------------------------------- reporting

say('');
say(sprintf('Result: %d passed, %d failed, %d skipped', $passes, $failures, $skipped));

// Tear down
if (isset($absProc) && is_resource($absProc))
	proc_terminate($absProc);
proc_terminate($proc);
foreach ($pipes as $pipe)
	@fclose($pipe);
proc_close($proc);
if (isset($absProc) && is_resource($absProc))
	proc_close($absProc);
rmtree($tmp);

exit($failures === 0 ? 0 : 1);

<?php
	error_reporting(0);
	// Never let warnings or notices disclose server paths in a response
	ini_set('display_errors', '0');

	header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
	header('Cache-Control: post-check=0, pre-check=0', false);
	header('Pragma: no-cache');

	// Anchor every internal file read to this script's directory instead of the
	// process working directory, which a request may have changed.
	$script_dir = __DIR__;
	$ini = parse_ini_file($script_dir .'/music.defaults.ini', true, INI_SCANNER_RAW);
	if (file_exists($script_dir .'/music.ini'))
		$ini = ini_merge($ini, parse_ini_file($script_dir .'/music.ini', true, INI_SCANNER_RAW));

	$cfg = $ini['server'];
	$ext = explode(',', $cfg['ext_songs'] .','. $cfg['ext_images']);
	$img = explode(',', $cfg['ext_images']);

	if (isset($_GET['lng']))
		$lngcode = $_GET['lng'];
	else {
		$langs = explode(',', $_SERVER['HTTP_ACCEPT_LANGUAGE']);
		foreach($langs as $lang) {
			$lngcode = substr($lang, 0, 2);
			if (file_exists($script_dir .'/music.lang.'. $lngcode .'.ini'))
				break;
		}
	}
	// Language codes are two letters; never let them address other files
	if (!is_string($lngcode) || !preg_match('/^[A-Za-z]{2}$/', $lngcode))
		$lngcode = 'en';

	$lng = parse_ini_file($script_dir .'/music.lang.en.ini', true, INI_SCANNER_RAW);
	$lngfile = $script_dir .'/music.lang.'. $lngcode .'.ini';
	if ($lngcode != 'en' && file_exists($lngfile))
		$lng = ini_merge($lng, parse_ini_file($lngfile, true, INI_SCANNER_RAW));

	// All file operations are confined to these two directories. Client
	// supplied paths are always relative to the directory of this script.
	$base_dir = normalize_path(__DIR__);
	$root_dir = config_dir($cfg['root'], $base_dir);
	$playlist_dir = config_dir($cfg['playlistdir'], $base_dir);
	$root_real = real_dir($root_dir);
	$playlist_real = real_dir($playlist_dir);
	// When the operator configured an absolute library root, clients address
	// files with that same absolute prefix; otherwise absolute paths are invalid.
	$absolute_root = preg_match('#^([A-Za-z]:|/)#', str_replace('\\', '/', $cfg['root'])) === 1;

	if (isset($_GET['dl'])) {
		if (!is_string($_GET['dl'])) deny('Invalid download path');
		$target = client_file_path($_GET['dl'], $base_dir, $root_dir, $root_real, $absolute_root);
		if ($target === false) deny('Invalid download path');
		if (!file_exists($target)) deny('File not found', 404);
		if (is_dir($target)) {
			if (!@chdir($target)) deny('Could not open folder', 500);
			return_zip(basename($target), ['.'], false);
		} elseif (is_file($target)) {
			header('Content-Disposition: attachment; filename="'. header_filename($target) .'"');
			header('Content-Length: '. filesize($target));
			header('Content-Type: '. (function_exists('mime_content_type') ? mime_content_type($target) : 'application/octet-stream'));
			readfile($target);
			exit;
		} else deny('File not found', 404);
	} elseif (isset($_GET['dlpl'])) {
		if (!is_string($_GET['dlpl'])) deny('Invalid playlist name');
		$plname = normalize_playlist_name($_GET['dlpl']);
		if ($plname === false) deny('Invalid playlist name');
		$plfile = playlist_file($plname, $playlist_dir, $playlist_real);
		if ($plfile === false || !is_file($plfile)) deny('Playlist not found', 404);
		$pl = json_decode(json_decode(file_get_contents($plfile)));
		if (is_object($pl)) $pl = $pl->playlist;
		if (!is_array($pl)) deny('Playlist not found', 404);
		$files = array();
		$filenames = '';
		$zip_cwd = $base_dir;
		foreach($pl as $song) {
			$songpath = (is_object($song) && isset($song->path) && is_string($song->path)) ? $song->path : false;
			if ($songpath === false) deny('Invalid playlist');
			// Playlist entries are relative to the library root; playlists saved
			// while browsing a sub-library also carry the root prefix, so accept
			// the script-relative form too. Both stay confined to the root.
			$path = client_file_path($songpath, $root_dir, $root_dir, $root_real, $absolute_root);
			if ($path === false || !is_file($path))
				$path = client_file_path($songpath, $base_dir, $root_dir, $root_real, $absolute_root);
			if ($path === false || !is_file($path)) deny('Song not found', 404);
			// Archives are built relative to the script directory when possible,
			// otherwise relative to the library root
			if ($zip_cwd === $base_dir && !path_within($path, $base_dir)) $zip_cwd = $root_dir;
			array_push($files, $path);
			$filenames .= basename($path) ."\r\n";
		}
		// Build the .m3u next to a private temp directory so concurrent requests
		// with the same playlist name cannot clobber each other
		$tmpdir = sys_get_temp_dir() .'/mfp_pl_'. md5(uniqid('', true));
		if (!@mkdir($tmpdir, 0700)) deny('Could not create playlist', 500);
		$m3u = $tmpdir .'/'. $plname .'.m3u';
		if (file_put_contents($m3u, $filenames) === false) {
			@unlink($m3u);
			@rmdir($tmpdir);
			deny('Could not create playlist', 500);
		}
		// Entries stay relative to the zip working directory, so the archive
		// never contains absolute server paths
		$cwd_slash = rtrim(str_replace('\\', '/', $zip_cwd), '/');
		foreach ($files as $i => $path) {
			$slashed = str_replace('\\', '/', $path);
			$files[$i] = path_within($path, $zip_cwd) && strncmp($slashed, $cwd_slash .'/', strlen($cwd_slash) + 1) === 0
				? substr($slashed, strlen($cwd_slash) + 1)
				: basename($path);
		}
		if (!@chdir($zip_cwd)) {
			@unlink($m3u);
			@rmdir($tmpdir);
			deny('Could not open folder', 500);
		}
		return_zip($plname, $files, $m3u, $tmpdir);
	} elseif (isset($_GET['pl'])) {
		$playlists = array();
		if (is_dir($playlist_dir)) {
			$scan = scandir($playlist_dir);
			foreach ($scan as $f) {
				if (substr($f, -8) != 'mfp.json') continue;
				$plfile = playlist_file(substr($f, 0, -9), $playlist_dir, $playlist_real);
				if ($plfile === false || !is_file($plfile)) continue;
				$playlists[substr($f, 0, -9)] = json_decode(file_get_contents($plfile));
			}
		}
		die(json_encode($playlists));
	}

	$pl = json_decode(file_get_contents('php://input'), true);
	if (is_array($pl) && isset($pl['name'])) {
		$plname = normalize_playlist_name($pl['name']);
		if ($plname === false) deny('Invalid playlist name');
		$plfile = playlist_file($plname, $playlist_dir, $playlist_real);
		if ($plfile === false) deny('Invalid playlist name');

		if ($_SERVER['REQUEST_METHOD'] == 'DELETE') {
			// Only ever delete the exact playlist file, never a wildcard match
			if (is_file($plfile) && !@unlink($plfile)) deny('Could not delete playlist', 500);
			exit;
		}

		if (!isset($pl['songs']) || (!is_string($pl['songs']) && !is_array($pl['songs']))) deny('Invalid playlist');
		if (!is_dir($playlist_dir) && !@mkdir($playlist_dir, 0777, true)) deny('Could not save playlist', 500);
		if (is_file($plfile)) @rename($plfile, $plfile .'.'. time());
		if (file_put_contents($plfile, json_encode($pl['songs'])) === false) {
			@unlink($plfile);
			deny('Could not save playlist', 500);
		}
		exit;
	}

	// Validate the requested library path before any output, so rejected
	// requests get a plain error response instead of JavaScript
	$dir = $root_dir;
	$dir_url = $cfg['root'];
	$play = '';
	$play_file = false;
	$play_missing = false;
	if (isset($_GET['play'])) {
		if (!is_string($_GET['play'])) deny('Invalid path');
		$play_raw = $_GET['play'];
		// Shared playlist links pass a "pl:<name>" marker; the playlist itself
		// is loaded through ?pl, so there is no library to show here.
		if (strncmp($play_raw, 'pl:', 3) === 0 || $play_raw === '')
			$play_missing = true;
		else {
			$play_abs = client_file_path($play_raw, $base_dir, $root_dir, $root_real, $absolute_root);
			if ($play_abs === false) deny('Invalid path');
			$play_real = real_dir($play_abs);
			if (is_file($play_abs)) {
				$play_file = $play_abs;
				// The client addresses this file relative to the script directory
				$play = normalize_relative_path($play_raw);
				if ($play === false) $play = normalize_path($play_abs);
			} elseif (is_dir($play_abs)) {
				// Playing/sharing the library root itself shows no sub-library
				if (normalize_path($play_abs) === normalize_path($root_dir)
					|| ($root_real !== false && $play_real === $root_real))
					$play_missing = true;
				else {
					$dir = $play_abs;
					$dir_url = normalize_relative_path($play_raw);
					if ($dir_url === false) $dir_url = normalize_path($play_abs);
				}
			} else
				$play_missing = true;
		}
	}

	header('Content-Type: application/javascript; charset=utf-8');

	if (!isset($_GET['reload'])) {
		echo 'const ext_images = '. json_encode($img) .';'. PHP_EOL;
		foreach($ini['client'] as $key => $value)
			echo (stristr($key, '.') ? '' : 'const ') . $key .'='. $value .';'. PHP_EOL;
		foreach($lng['elements'] as $key => $value)
			echo 'lng(dom.'. $key .',"'. $value .'");'. PHP_EOL;
		foreach($lng['tooltips'] as $key => $value)
			echo 'lng(dom.'. $key .',"'. $value .'",1);'. PHP_EOL;
		foreach($lng['strings'] as $key => $value)
			echo 'str[\''. $key .'\']="'. $value .'";'. PHP_EOL;
	}

	if ($play_missing) {
		echo (isset($_GET['reload']) ? '' : 'const root='. json_encode($cfg['root'] .'/') .';'. PHP_EOL) .'var library={"'. $lng['strings']['notfound'] .'":""}';
		exit;
	}

	if ($play_file !== false) {
		$files = array();
		$files[$play] = '';	// Add file
		$scan = scandir(dirname($play_file));	// Scan parent folder for cover
		foreach ($scan as $f) {
			$ext = strtolower(substr($f, strrpos($f, '.') + 1));
			if (in_array($ext, $img)) {
				$files[$f] = '';
				break;
			}
		}
		echo 'const root="";'. PHP_EOL .'var library={"\/":'. json_encode($files) .'};';
		exit;
	}

	$lib_path = $playlist_dir .'/library.json';
	if (!path_within($lib_path, $playlist_dir)) $lib_path = $base_dir .'/library.json';
	if (!$cfg['cache'] || isset($_GET['play']) || isset($_GET['reload']) || !file_exists($lib_path)) {
		$lib = json_encode(tree($dir, 0));
		if ($cfg['cache'] && !isset($_GET['play'])) {
			if (!is_dir($playlist_dir)) @mkdir($playlist_dir, 0777, true);
			@file_put_contents($lib_path, $lib);
		}
	} else $lib = file_get_contents($lib_path);

	echo (isset($_GET['reload']) ? '' : 'const root='. json_encode($dir_url .'/') .';'). PHP_EOL .'var library='. $lib;

	// Reject the request with a clear message. Messages are static on purpose:
	// responses must never expose server-side absolute paths.
	function deny($message, $code = 400) {
		http_response_code($code);
		header('Content-Type: text/plain; charset=utf-8');
		die($message);
	}

	// Normalize slashes, resolve "." and ".." lexically and resolve symlinks
	// when the path exists. Used for both absolute and relative paths.
	function normalize_path($path) {
		$path = str_replace('\\', '/', $path);
		$real = @realpath($path);
		if ($real !== false)
			$path = str_replace('\\', '/', $real);
		$prefix = '';
		if (preg_match('#^([A-Za-z]:)#', $path, $m))
			$prefix = $m[1];
		// A drive prefix makes the path absolute (D:/foo), as does a leading slash
		$abs = $prefix !== '' || substr($path, 0, 1) == '/';
		$parts = array();
		foreach (explode('/', substr($path, strlen($prefix))) as $part) {
			if ($part === '' || $part === '.')
				continue;
			if ($part === '..') {
				if (count($parts) && end($parts) !== '..')
					array_pop($parts);
				elseif (!$abs && !$prefix)
					$parts[] = '..';
				continue;
			}
			$parts[] = $part;
		}
		$out = $prefix . ($abs ? '/' : '') . implode('/', $parts);
		return $out === '' ? '.' : $out;
	}

	// Resolve a configured server directory (relative to this file or absolute).
	function config_dir($value, $base) {
		if (!is_string($value) || $value === '' || strpos($value, "\0") !== false)
			return $base;
		$value = str_replace('\\', '/', $value);
		if (preg_match('#^([A-Za-z]:|/)#', $value))
			return normalize_path($value);
		return normalize_path($base .'/'. $value);
	}

	function real_dir($dir) {
		$real = @realpath($dir);
		return $real === false ? false : normalize_path($real);
	}

	// True if $path is $dir itself or lies inside it.
	function path_within($path, $dir) {
		$path = normalize_path($path);
		$dir = rtrim(normalize_path($dir), '/');
		if ($dir === '')
			return false;
		$windows = DIRECTORY_SEPARATOR == '\\';
		if ($windows ? strcasecmp($path, $dir) === 0 : $path === $dir)
			return true;
		$prefix = $dir .'/';
		return ($windows ? strncasecmp($path, $prefix, strlen($prefix)) : strncmp($path, $prefix, strlen($prefix))) === 0;
	}

	// Validate and normalize a path relative to the base directory. Rejects
	// absolute paths, traversal, empty paths, control characters and (on
	// Windows) drive/stream syntax and segments Windows would silently trim.
	function normalize_relative_path($path) {
		if (!is_string($path) || $path === '' || strpos($path, "\0") !== false)
			return false;
		$path = str_replace('\\', '/', $path);
		if (preg_match('#^([A-Za-z]:|/)#', $path))
			return false;
		$windows = DIRECTORY_SEPARATOR == '\\';
		$segments = array();
		foreach (explode('/', $path) as $segment) {
			if ($segment === '' || $segment === '.')
				continue;
			if (preg_match('/[\x00-\x1f\x7f]/', $segment))
				return false;
			if ($segment === '..')
				return false;
			if ($windows) {
				if (strpos($segment, ':') !== false)
					return false;
				if (rtrim($segment, '. ') === '')	// Windows strips trailing dots/spaces
					return false;
			}
			$segments[] = $segment;
		}
		if (!count($segments))
			return false;
		return implode('/', $segments);
	}

	// Resolve a client supplied path to an absolute path inside $allowed
	// ($allowed is the configured, normalized directory). Relative paths are
	// resolved against $base. Whatever the form, the result must stay inside
	// $allowed, lexically as well as after resolving links. Traversal, empty
	// paths, control characters and absolute paths are rejected; absolute
	// paths are only understood when the operator configured the library with
	// an absolute path, because the client then sends that prefix verbatim.
	// Returns the absolute path (it need not exist yet) or false.
	function client_file_path($path, $base, $allowed, $allowed_real, $allow_absolute = false) {
		if (!is_string($path) || $path === '' || strpos($path, "\0") !== false)
			return false;
		$slashed = str_replace('\\', '/', $path);
		if (preg_match('#^([A-Za-z]:|/)#', $slashed)) {
			if (!$allow_absolute)
				return false;
			$abs = normalize_path($slashed);
			if (!path_within($abs, $allowed))
				return false;
		} else {
			$rel = normalize_relative_path($path);
			if ($rel === false)
				return false;
			$abs = resolve_in_dir($base, $rel);
			if (!path_within($abs, $allowed))
				return false;
		}
		$real = real_dir($abs);
		if ($real === false) {
			// Nonexistent target: its parent must stay inside the allowed directory
			$parent = real_dir(dirname($abs));
			if ($parent === false || !path_within($parent, $allowed))
				return false;
			if ($allowed_real !== false && !path_within($parent, $allowed_real))
				return false;
			return $abs;
		}
		if (!path_within($real, $allowed))
			return false;
		if ($allowed_real !== false && !path_within($real, $allowed_real))
			return false;
		return $abs;
	}

	// Validate a playlist name: one plain path segment, no separators, no
	// traversal, no absolute paths, no control characters.
	function normalize_playlist_name($name) {
		if (!is_string($name) || $name === '' || strpos($name, "\0") !== false)
			return false;
		if (preg_match('/[\/\\\\\x00-\x1f\x7f]/', $name))
			return false;
		if ($name !== trim($name))
			return false;
		// No traversal, no dot-only names and no hidden files
		if (strpos($name, '.') === 0 || rtrim($name, '. ') === '')
			return false;
		if ((function_exists('mb_strlen') ? mb_strlen($name, 'UTF-8') : strlen($name)) > 200)
			return false;
		if (DIRECTORY_SEPARATOR == '\\') {
			if (strpos($name, ':') !== false)
				return false;
			if (preg_match('/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i', $name))
				return false;
		}
		return $name;
	}

	// Absolute path of an (existing or to be created) playlist file, or false
	// if it would fall outside the playlist directory.
	function playlist_file($name, $playlist_dir, $playlist_real) {
		$file = resolve_in_dir($playlist_dir, $name .'.mfp.json');
		if (!path_within($file, $playlist_dir))
			return false;
		$real = real_dir($file);
		if ($real !== false) {
			if (!path_within($real, $playlist_dir))
				return false;
			if ($playlist_real !== false && !path_within($real, $playlist_real))
				return false;
			return $file;
		}
		// Not created yet. The playlist directory is configured (trusted) and is
		// created on save; when it already exists it must not be a symlink out.
		$dir_real = real_dir($playlist_dir);
		if ($dir_real === false)
			return $playlist_real === false ? $file : false;
		if (!path_within($dir_real, $playlist_dir))
			return false;
		if ($playlist_real !== false && !path_within($dir_real, $playlist_real))
			return false;
		return $file;
	}

	function resolve_in_dir($dir, $relative) {
		return rtrim(normalize_path($dir), '/') .'/'. $relative;
	}

	// Strip characters that could break out of a Content-Disposition header.
	function header_filename($name) {
		return preg_replace('/[\x00-\x1f\x7f"\\\\\/]/', '_', basename(str_replace('\\', '/', $name)));
	}

	function ini_merge($ini, $usr) {
		foreach ($usr as $k => $v)
			if (is_array($v))
				$ini[$k] = ini_merge($ini[$k], $usr[$k]);
			else
				$ini[$k] = $v;
		return $ini;
	}

	function tree($dir, $depth) {
		$scan = scandir($dir);
		$files = array();
		$tree = array();
		$hasmusic = false;

		foreach ($scan as $f) {
			if (substr($f, 0, 1) == '.')
				continue;
			$path = "$dir/$f";
			// Never list or recurse into anything that resolves outside the
			// library (e.g. a link or junction placed in the library folder)
			if (is_dir($path) || is_link($path)) {
				$real = real_dir($path);
				$root_real = isset($GLOBALS['root_real']) ? $GLOBALS['root_real'] : false;
				if ($real === false || ($root_real !== false && !path_within($real, $root_real)))
					continue;
			}
			if (is_dir($path)) {
				if ($depth < $GLOBALS['cfg']['maxdepth']) {
					$subfolder = tree($path, $depth + 1);
					if ($subfolder)
						$tree[$f] = $subfolder;
				}
			} else {
					$ext = strtolower(substr($f, strrpos($f, '.') + 1));
					if (in_array($ext, $GLOBALS['ext'])) {
						$files[$f] = '';
						if (!in_array($ext, $GLOBALS['img']))
							$hasmusic = true;
					}
			}
		}

		if ($hasmusic)
			$tree['/'] = $files;
		if (count((array) $tree) > 0)
			return $tree;
		else
			return false;
	}

	function return_zip($name, $paths, $pl, $tmpdir = null) {
		$list_path = tempnam(sys_get_temp_dir(), 'mfp_');
		if ($list_path === false) die('Error creating zip');
		$list = fopen($list_path, 'w');
		if ($list === false) {
			@unlink($list_path);
			die('Error creating zip');
		}
		if (substr(php_uname(), 0, 7) == 'Windows') {
			foreach($paths as $path) fwrite($list, ($pl ? './' : '') . $path ."\r\n");
			$cmd = '7z a dummy -tzip -mx1 -so -i@'. escapeshellarg($list_path);
		} else {
			foreach($paths as $path) fwrite($list, $path ."\n");
			$cmd = 'zip - -0 '. ($pl ? '-j' : '-r') .' -@ <'. escapeshellarg($list_path);
		}
		if ($pl) fwrite($list, $pl);
		fclose($list);
		$descriptorspec = array(array('pipe', 'r'), array('pipe', 'w'), array('pipe', 'a'));
		$zip_proc = proc_open($cmd, $descriptorspec, $pipes);
		if (!$zip_proc) {
			if ($pl) @unlink($pl);
			if ($tmpdir !== null) @rmdir($tmpdir);
			@unlink($list_path);
			die('Error creating zip');
		}
		header('Content-type: application/zip');
		header('Content-disposition: attachment; filename="'. header_filename($name) .'.zip"');
		$err = fread($pipes[2], 8192);
		fpassthru($pipes[1]);
		fclose($pipes[2]);
		fclose($pipes[1]);
		fclose($pipes[0]);
		$res = proc_close($zip_proc);
		if ($res != 0) {
			error_log('zip error ('. $res .'): '. $err . PHP_EOL);
			http_response_code(500);
		}
		if ($pl) @unlink($pl);
		if ($tmpdir !== null) @rmdir($tmpdir);
		@unlink($list_path);
		exit;
	}
?>

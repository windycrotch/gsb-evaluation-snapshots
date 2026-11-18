var fs = require('fs');
var path = require('path');
var html = fs.readFileSync(path.join(__dirname, '..', 'html', 'qwerty.html'), 'utf8');
var matches = html.match(/<script><!--([\s\S]*?)--><\/script>/);
if (!matches) throw new Error('inline script not found');
new Function(matches[1]); // parse-only check; does not execute
console.log('inline script parses OK,', matches[1].split('\n').length, 'lines');

// Every external src must resolve relative to html/.
var srcs = html.match(/src="[^"]+"/g) || [];
srcs.forEach(function (s) {
  var rel = s.replace(/^src="/, '').replace(/"$/, '');
  var file = path.join(__dirname, '..', 'html', rel);
  if (!fs.existsSync(file)) throw new Error('missing asset: ' + rel);
  console.log('asset OK:', rel);
});

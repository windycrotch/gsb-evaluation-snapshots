(function webpackUniversalModuleDefinition(root, factory) {
	if(typeof exports === 'object' && typeof module === 'object')
		module.exports = factory(require("vue"));
	else if(typeof define === 'function' && define.amd)
		define("canvas-player", [], factory);
	else if(typeof exports === 'object')
		exports["canvas-player"] = factory(require("vue"));
	else
		root["canvas-player"] = factory(root["Vue"]);
})((typeof self !== 'undefined' ? self : this), function(__WEBPACK_EXTERNAL_MODULE__274__) {
return /******/ (function() { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 860:
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(601);
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(314);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__);
/* harmony import */ var _node_modules_css_loader_dist_cjs_js_clonedRuleSet_52_use_1_node_modules_vue_vue_loader_v15_lib_loaders_stylePostLoader_js_node_modules_postcss_loader_dist_cjs_js_clonedRuleSet_52_use_2_node_modules_postcss_loader_dist_cjs_js_clonedRuleSet_52_use_3_style_style_css__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(188);
// Imports



var ___CSS_LOADER_EXPORT___ = _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default()((_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default()));
___CSS_LOADER_EXPORT___.i(_node_modules_css_loader_dist_cjs_js_clonedRuleSet_52_use_1_node_modules_vue_vue_loader_v15_lib_loaders_stylePostLoader_js_node_modules_postcss_loader_dist_cjs_js_clonedRuleSet_52_use_2_node_modules_postcss_loader_dist_cjs_js_clonedRuleSet_52_use_3_style_style_css__WEBPACK_IMPORTED_MODULE_2__/* ["default"] */ .A);
// Module
___CSS_LOADER_EXPORT___.push([module.id, "", ""]);
// Exports
/* harmony default export */ __webpack_exports__["default"] = (___CSS_LOADER_EXPORT___);


/***/ }),

/***/ 188:
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(601);
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(314);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__);
// Imports


var ___CSS_LOADER_EXPORT___ = _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default()((_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default()));
// Module
___CSS_LOADER_EXPORT___.push([module.id, ".volume{margin-right:10px;--line:#fff;--line-width:6px;--duration:.5s;position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent}.volume input{position:absolute;width:100%;height:100%;opacity:0}.volume input+svg{display:block;fill:none;stroke:var(--line);stroke-linecap:round;stroke-linejoin:round;stroke-width:var(--line-width);width:25px;height:20px}.volume input+svg path{animation:var(--name) var(--duration) ease forwards}.volume input+svg path:nth-child(2),.volume input+svg path:nth-child(3){stroke-dashoffset:1px}.volume input:checked+svg path:first-child{--name:shape}.volume input:checked+svg path:nth-child(2){--name:small}.volume input:checked+svg path:nth-child(3){--name:large}.volume input:not(:checked)+svg path:first-child{--name:shape-r}.volume input:not(:checked)+svg path:nth-child(2){--name:small-r}.volume input:not(:checked)+svg path:nth-child(3){--name:large-r}@keyframes small{0%,30%{stroke-dasharray:0 0 30px 64px}40%{stroke-dashoffset:16px}80%,to{stroke-dashoffset:1px}70%{stroke-dasharray:0 43px 30px 64px}to{stroke-dasharray:0 39px 30px 64px}}@keyframes small-r{0%{stroke-dasharray:0 39px 30px 64px}0%,40%{stroke-dashoffset:1px}70%{stroke-dashoffset:16px}70%,to{stroke-dasharray:0 0 30px 64px}}@keyframes large{0%,30%{stroke-dasharray:0 0 50px 84px}40%{stroke-dashoffset:16px}80%,to{stroke-dashoffset:1px}70%{stroke-dasharray:0 82px 32px 84px}to{stroke-dasharray:0 78px 32px 84px}}@keyframes large-r{0%{stroke-dasharray:0 78px 32px 84px}0%,40%{stroke-dashoffset:1px}70%{stroke-dashoffset:16px}70%,to{stroke-dasharray:0 0 50px 84px}}@keyframes shape{0%{stroke-dasharray:60px 0 184px;stroke-dashoffset:0}70%{stroke-dasharray:63px 51px 184px;stroke-dashoffset:21px}to{stroke-dasharray:59px 47px 184px;stroke-dashoffset:17px}}@keyframes shape-r{0%{stroke-dasharray:59px 47px 184px;stroke-dashoffset:17px}to{stroke-dasharray:60px 0 184px;stroke-dashoffset:0}}@keyframes play1{0%{width:0}to{width:100%}}@keyframes replay1{to{width:100%}}.loadEffect{position:absolute;top:30%;width:100px;height:100px;position:relative;margin:0 auto;margin-top:100px}.loadEffect span{display:inline-block;width:16px;height:16px;border-radius:50%;background:#00a1d6;position:absolute;-webkit-animation:load 1.04s ease infinite}@keyframes load{0%{opacity:1}to{opacity:.2}}.loadEffect span:first-child{left:0;top:50%;margin-top:-8px;-webkit-animation-delay:.13s}.loadEffect span:nth-child(2){left:14px;top:14px;-webkit-animation-delay:.26s}.loadEffect span:nth-child(3){left:50%;top:0;margin-left:-8px;-webkit-animation-delay:.39s}.loadEffect span:nth-child(4){top:14px;right:14px;-webkit-animation-delay:.52s}.loadEffect span:nth-child(5){right:0;top:50%;margin-top:-8px;-webkit-animation-delay:.65s}.loadEffect span:nth-child(6){right:14px;bottom:14px;-webkit-animation-delay:.78s}.loadEffect span:nth-child(7){bottom:0;left:50%;margin-left:-8px;-webkit-animation-delay:.91s}.loadEffect span:nth-child(8){bottom:14px;left:14px;-webkit-animation-delay:1.04s}.playContainer{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);float:left;padding:20px;transition:all .5s}.playContainer li{position:relative;float:left;border:40px solid #404040;color:#404040;height:0;width:0;border-radius:100%;margin:0 20px}.playContainer a{border-style:solid;text-indent:-9999px;position:absolute;top:-16px;left:-6px}.playBtn a{border-color:transparent transparent transparent #fff;border-width:16px 0 16px 24px;width:0;height:0}", ""]);
// Exports
/* harmony default export */ __webpack_exports__.A = (___CSS_LOADER_EXPORT___);


/***/ }),

/***/ 837:
/***/ (function(module, __webpack_exports__, __webpack_require__) {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(601);
/* harmony import */ var _node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(314);
/* harmony import */ var _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(_node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1__);
// Imports


var ___CSS_LOADER_EXPORT___ = _node_modules_css_loader_dist_runtime_api_js__WEBPACK_IMPORTED_MODULE_1___default()((_node_modules_css_loader_dist_runtime_noSourceMaps_js__WEBPACK_IMPORTED_MODULE_0___default()));
// Module
___CSS_LOADER_EXPORT___.push([module.id, ".popup-layer[data-v-0dbe3273]{position:fixed;left:0;top:0;right:0;bottom:0;background-color:rgba(0,0,0,.85);color:#fff}.popup-layer .video-player-wrapper[data-v-0dbe3273]{position:absolute;left:0;top:0;right:0;bottom:0;display:flex;justify-content:center;align-items:center}.popup-layer .popup-layer-btn-close[data-v-0dbe3273]{position:absolute;right:20px;top:20px;width:50px;color:hsla(0,0%,100%,.8);text-align:center;font-style:normal;font-size:40px;line-height:30px;cursor:pointer;padding:6px 0 12px;border-radius:100%;-webkit-user-select:none;-moz-user-select:none;user-select:none}.popup-layer .popup-layer-btn-close[data-v-0dbe3273]:hover{background:hsla(0,0%,100%,.05);color:#fff}#VideoDom[data-v-0dbe3273]{font-size:0;line-height:0;width:100%;height:100%;display:flex;justify-content:center;align-items:center}#VideoDom[data-v-0dbe3273],#VideoDom #canvasDom[data-v-0dbe3273]{position:relative}#VideoDom #canvasDom #progressBar[data-v-0dbe3273]{position:absolute;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;bottom:0;width:100%;background:rgba(0,0,0,.521);z-index:99;opacity:0;transition:all .5s}#VideoDom #canvasDom #progressBar .left-box[data-v-0dbe3273]{display:flex;align-items:center;justify-content:flex-start;width:50%}#VideoDom #canvasDom #progressBar .left-box .btn[data-v-0dbe3273]{height:100%;color:#000;margin-right:2px;background:transparent;border:none}#VideoDom #canvasDom #progressBar .left-box .btn button[data-v-0dbe3273]{margin:10px;padding:0;box-sizing:border-box;border:transparent;background:transparent;-webkit-user-select:none;-moz-user-select:none;user-select:none}#VideoDom #canvasDom #progressBar .left-box .btn button.play[data-v-0dbe3273]{height:20px;border-style:solid;outline:none;border-width:10px 0 10px 18px;border-color:transparent transparent transparent #00a1d6;transition:all .1s linear}#VideoDom #canvasDom #progressBar .left-box .btn button.pause[data-v-0dbe3273]{border-style:double;border-width:0 0 0 18px;border-color:#00a1d6}#VideoDom #canvasDom #progressBar .left-box .total-time[data-v-0dbe3273]{color:#e3e3e3;font-size:15px;line-height:100%;pointer-events:none;-webkit-user-select:none;-moz-user-select:none;user-select:none}#VideoDom #canvasDom #progressBar .bar[data-v-0dbe3273]{display:flex;align-items:center;margin:10px auto 0;width:98%;height:7px;border-radius:10px;background:#7171716e;transition:all .2s;cursor:pointer}#VideoDom #canvasDom #progressBar .bar .line[data-v-0dbe3273]{position:relative;width:100%;height:100%;background:#00a1d6;border-radius:5px;animation-timing-function:linear}#VideoDom #canvasDom #progressBar .bar .line.trans[data-v-0dbe3273]{transition:all .5s}#VideoDom #canvasDom #progressBar .bar .line.play[data-v-0dbe3273]{animation-play-state:running}#VideoDom #canvasDom #progressBar .bar .line.pause[data-v-0dbe3273]{animation-play-state:paused}#VideoDom #canvasDom #progressBar .bar #circle[data-v-0dbe3273]{position:relative;margin-left:-4px;width:8px;height:8px;border-radius:50%;background:#fff;pointer-events:none}#VideoDom #canvasDom #progressBar .bar #circle.trans[data-v-0dbe3273]{pointer-events:auto;transition:all .5s}#VideoDom #canvasDom #progressBar:hover .bar[data-v-0dbe3273]{height:13px;transition:all .2s}#VideoDom #canvasDom #progressBar:hover .bar #circle[data-v-0dbe3273]{height:14px;width:14px}#VideoDom #canvasDom #progressBar.show[data-v-0dbe3273]{opacity:1}#VideoDom #canvasDom:hover #progressBar[data-v-0dbe3273]{opacity:1;transition:all 1s}", ""]);
// Exports
/* harmony default export */ __webpack_exports__["default"] = (___CSS_LOADER_EXPORT___);


/***/ }),

/***/ 314:
/***/ (function(module) {

"use strict";


/*
  MIT License http://www.opensource.org/licenses/mit-license.php
  Author Tobias Koppers @sokra
*/
module.exports = function (cssWithMappingToString) {
  var list = [];

  // return the list of modules as css string
  list.toString = function toString() {
    return this.map(function (item) {
      var content = "";
      var needLayer = typeof item[5] !== "undefined";
      if (item[4]) {
        content += "@supports (".concat(item[4], ") {");
      }
      if (item[2]) {
        content += "@media ".concat(item[2], " {");
      }
      if (needLayer) {
        content += "@layer".concat(item[5].length > 0 ? " ".concat(item[5]) : "", " {");
      }
      content += cssWithMappingToString(item);
      if (needLayer) {
        content += "}";
      }
      if (item[2]) {
        content += "}";
      }
      if (item[4]) {
        content += "}";
      }
      return content;
    }).join("");
  };

  // import a list of modules into the list
  list.i = function i(modules, media, dedupe, supports, layer) {
    if (typeof modules === "string") {
      modules = [[null, modules, undefined]];
    }
    var alreadyImportedModules = {};
    if (dedupe) {
      for (var k = 0; k < this.length; k++) {
        var id = this[k][0];
        if (id != null) {
          alreadyImportedModules[id] = true;
        }
      }
    }
    for (var _k = 0; _k < modules.length; _k++) {
      var item = [].concat(modules[_k]);
      if (dedupe && alreadyImportedModules[item[0]]) {
        continue;
      }
      if (typeof layer !== "undefined") {
        if (typeof item[5] === "undefined") {
          item[5] = layer;
        } else {
          item[1] = "@layer".concat(item[5].length > 0 ? " ".concat(item[5]) : "", " {").concat(item[1], "}");
          item[5] = layer;
        }
      }
      if (media) {
        if (!item[2]) {
          item[2] = media;
        } else {
          item[1] = "@media ".concat(item[2], " {").concat(item[1], "}");
          item[2] = media;
        }
      }
      if (supports) {
        if (!item[4]) {
          item[4] = "".concat(supports);
        } else {
          item[1] = "@supports (".concat(item[4], ") {").concat(item[1], "}");
          item[4] = supports;
        }
      }
      list.push(item);
    }
  };
  return list;
};

/***/ }),

/***/ 601:
/***/ (function(module) {

"use strict";


module.exports = function (i) {
  return i[1];
};

/***/ }),

/***/ 583:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

// style-loader: Adds some css to the DOM by adding a <style> tag

// load the styles
var content = __webpack_require__(860);
if(content.__esModule) content = content.default;
if(typeof content === 'string') content = [[module.id, content, '']];
if(content.locals) module.exports = content.locals;
// add the styles to the DOM
var add = (__webpack_require__(548)/* ["default"] */ .A)
var update = add("6bc090fe", content, true, {"sourceMap":false,"shadowMode":false});

/***/ }),

/***/ 378:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

// style-loader: Adds some css to the DOM by adding a <style> tag

// load the styles
var content = __webpack_require__(837);
if(content.__esModule) content = content.default;
if(typeof content === 'string') content = [[module.id, content, '']];
if(content.locals) module.exports = content.locals;
// add the styles to the DOM
var add = (__webpack_require__(548)/* ["default"] */ .A)
var update = add("12008fab", content, true, {"sourceMap":false,"shadowMode":false});

/***/ }),

/***/ 548:
/***/ (function(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

"use strict";

// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  A: function() { return /* binding */ addStylesClient; }
});

;// ./node_modules/vue-style-loader/lib/listToStyles.js
/**
 * Translates the list format produced by css-loader into something
 * easier to manipulate.
 */
function listToStyles (parentId, list) {
  var styles = []
  var newStyles = {}
  for (var i = 0; i < list.length; i++) {
    var item = list[i]
    var id = item[0]
    var css = item[1]
    var media = item[2]
    var sourceMap = item[3]
    var part = {
      id: parentId + ':' + i,
      css: css,
      media: media,
      sourceMap: sourceMap
    }
    if (!newStyles[id]) {
      styles.push(newStyles[id] = { id: id, parts: [part] })
    } else {
      newStyles[id].parts.push(part)
    }
  }
  return styles
}

;// ./node_modules/vue-style-loader/lib/addStylesClient.js
/*
  MIT License http://www.opensource.org/licenses/mit-license.php
  Author Tobias Koppers @sokra
  Modified by Evan You @yyx990803
*/



var hasDocument = typeof document !== 'undefined'

if (typeof DEBUG !== 'undefined' && DEBUG) {
  if (!hasDocument) {
    throw new Error(
    'vue-style-loader cannot be used in a non-browser environment. ' +
    "Use { target: 'node' } in your Webpack config to indicate a server-rendering environment."
  ) }
}

/*
type StyleObject = {
  id: number;
  parts: Array<StyleObjectPart>
}

type StyleObjectPart = {
  css: string;
  media: string;
  sourceMap: ?string
}
*/

var stylesInDom = {/*
  [id: number]: {
    id: number,
    refs: number,
    parts: Array<(obj?: StyleObjectPart) => void>
  }
*/}

var head = hasDocument && (document.head || document.getElementsByTagName('head')[0])
var singletonElement = null
var singletonCounter = 0
var isProduction = false
var noop = function () {}
var options = null
var ssrIdKey = 'data-vue-ssr-id'

// Force single-tag solution on IE6-9, which has a hard limit on the # of <style>
// tags it will allow on a page
var isOldIE = typeof navigator !== 'undefined' && /msie [6-9]\b/.test(navigator.userAgent.toLowerCase())

function addStylesClient (parentId, list, _isProduction, _options) {
  isProduction = _isProduction

  options = _options || {}

  var styles = listToStyles(parentId, list)
  addStylesToDom(styles)

  return function update (newList) {
    var mayRemove = []
    for (var i = 0; i < styles.length; i++) {
      var item = styles[i]
      var domStyle = stylesInDom[item.id]
      domStyle.refs--
      mayRemove.push(domStyle)
    }
    if (newList) {
      styles = listToStyles(parentId, newList)
      addStylesToDom(styles)
    } else {
      styles = []
    }
    for (var i = 0; i < mayRemove.length; i++) {
      var domStyle = mayRemove[i]
      if (domStyle.refs === 0) {
        for (var j = 0; j < domStyle.parts.length; j++) {
          domStyle.parts[j]()
        }
        delete stylesInDom[domStyle.id]
      }
    }
  }
}

function addStylesToDom (styles /* Array<StyleObject> */) {
  for (var i = 0; i < styles.length; i++) {
    var item = styles[i]
    var domStyle = stylesInDom[item.id]
    if (domStyle) {
      domStyle.refs++
      for (var j = 0; j < domStyle.parts.length; j++) {
        domStyle.parts[j](item.parts[j])
      }
      for (; j < item.parts.length; j++) {
        domStyle.parts.push(addStyle(item.parts[j]))
      }
      if (domStyle.parts.length > item.parts.length) {
        domStyle.parts.length = item.parts.length
      }
    } else {
      var parts = []
      for (var j = 0; j < item.parts.length; j++) {
        parts.push(addStyle(item.parts[j]))
      }
      stylesInDom[item.id] = { id: item.id, refs: 1, parts: parts }
    }
  }
}

function createStyleElement () {
  var styleElement = document.createElement('style')
  styleElement.type = 'text/css'
  head.appendChild(styleElement)
  return styleElement
}

function addStyle (obj /* StyleObjectPart */) {
  var update, remove
  var styleElement = document.querySelector('style[' + ssrIdKey + '~="' + obj.id + '"]')

  if (styleElement) {
    if (isProduction) {
      // has SSR styles and in production mode.
      // simply do nothing.
      return noop
    } else {
      // has SSR styles but in dev mode.
      // for some reason Chrome can't handle source map in server-rendered
      // style tags - source maps in <style> only works if the style tag is
      // created and inserted dynamically. So we remove the server rendered
      // styles and inject new ones.
      styleElement.parentNode.removeChild(styleElement)
    }
  }

  if (isOldIE) {
    // use singleton mode for IE9.
    var styleIndex = singletonCounter++
    styleElement = singletonElement || (singletonElement = createStyleElement())
    update = applyToSingletonTag.bind(null, styleElement, styleIndex, false)
    remove = applyToSingletonTag.bind(null, styleElement, styleIndex, true)
  } else {
    // use multi-style-tag mode in all other cases
    styleElement = createStyleElement()
    update = applyToTag.bind(null, styleElement)
    remove = function () {
      styleElement.parentNode.removeChild(styleElement)
    }
  }

  update(obj)

  return function updateStyle (newObj /* StyleObjectPart */) {
    if (newObj) {
      if (newObj.css === obj.css &&
          newObj.media === obj.media &&
          newObj.sourceMap === obj.sourceMap) {
        return
      }
      update(obj = newObj)
    } else {
      remove()
    }
  }
}

var replaceText = (function () {
  var textStore = []

  return function (index, replacement) {
    textStore[index] = replacement
    return textStore.filter(Boolean).join('\n')
  }
})()

function applyToSingletonTag (styleElement, index, remove, obj) {
  var css = remove ? '' : obj.css

  if (styleElement.styleSheet) {
    styleElement.styleSheet.cssText = replaceText(index, css)
  } else {
    var cssNode = document.createTextNode(css)
    var childNodes = styleElement.childNodes
    if (childNodes[index]) styleElement.removeChild(childNodes[index])
    if (childNodes.length) {
      styleElement.insertBefore(cssNode, childNodes[index])
    } else {
      styleElement.appendChild(cssNode)
    }
  }
}

function applyToTag (styleElement, obj) {
  var css = obj.css
  var media = obj.media
  var sourceMap = obj.sourceMap

  if (media) {
    styleElement.setAttribute('media', media)
  }
  if (options.ssrId) {
    styleElement.setAttribute(ssrIdKey, obj.id)
  }

  if (sourceMap) {
    // https://developer.chrome.com/devtools/docs/javascript-debugging
    // this makes source maps inside style tags work properly in Chrome
    css += '\n/*# sourceURL=' + sourceMap.sources[0] + ' */'
    // http://stackoverflow.com/a/26603875
    css += '\n/*# sourceMappingURL=data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(sourceMap)))) + ' */'
  }

  if (styleElement.styleSheet) {
    styleElement.styleSheet.cssText = css
  } else {
    while (styleElement.firstChild) {
      styleElement.removeChild(styleElement.firstChild)
    }
    styleElement.appendChild(document.createTextNode(css))
  }
}


/***/ }),

/***/ 274:
/***/ (function(module) {

"use strict";
module.exports = __WEBPACK_EXTERNAL_MODULE__274__;

/***/ }),

/***/ 529:
/***/ (function(module) {

"use strict";

// `CreateIterResultObject` abstract operation
// https://tc39.es/ecma262/#sec-createiterresultobject
module.exports = function (value, done) {
  return { value: value, done: done };
};


/***/ }),

/***/ 767:
/***/ (function(module) {

"use strict";

// `GetIteratorDirect(obj)` abstract operation
// https://tc39.es/ecma262/#sec-getiteratordirect
module.exports = function (obj) {
  return {
    iterator: obj,
    next: obj.next,
    done: false
  };
};


/***/ }),

/***/ 117:
/***/ (function(module) {

"use strict";

// we can't use just `it == null` since of `document.all` special case
// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot-aec
module.exports = function (it) {
  return it === null || it === undefined;
};


/***/ }),

/***/ 859:
/***/ (function(module) {

"use strict";

// release references held by exhausted / closed iterator helpers to allow GC of the source chain
module.exports = function (state) {
  state.iterator = state.next = state.nextHandler = state.mapper = state.predicate = state.inner =
    state.iterables = state.iters = state.openIters = state.padding = state.finishResults = state.buffer = null;
};


/***/ }),

/***/ 684:
/***/ (function(module) {

"use strict";

// Should throw an error on invalid iterator
// https://issues.chromium.org/issues/336839115
module.exports = function (methodName, argument) {
  // eslint-disable-next-line es/no-iterator -- required for testing
  var method = typeof Iterator == 'function' && Iterator.prototype[methodName];
  if (method) try {
    method.call({ next: null }, argument).next();
  } catch (error) {
    return true;
  }
};


/***/ }),

/***/ 741:
/***/ (function(module) {

"use strict";

var ceil = Math.ceil;
var floor = Math.floor;

// `Math.trunc` method
// https://tc39.es/ecma262/#sec-math.trunc
// eslint-disable-next-line es/no-math-trunc -- safe
module.exports = Math.trunc || function trunc(x) {
  var n = +x;
  return (n > 0 ? floor : ceil)(n);
};


/***/ }),

/***/ 717:
/***/ (function(__unused_webpack_module, exports) {

"use strict";

// eslint-disable-next-line es/no-object-getownpropertysymbols -- safe
exports.f = Object.getOwnPropertySymbols;


/***/ }),

/***/ 750:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

"use strict";

var isNullOrUndefined = __webpack_require__(117);

var $TypeError = TypeError;

// `RequireObjectCoercible` abstract operation
// https://tc39.es/ecma262/#sec-requireobjectcoercible
module.exports = function (it) {
  if (isNullOrUndefined(it)) throw new $TypeError("Can't call method on " + it);
  return it;
};


/***/ }),

/***/ 291:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

"use strict";

var trunc = __webpack_require__(741);

// `ToIntegerOrInfinity` abstract operation
// https://tc39.es/ecma262/#sec-tointegerorinfinity
module.exports = function (argument) {
  var number = +argument;
  // eslint-disable-next-line no-self-compare -- NaN check
  return number !== number || number === 0 ? 0 : trunc(number);
};


/***/ }),

/***/ 14:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

"use strict";

var toIntegerOrInfinity = __webpack_require__(291);

var min = Math.min;

// `ToLength` abstract operation
// https://tc39.es/ecma262/#sec-tolength
module.exports = function (argument) {
  var len = toIntegerOrInfinity(argument);
  return len > 0 ? min(len, 0x1FFFFFFFFFFFFF) : 0; // 2 ** 53 - 1 == 9007199254740991
};


/***/ }),

/***/ 981:
/***/ (function(module, __unused_webpack_exports, __webpack_require__) {

"use strict";

var requireObjectCoercible = __webpack_require__(750);

var $Object = Object;

// `ToObject` abstract operation
// https://tc39.es/ecma262/#sec-toobject
module.exports = function (argument) {
  return $Object(requireObjectCoercible(argument));
};


/***/ }),

/***/ 823:
/***/ (function(module) {

"use strict";

var $String = String;

module.exports = function (argument) {
  try {
    return $String(argument);
  } catch (error) {
    return 'Object';
  }
};


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			id: moduleId,
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	// getDefaultExport function for compatibility with non-harmony modules
/******/ 	__webpack_require__.n = function(module) {
/******/ 		var getter = module && module.__esModule ?
/******/ 			function() { return module['default']; } :
/******/ 			function() { return module; };
/******/ 		__webpack_require__.d(getter, { a: getter });
/******/ 		return getter;
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/concatenation wrap */
/******/ 	// wrap a concatenated module body as a lazy, memoized accessor; mod is
/******/ 	// set before the body runs so re-entrant calls (require cycles) observe
/******/ 	// the partial exports like Node.js
/******/ 	__webpack_require__.cw = function(body) {
/******/ 		var mod;
/******/ 		return function() {
/******/ 			if (body) {
/******/ 				var fn = body;
/******/ 				body = 0;
/******/ 				mod = { exports: {} };
/******/ 				fn.call(mod.exports, mod, mod.exports);
/******/ 			}
/******/ 			return mod.exports;
/******/ 		};
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	// define getter/value functions for harmony exports
/******/ 	__webpack_require__.d = function(exports, definition) {
/******/ 		for(var key in definition) {
/******/ 			if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ 	
/******/ 	/* webpack/runtime/global */
/******/ 	__webpack_require__.g = (function() {
/******/ 		if (typeof globalThis === 'object') return globalThis;
/******/ 		try {
/******/ 			return this || new Function('return this')();
/******/ 		} catch (e) {
/******/ 			if (typeof window === 'object') return window;
/******/ 		}
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	__webpack_require__.o = function(obj, prop) { return Object.prototype.hasOwnProperty.call(obj, prop); };
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	// define __esModule on exports
/******/ 	__webpack_require__.r = function(exports) {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be in strict mode.
!function() {
"use strict";
// ESM COMPAT FLAG
__webpack_require__.r(__webpack_exports__);

// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  "default": function() { return /* binding */ entry_lib; }
});

// MODULE: ./node_modules/core-js/internals/a-callable.js
var a_callable_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var isCallable = (is_callable_namespaceFn());
var tryToString = (try_to_string_namespaceFn());

var $TypeError = TypeError;

// `Assert: IsCallable(argument) is true`
module.exports = function (argument) {
  if (isCallable(argument)) return argument;
  throw new $TypeError(tryToString(argument) + ' is not a function');
};

});

// MODULE: ./node_modules/core-js/internals/an-instance.js
var an_instance_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var isPrototypeOf = (object_is_prototype_of_namespaceFn());

var $TypeError = TypeError;

module.exports = function (it, Prototype) {
  if (isPrototypeOf(Prototype, it)) return it;
  throw new $TypeError('Incorrect invocation');
};

});

// MODULE: ./node_modules/core-js/internals/an-object.js
var an_object_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var isObject = (is_object_namespaceFn());

var $String = String;
var $TypeError = TypeError;

// `Assert: Type(argument) is Object`
module.exports = function (argument) {
  if (isObject(argument)) return argument;
  throw new $TypeError($String(argument) + ' is not an object');
};

});

// MODULE: ./node_modules/core-js/internals/array-includes.js
var array_includes_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var toIndexedObject = (to_indexed_object_namespaceFn());
var toAbsoluteIndex = (to_absolute_index_namespaceFn());
var lengthOfArrayLike = (length_of_array_like_namespaceFn());

// `Array.prototype.{ indexOf, includes }` methods implementation
var createMethod = function (IS_INCLUDES) {
  return function ($this, el, fromIndex) {
    var O = toIndexedObject($this);
    var length = lengthOfArrayLike(O);
    if (length === 0) return !IS_INCLUDES && -1;
    var index = toAbsoluteIndex(fromIndex, length);
    var value;
    // Array#includes uses SameValueZero equality algorithm
    // eslint-disable-next-line no-self-compare -- NaN check
    if (IS_INCLUDES && el !== el) while (length > index) {
      value = O[index++];
      // eslint-disable-next-line no-self-compare -- NaN check
      if (value !== value) return true;
    // Array#indexOf ignores holes, Array#includes - not
    } else for (;length > index; index++) {
      if ((IS_INCLUDES || index in O) && O[index] === el) return IS_INCLUDES || index || 0;
    } return !IS_INCLUDES && -1;
  };
};

module.exports = {
  // `Array.prototype.includes` method
  // https://tc39.es/ecma262/#sec-array.prototype.includes
  includes: createMethod(true),
  // `Array.prototype.indexOf` method
  // https://tc39.es/ecma262/#sec-array.prototype.indexof
  q: createMethod(false)
};

});

// MODULE: ./node_modules/core-js/internals/call-with-safe-iteration-closing.js
var call_with_safe_iteration_closing_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var anObject = (an_object_namespaceFn());
var iteratorClose = (iterator_close_namespaceFn());

// call something on iterator step with safe closing on error
module.exports = function (iterator, fn, value, ENTRIES) {
  try {
    return ENTRIES ? fn(anObject(value)[0], value[1]) : fn(value);
  } catch (error) {
    iteratorClose(iterator, 'throw', error);
  }
};

});

// MODULE: ./node_modules/core-js/internals/classof-raw.js
var classof_raw_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());

var toString = uncurryThis({}.toString);
var stringSlice = uncurryThis(''.slice);

module.exports = function (it) {
  return stringSlice(toString(it), 8, -1);
};

});

// MODULE: ./node_modules/core-js/internals/copy-constructor-properties.js
var copy_constructor_properties_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var hasOwn = (has_own_property_namespaceFn());
var ownKeys = (own_keys_namespaceFn());
var getOwnPropertyDescriptorModule = (object_get_own_property_descriptor_namespaceFn());
var definePropertyModule = (object_define_property_namespaceFn());

module.exports = function (target, source, exceptions) {
  var keys = ownKeys(source);
  var defineProperty = definePropertyModule.f;
  var getOwnPropertyDescriptor = getOwnPropertyDescriptorModule.f;
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!hasOwn(target, key) && !(exceptions && hasOwn(exceptions, key))) {
      defineProperty(target, key, getOwnPropertyDescriptor(source, key));
    }
  }
};

});

// MODULE: ./node_modules/core-js/internals/correct-prototype-getter.js
var correct_prototype_getter_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var fails = (fails_namespaceFn());

module.exports = !fails(function () {
  function F() { /* empty */ }
  F.prototype.constructor = null;
  // eslint-disable-next-line es/no-object-getprototypeof -- required for testing
  return Object.getPrototypeOf(new F()) !== F.prototype;
});

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/create-iter-result-object.js
var create_iter_result_object_namespaceFn = function() {
	return __webpack_require__(529);
};

// MODULE: ./node_modules/core-js/internals/create-non-enumerable-property.js
var create_non_enumerable_property_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var DESCRIPTORS = (descriptors_namespaceFn());
var definePropertyModule = (object_define_property_namespaceFn());
var createPropertyDescriptor = (create_property_descriptor_namespaceFn());

module.exports = DESCRIPTORS ? function (object, key, value) {
  return definePropertyModule.f(object, key, createPropertyDescriptor(1, value));
} : function (object, key, value) {
  object[key] = value;
  return object;
};

});

// MODULE: ./node_modules/core-js/internals/create-property-descriptor.js
var create_property_descriptor_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

module.exports = function (bitmap, value) {
  return {
    enumerable: !(bitmap & 1),
    configurable: !(bitmap & 2),
    writable: !(bitmap & 4),
    value: value
  };
};

});

// MODULE: ./node_modules/core-js/internals/create-property.js
var create_property_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var DESCRIPTORS = (descriptors_namespaceFn());
var definePropertyModule = (object_define_property_namespaceFn());
var createPropertyDescriptor = (create_property_descriptor_namespaceFn());

module.exports = function (object, key, value) {
  if (DESCRIPTORS) definePropertyModule.f(object, key, createPropertyDescriptor(0, value));
  else object[key] = value;
};

});

// MODULE: ./node_modules/core-js/internals/define-built-in-accessor.js
var define_built_in_accessor_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var makeBuiltIn = (make_built_in_namespaceFn());
var defineProperty = (object_define_property_namespaceFn());

module.exports = function (target, name, descriptor) {
  if (descriptor.get) makeBuiltIn(descriptor.get, name, { getter: true });
  if (descriptor.set) makeBuiltIn(descriptor.set, name, { setter: true });
  return defineProperty.f(target, name, descriptor);
};

});

// MODULE: ./node_modules/core-js/internals/define-built-in.js
var define_built_in_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var isCallable = (is_callable_namespaceFn());
var definePropertyModule = (object_define_property_namespaceFn());
var makeBuiltIn = (make_built_in_namespaceFn());
var defineGlobalProperty = (define_global_property_namespaceFn());

module.exports = function (O, key, value, options) {
  if (!options) options = {};
  var simple = options.enumerable;
  var name = options.name !== undefined ? options.name : key;
  if (isCallable(value)) makeBuiltIn(value, name, options);
  if (options.global) {
    if (simple) O[key] = value;
    else defineGlobalProperty(key, value);
  } else {
    try {
      if (!options.unsafe) delete O[key];
      else if (O[key]) simple = true;
    } catch (error) { /* empty */ }
    if (simple) O[key] = value;
    else definePropertyModule.f(O, key, {
      value: value,
      enumerable: false,
      configurable: !options.nonConfigurable,
      writable: !options.nonWritable
    });
  } return O;
};

});

// MODULE: ./node_modules/core-js/internals/define-built-ins.js
var define_built_ins_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var defineBuiltIn = (define_built_in_namespaceFn());

module.exports = function (target, src, options) {
  for (var key in src) defineBuiltIn(target, key, src[key], options);
  return target;
};

});

// MODULE: ./node_modules/core-js/internals/define-global-property.js
var define_global_property_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());

// eslint-disable-next-line es/no-object-defineproperty -- safe
var defineProperty = Object.defineProperty;

module.exports = function (key, value) {
  try {
    defineProperty(globalThis, key, { value: value, configurable: true, writable: true });
  } catch (error) {
    globalThis[key] = value;
  } return value;
};

});

// MODULE: ./node_modules/core-js/internals/descriptors.js
var descriptors_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var fails = (fails_namespaceFn());

// Detect IE8's incomplete defineProperty implementation
module.exports = !fails(function () {
  // eslint-disable-next-line es/no-object-defineproperty -- required for testing
  return Object.defineProperty({}, 1, { get: function () { return 7; } })[1] !== 7;
});

});

// MODULE: ./node_modules/core-js/internals/document-create-element.js
var document_create_element_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var isObject = (is_object_namespaceFn());

var document = globalThis.document;
// typeof document.createElement is 'object' in old IE
var EXISTS = isObject(document) && isObject(document.createElement);

module.exports = function (it) {
  return EXISTS ? document.createElement(it) : {};
};

});

// MODULE: ./node_modules/core-js/internals/enum-bug-keys.js
var enum_bug_keys_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

// IE8- don't enum bug keys
module.exports = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf'
];

});

// MODULE: ./node_modules/core-js/internals/environment-user-agent.js
var environment_user_agent_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());

var navigator = globalThis.navigator;
var userAgent = navigator && navigator.userAgent;

module.exports = userAgent ? String(userAgent) : '';

});

// MODULE: ./node_modules/core-js/internals/environment-v8-version.js
var environment_v8_version_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var userAgent = (environment_user_agent_namespaceFn());

var process = globalThis.process;
var Deno = globalThis.Deno;
var versions = process && process.versions || Deno && Deno.version;
var v8 = versions && versions.v8;
var match, version;

if (v8) {
  match = v8.split('.');
  // in old Chrome, versions of V8 isn't V8 = Chrome / 10
  // but their correct versions are not interesting for us
  version = match[0] > 0 && match[0] < 4 ? 1 : +(match[0] + match[1]);
}

// BrowserFS NodeJS `process` polyfill incorrectly set `.v8` to `0.0`
// so check `userAgent` even if `.v8` exists, but 0
if (!version && userAgent) {
  match = userAgent.match(/Edge\/(\d+)/);
  if (!match || match[1] >= 74) {
    match = userAgent.match(/Chrome\/(\d+)/);
    if (match) version = +match[1];
  }
}

module.exports = version;

});

// MODULE: ./node_modules/core-js/internals/export.js
var export_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var getOwnPropertyDescriptor = (object_get_own_property_descriptor_namespaceFn().f);
var createNonEnumerableProperty = (create_non_enumerable_property_namespaceFn());
var defineBuiltIn = (define_built_in_namespaceFn());
var defineGlobalProperty = (define_global_property_namespaceFn());
var copyConstructorProperties = (copy_constructor_properties_namespaceFn());
var isForced = (is_forced_namespaceFn());

/*
  options.target         - name of the target object
  options.global         - target is the global object
  options.stat           - export as static methods of target
  options.proto          - export as prototype methods of target
  options.real           - real prototype method for the `pure` version
  options.forced         - export even if the native feature is available
  options.bind           - bind methods to the target, required for the `pure` version
  options.wrap           - wrap constructors to preventing global pollution, required for the `pure` version
  options.unsafe         - use the simple assignment of property instead of delete + defineProperty
  options.sham           - add a flag to not completely full polyfills
  options.enumerable     - export as enumerable property
  options.dontCallGetSet - prevent calling a getter on target
  options.name           - the .name of the function if it does not match the key
*/
module.exports = function (options, source) {
  var TARGET = options.target;
  var GLOBAL = options.global;
  var STATIC = options.stat;
  var FORCED, target, key, targetProperty, sourceProperty, descriptor;
  if (GLOBAL) {
    target = globalThis;
  } else if (STATIC) {
    target = globalThis[TARGET] || defineGlobalProperty(TARGET, {});
  } else {
    target = globalThis[TARGET] && globalThis[TARGET].prototype;
  }
  if (target) for (key in source) {
    sourceProperty = source[key];
    if (options.dontCallGetSet) {
      descriptor = getOwnPropertyDescriptor(target, key);
      targetProperty = descriptor && descriptor.value;
    } else targetProperty = target[key];
    FORCED = isForced(GLOBAL ? key : TARGET + (STATIC ? '.' : '#') + key, options.forced);
    // contained in target
    if (!FORCED && targetProperty !== undefined) {
      if (typeof sourceProperty == typeof targetProperty) continue;
      copyConstructorProperties(sourceProperty, targetProperty);
    }
    // add a flag to not completely full polyfills
    if (options.sham || (targetProperty && targetProperty.sham)) {
      createNonEnumerableProperty(sourceProperty, 'sham', true);
    }
    defineBuiltIn(target, key, sourceProperty, options);
  }
};

});

// MODULE: ./node_modules/core-js/internals/fails.js
var fails_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

module.exports = function (exec) {
  try {
    return !!exec();
  } catch (error) {
    return true;
  }
};

});

// MODULE: ./node_modules/core-js/internals/function-bind-native.js
var function_bind_native_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var fails = (fails_namespaceFn());

module.exports = !fails(function () {
  // eslint-disable-next-line es/no-function-prototype-bind -- safe
  var test = function () { /* empty */ }.bind();
  // eslint-disable-next-line no-prototype-builtins -- safe
  return typeof test != 'function' || test.hasOwnProperty('prototype');
});

});

// MODULE: ./node_modules/core-js/internals/function-call.js
var function_call_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var NATIVE_BIND = (function_bind_native_namespaceFn());

var call = Function.prototype.call;
// eslint-disable-next-line es/no-function-prototype-bind -- safe
module.exports = NATIVE_BIND ? call.bind(call) : function () {
  return call.apply(call, arguments);
};

});

// MODULE: ./node_modules/core-js/internals/function-name.js
var function_name_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var DESCRIPTORS = (descriptors_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());

var FunctionPrototype = Function.prototype;
// eslint-disable-next-line es/no-object-getownpropertydescriptor -- safe
var getDescriptor = DESCRIPTORS && Object.getOwnPropertyDescriptor;

var EXISTS = hasOwn(FunctionPrototype, 'name');
// additional protection from minified / mangled / dropped function names
var PROPER = EXISTS && function something() { /* empty */ }.name === 'something';
var CONFIGURABLE = EXISTS && (!DESCRIPTORS || (DESCRIPTORS && getDescriptor(FunctionPrototype, 'name').configurable));

module.exports = {
  EXISTS: EXISTS,
  PROPER: PROPER,
  i2: CONFIGURABLE
};

});

// MODULE: ./node_modules/core-js/internals/function-uncurry-this.js
var function_uncurry_this_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var NATIVE_BIND = (function_bind_native_namespaceFn());

var FunctionPrototype = Function.prototype;
var call = FunctionPrototype.call;
// eslint-disable-next-line es/no-function-prototype-bind -- safe
var uncurryThisWithBind = NATIVE_BIND && FunctionPrototype.bind.bind(call, call);

module.exports = NATIVE_BIND ? uncurryThisWithBind : function (fn) {
  return function () {
    return call.apply(fn, arguments);
  };
};

});

// MODULE: ./node_modules/core-js/internals/get-built-in.js
var get_built_in_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var isCallable = (is_callable_namespaceFn());

var aFunction = function (argument) {
  return isCallable(argument) ? argument : undefined;
};

module.exports = function (namespace, method) {
  return arguments.length < 2 ? aFunction(globalThis[namespace]) : globalThis[namespace] && globalThis[namespace][method];
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/get-iterator-direct.js
var get_iterator_direct_namespaceFn = function() {
	return __webpack_require__(767);
};

// MODULE: ./node_modules/core-js/internals/get-method.js
var get_method_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var aCallable = (a_callable_namespaceFn());
var isNullOrUndefined = (is_null_or_undefined_namespaceFn());

// `GetMethod` abstract operation
// https://tc39.es/ecma262/#sec-getmethod
module.exports = function (V, P) {
  var func = V[P];
  return isNullOrUndefined(func) ? undefined : aCallable(func);
};

});

// MODULE: ./node_modules/core-js/internals/global-this.js
var global_this_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var check = function (it) {
  return it && it.Math === Math && it;
};

// https://github.com/zloirock/core-js/issues/86#issuecomment-115759028
module.exports =
  // eslint-disable-next-line es/no-global-this -- safe
  check(typeof globalThis == 'object' && globalThis) ||
  check(typeof window == 'object' && window) ||
  // eslint-disable-next-line no-restricted-globals -- safe
  check(typeof self == 'object' && self) ||
  check(typeof __webpack_require__.g == 'object' && __webpack_require__.g) ||
  check(typeof this == 'object' && this) ||
  // eslint-disable-next-line no-new-func -- fallback
  (function () { return this; })() || Function('return this')();

});

// MODULE: ./node_modules/core-js/internals/has-own-property.js
var has_own_property_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());
var toObject = (to_object_namespaceFn());

var hasOwnProperty = uncurryThis({}.hasOwnProperty);

// `HasOwnProperty` abstract operation
// https://tc39.es/ecma262/#sec-hasownproperty
// eslint-disable-next-line es/no-object-hasown -- safe
module.exports = Object.hasOwn || function hasOwn(it, key) {
  return hasOwnProperty(toObject(it), key);
};

});

// MODULE: ./node_modules/core-js/internals/hidden-keys.js
var hidden_keys_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

module.exports = {};

});

// MODULE: ./node_modules/core-js/internals/html.js
var html_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var getBuiltIn = (get_built_in_namespaceFn());

module.exports = getBuiltIn('document', 'documentElement');

});

// MODULE: ./node_modules/core-js/internals/ie8-dom-define.js
var ie8_dom_define_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var DESCRIPTORS = (descriptors_namespaceFn());
var fails = (fails_namespaceFn());
var createElement = (document_create_element_namespaceFn());

// Thanks to IE8 for its funny defineProperty
module.exports = !DESCRIPTORS && !fails(function () {
  // eslint-disable-next-line es/no-object-defineproperty -- required for testing
  return Object.defineProperty(createElement('div'), 'a', {
    get: function () { return 7; }
  }).a !== 7;
});

});

// MODULE: ./node_modules/core-js/internals/indexed-object.js
var indexed_object_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());
var fails = (fails_namespaceFn());
var classof = (classof_raw_namespaceFn());

var $Object = Object;
var split = uncurryThis(''.split);

// fallback for non-array-like ES3 and non-enumerable old V8 strings
module.exports = fails(function () {
  // throws an error in rhino, see https://github.com/mozilla/rhino/issues/346
  // eslint-disable-next-line no-prototype-builtins -- safe
  return !$Object('z').propertyIsEnumerable(0);
}) ? function (it) {
  return classof(it) === 'String' ? split(it, '') : $Object(it);
} : $Object;

});

// MODULE: ./node_modules/core-js/internals/inspect-source.js
var inspect_source_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var store = (shared_store_namespaceFn());

var functionToString = uncurryThis(Function.toString);

// this helper broken in `core-js@3.4.1-3.4.4`, so we can't use `shared` helper
if (!isCallable(store.inspectSource)) {
  store.inspectSource = function (it) {
    return functionToString(it);
  };
}

module.exports = store.inspectSource;

});

// MODULE: ./node_modules/core-js/internals/internal-state.js
var internal_state_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var NATIVE_WEAK_MAP = (weak_map_basic_detection_namespaceFn());
var globalThis = (global_this_namespaceFn());
var isObject = (is_object_namespaceFn());
var createNonEnumerableProperty = (create_non_enumerable_property_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var shared = (shared_store_namespaceFn());
var sharedKey = (shared_key_namespaceFn());
var hiddenKeys = (hidden_keys_namespaceFn());

var OBJECT_ALREADY_INITIALIZED = 'Object already initialized';
var TypeError = globalThis.TypeError;
var WeakMap = globalThis.WeakMap;
var set, get, has;

var enforce = function (it) {
  return has(it) ? get(it) : set(it, {});
};

var getterFor = function (TYPE) {
  return function (it) {
    var state;
    if (!isObject(it) || (state = get(it)).type !== TYPE) {
      throw new TypeError('Incompatible receiver, ' + TYPE + ' required');
    } return state;
  };
};

if (NATIVE_WEAK_MAP || shared.state) {
  var store = shared.state || (shared.state = new WeakMap());
  /* eslint-disable no-self-assign -- prototype methods protection */
  store.get = store.get;
  store.has = store.has;
  store.set = store.set;
  /* eslint-enable no-self-assign -- prototype methods protection */
  set = function (it, metadata) {
    if (store.has(it)) throw new TypeError(OBJECT_ALREADY_INITIALIZED);
    metadata.facade = it;
    store.set(it, metadata);
    return metadata;
  };
  get = function (it) {
    return store.get(it) || {};
  };
  has = function (it) {
    return store.has(it);
  };
} else {
  var STATE = sharedKey('state');
  hiddenKeys[STATE] = true;
  set = function (it, metadata) {
    if (hasOwn(it, STATE)) throw new TypeError(OBJECT_ALREADY_INITIALIZED);
    metadata.facade = it;
    createNonEnumerableProperty(it, STATE, metadata);
    return metadata;
  };
  get = function (it) {
    return hasOwn(it, STATE) ? it[STATE] : {};
  };
  has = function (it) {
    return hasOwn(it, STATE);
  };
}

module.exports = {
  set: set,
  get: get,
  has: has,
  enforce: enforce,
  getterFor: getterFor
};

});

// MODULE: ./node_modules/core-js/internals/is-callable.js
var is_callable_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

// https://tc39.es/ecma262/#sec-IsHTMLDDA-internal-slot
var documentAll = typeof document == 'object' && document.all;

// `IsCallable` abstract operation
// https://tc39.es/ecma262/#sec-iscallable
// eslint-disable-next-line unicorn/no-typeof-undefined -- required for testing
module.exports = typeof documentAll == 'undefined' && documentAll !== undefined ? function (argument) {
  return typeof argument == 'function' || argument === documentAll;
} : function (argument) {
  return typeof argument == 'function';
};

});

// MODULE: ./node_modules/core-js/internals/is-forced.js
var is_forced_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var fails = (fails_namespaceFn());
var isCallable = (is_callable_namespaceFn());

var replacement = /#|\.prototype\./;

var isForced = function (feature, detection) {
  var value = data[normalize(feature)];
  return value === POLYFILL ? true
    : value === NATIVE ? false
    : isCallable(detection) ? fails(detection)
    : !!detection;
};

var normalize = isForced.normalize = function (string) {
  return String(string).replace(replacement, '.').toLowerCase();
};

var data = isForced.data = {};
var NATIVE = isForced.NATIVE = 'N';
var POLYFILL = isForced.POLYFILL = 'P';

module.exports = isForced;

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/is-null-or-undefined.js
var is_null_or_undefined_namespaceFn = function() {
	return __webpack_require__(117);
};

// MODULE: ./node_modules/core-js/internals/is-object.js
var is_object_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var isCallable = (is_callable_namespaceFn());

module.exports = function (it) {
  return typeof it == 'object' ? it !== null : isCallable(it);
};

});

// MODULE: ./node_modules/core-js/internals/is-pure.js
var is_pure_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

module.exports = false;

});

// MODULE: ./node_modules/core-js/internals/is-symbol.js
var is_symbol_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var getBuiltIn = (get_built_in_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var isPrototypeOf = (object_is_prototype_of_namespaceFn());
var USE_SYMBOL_AS_UID = (use_symbol_as_uid_namespaceFn());

var $Object = Object;

module.exports = USE_SYMBOL_AS_UID ? function (it) {
  return typeof it == 'symbol';
} : function (it) {
  var $Symbol = getBuiltIn('Symbol');
  return isCallable($Symbol) && isPrototypeOf($Symbol.prototype, $Object(it));
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/iterator-cleanup-state.js
var iterator_cleanup_state_namespaceFn = function() {
	return __webpack_require__(859);
};

// MODULE: ./node_modules/core-js/internals/iterator-close-all.js
var iterator_close_all_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var iteratorClose = (iterator_close_namespaceFn());

module.exports = function (iters, kind, value) {
  for (var i = iters.length - 1; i >= 0; i--) {
    if (iters[i] === undefined) continue;
    try {
      value = iteratorClose(iters[i].iterator, kind, value);
    } catch (error) {
      kind = 'throw';
      value = error;
    }
  }
  if (kind === 'throw') throw value;
  return value;
};

});

// MODULE: ./node_modules/core-js/internals/iterator-close.js
var iterator_close_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var call = (function_call_namespaceFn());
var anObject = (an_object_namespaceFn());
var getMethod = (get_method_namespaceFn());

module.exports = function (iterator, kind, value) {
  var innerResult, innerError;
  anObject(iterator);
  try {
    innerResult = getMethod(iterator, 'return');
    if (!innerResult) {
      if (kind === 'throw') throw value;
      return value;
    }
    innerResult = call(innerResult, iterator);
  } catch (error) {
    innerError = true;
    innerResult = error;
  }
  if (kind === 'throw') throw value;
  if (innerError) throw innerResult;
  anObject(innerResult);
  return value;
};

});

// MODULE: ./node_modules/core-js/internals/iterator-create-proxy.js
var iterator_create_proxy_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var call = (function_call_namespaceFn());
var create = (object_create_namespaceFn());
var createNonEnumerableProperty = (create_non_enumerable_property_namespaceFn());
var defineBuiltIns = (define_built_ins_namespaceFn());
var wellKnownSymbol = (well_known_symbol_namespaceFn());
var InternalStateModule = (internal_state_namespaceFn());
var getMethod = (get_method_namespaceFn());
var IteratorPrototype = (iterators_core_namespaceFn().H);
var createIterResultObject = (create_iter_result_object_namespaceFn());
var iteratorClose = (iterator_close_namespaceFn());
var iteratorCloseAll = (iterator_close_all_namespaceFn());
var cleanupState = (iterator_cleanup_state_namespaceFn());

var TO_STRING_TAG = wellKnownSymbol('toStringTag');
var ITERATOR_HELPER = 'IteratorHelper';
var WRAP_FOR_VALID_ITERATOR = 'WrapForValidIterator';
var NORMAL = 'normal';
var THROW = 'throw';
var setInternalState = InternalStateModule.set;

var createIteratorProxyPrototype = function (IS_ITERATOR) {
  var getInternalState = InternalStateModule.getterFor(IS_ITERATOR ? WRAP_FOR_VALID_ITERATOR : ITERATOR_HELPER);

  return defineBuiltIns(create(IteratorPrototype), {
    next: function next() {
      var state = getInternalState(this);
      // for simplification:
      //   for `%WrapForValidIteratorPrototype%.next` or with `state.returnHandlerResult` our `nextHandler` returns `IterResultObject`
      //   for `%IteratorHelperPrototype%.next` - just a value
      if (IS_ITERATOR) return state.nextHandler();
      if (state.done) return createIterResultObject(undefined, true);
      try {
        var result = state.nextHandler();
        if (state.done) cleanupState(state);
        return state.returnHandlerResult ? result : createIterResultObject(result, state.done);
      } catch (error) {
        state.done = true;
        cleanupState(state);
        throw error;
      }
    },
    'return': function () {
      var state = getInternalState(this);
      var iterator = state.iterator;
      var inner = state.inner;
      var openIters = state.openIters;
      var done = state.done;
      state.done = true;
      if (IS_ITERATOR) {
        var returnMethod = getMethod(iterator, 'return');
        return returnMethod ? call(returnMethod, iterator) : createIterResultObject(undefined, true);
      }
      cleanupState(state);
      if (done) return createIterResultObject(undefined, true);
      if (inner) try {
        iteratorClose(inner.iterator, NORMAL);
      } catch (error) {
        return iteratorClose(iterator, THROW, error);
      }
      if (openIters) try {
        iteratorCloseAll(openIters, NORMAL);
      } catch (error) {
        if (iterator) return iteratorClose(iterator, THROW, error);
        throw error;
      }
      if (iterator) iteratorClose(iterator, NORMAL);
      return createIterResultObject(undefined, true);
    }
  });
};

var WrapForValidIteratorPrototype = createIteratorProxyPrototype(true);
var IteratorHelperPrototype = createIteratorProxyPrototype(false);

createNonEnumerableProperty(IteratorHelperPrototype, TO_STRING_TAG, 'Iterator Helper');

module.exports = function (nextHandler, IS_ITERATOR, RETURN_HANDLER_RESULT) {
  var IteratorProxy = function Iterator(record, state) {
    if (state) {
      state.iterator = record.iterator;
      state.next = record.next;
    } else state = record;
    state.type = IS_ITERATOR ? WRAP_FOR_VALID_ITERATOR : ITERATOR_HELPER;
    state.returnHandlerResult = !!RETURN_HANDLER_RESULT;
    state.nextHandler = nextHandler;
    state.counter = 0;
    state.done = false;
    setInternalState(this, state);
  };

  IteratorProxy.prototype = IS_ITERATOR ? WrapForValidIteratorPrototype : IteratorHelperPrototype;

  return IteratorProxy;
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/iterator-helper-throws-on-invalid-iterator.js
var iterator_helper_throws_on_invalid_iterator_namespaceFn = function() {
	return __webpack_require__(684);
};

// MODULE: ./node_modules/core-js/internals/iterator-helper-without-closing-on-early-error.js
var iterator_helper_without_closing_on_early_error_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());

// https://github.com/tc39/ecma262/pull/3467
module.exports = function (METHOD_NAME, ExpectedError) {
  var Iterator = globalThis.Iterator;
  var IteratorPrototype = Iterator && Iterator.prototype;
  var method = IteratorPrototype && IteratorPrototype[METHOD_NAME];

  var CLOSED = false;

  if (method) try {
    method.call({
      next: function () { return { done: true }; },
      'return': function () { CLOSED = true; }
    }, -1);
  } catch (error) {
    // https://bugs.webkit.org/show_bug.cgi?id=291195
    if (!(error instanceof ExpectedError)) CLOSED = false;
  }

  if (!CLOSED) return method;
};

});

// MODULE: ./node_modules/core-js/internals/iterators-core.js
var iterators_core_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var fails = (fails_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var isObject = (is_object_namespaceFn());
var create = (object_create_namespaceFn());
var getPrototypeOf = (object_get_prototype_of_namespaceFn());
var defineBuiltIn = (define_built_in_namespaceFn());
var wellKnownSymbol = (well_known_symbol_namespaceFn());
var IS_PURE = (is_pure_namespaceFn());

var ITERATOR = wellKnownSymbol('iterator');
var BUGGY_SAFARI_ITERATORS = false;

// `%IteratorPrototype%` object
// https://tc39.es/ecma262/#sec-%iteratorprototype%-object
var IteratorPrototype, PrototypeOfArrayIteratorPrototype, arrayIterator;

/* eslint-disable es/no-array-prototype-keys -- safe */
if ([].keys) {
  arrayIterator = [].keys();
  // Safari 8 has buggy iterators w/o `next`
  if (!('next' in arrayIterator)) BUGGY_SAFARI_ITERATORS = true;
  else {
    PrototypeOfArrayIteratorPrototype = getPrototypeOf(getPrototypeOf(arrayIterator));
    if (PrototypeOfArrayIteratorPrototype !== Object.prototype) IteratorPrototype = PrototypeOfArrayIteratorPrototype;
  }
}

var NEW_ITERATOR_PROTOTYPE = !isObject(IteratorPrototype) || fails(function () {
  var test = {};
  // FF44- legacy iterators case
  return IteratorPrototype[ITERATOR].call(test) !== test;
});

if (NEW_ITERATOR_PROTOTYPE) IteratorPrototype = {};
else if (IS_PURE) IteratorPrototype = create(IteratorPrototype);

// `%IteratorPrototype%[@@iterator]()` method
// https://tc39.es/ecma262/#sec-%iteratorprototype%-@@iterator
if (!isCallable(IteratorPrototype[ITERATOR])) {
  defineBuiltIn(IteratorPrototype, ITERATOR, function () {
    return this;
  });
}

module.exports = {
  H: IteratorPrototype,
  BUGGY_SAFARI_ITERATORS: BUGGY_SAFARI_ITERATORS
};

});

// MODULE: ./node_modules/core-js/internals/length-of-array-like.js
var length_of_array_like_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var toLength = (to_length_namespaceFn());

// `LengthOfArrayLike` abstract operation
// https://tc39.es/ecma262/#sec-lengthofarraylike
module.exports = function (obj) {
  return toLength(obj.length);
};

});

// MODULE: ./node_modules/core-js/internals/make-built-in.js
var make_built_in_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());
var fails = (fails_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var DESCRIPTORS = (descriptors_namespaceFn());
var CONFIGURABLE_FUNCTION_NAME = (function_name_namespaceFn().i2);
var inspectSource = (inspect_source_namespaceFn());
var InternalStateModule = (internal_state_namespaceFn());

var enforceInternalState = InternalStateModule.enforce;
var getInternalState = InternalStateModule.get;
var $String = String;
// eslint-disable-next-line es/no-object-defineproperty -- safe
var defineProperty = Object.defineProperty;
var stringSlice = uncurryThis(''.slice);
var replace = uncurryThis(''.replace);
var join = uncurryThis([].join);

var CONFIGURABLE_LENGTH = DESCRIPTORS && !fails(function () {
  return defineProperty(function () { /* empty */ }, 'length', { value: 8 }).length !== 8;
});

var TEMPLATE = String(String).split('String');

var makeBuiltIn = module.exports = function (value, name, options) {
  if (stringSlice($String(name), 0, 7) === 'Symbol(') {
    name = '[' + replace($String(name), /^Symbol\(([^)]*)\).*$/, '$1') + ']';
  }
  if (options && options.getter) name = 'get ' + name;
  if (options && options.setter) name = 'set ' + name;
  if (!hasOwn(value, 'name') || (CONFIGURABLE_FUNCTION_NAME && value.name !== name)) {
    if (DESCRIPTORS) defineProperty(value, 'name', { value: name, configurable: true });
    else value.name = name;
  }
  if (CONFIGURABLE_LENGTH && options && hasOwn(options, 'arity') && value.length !== options.arity) {
    defineProperty(value, 'length', { value: options.arity });
  }
  try {
    if (options && hasOwn(options, 'constructor') && options.constructor) {
      if (DESCRIPTORS) defineProperty(value, 'prototype', { writable: false });
    // in V8 ~ Chrome 53, prototypes of some methods, like `Array.prototype.values`, are non-writable
    } else if (value.prototype) value.prototype = undefined;
  } catch (error) { /* empty */ }
  var state = enforceInternalState(value);
  if (!hasOwn(state, 'source')) {
    state.source = join(TEMPLATE, typeof name == 'string' ? name : '');
  } return value;
};

// add fake Function#toString for correct work wrapped methods / constructors with methods like LoDash isNative
// eslint-disable-next-line no-extend-native -- required
Function.prototype.toString = makeBuiltIn(function toString() {
  return isCallable(this) && getInternalState(this).source || inspectSource(this);
}, 'toString');

});

// MODULE: ./node_modules/core-js/internals/object-create.js
var object_create_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

/* global ActiveXObject -- old IE, WSH */
var anObject = (an_object_namespaceFn());
var definePropertiesModule = (object_define_properties_namespaceFn());
var enumBugKeys = (enum_bug_keys_namespaceFn());
var hiddenKeys = (hidden_keys_namespaceFn());
var html = (html_namespaceFn());
var documentCreateElement = (document_create_element_namespaceFn());
var sharedKey = (shared_key_namespaceFn());

var GT = '>';
var LT = '<';
var PROTOTYPE = 'prototype';
var SCRIPT = 'script';
var IE_PROTO = sharedKey('IE_PROTO');

var EmptyConstructor = function () { /* empty */ };

var scriptTag = function (content) {
  return LT + SCRIPT + GT + content + LT + '/' + SCRIPT + GT;
};

// Create object with fake `null` prototype: use ActiveX Object with cleared prototype
var NullProtoObjectViaActiveX = function (activeXDocument) {
  activeXDocument.write(scriptTag(''));
  activeXDocument.close();
  var temp = activeXDocument.parentWindow.Object;
  // eslint-disable-next-line no-useless-assignment -- avoid memory leak
  activeXDocument = null;
  return temp;
};

// Create object with fake `null` prototype: use iframe Object with cleared prototype
var NullProtoObjectViaIFrame = function () {
  // Thrash, waste and sodomy: IE GC bug
  var iframe = documentCreateElement('iframe');
  var JS = 'java' + SCRIPT + ':';
  var iframeDocument;
  iframe.style.display = 'none';
  html.appendChild(iframe);
  // https://github.com/zloirock/core-js/issues/475
  iframe.src = String(JS);
  iframeDocument = iframe.contentWindow.document;
  iframeDocument.open();
  iframeDocument.write(scriptTag('document.F=Object'));
  iframeDocument.close();
  return iframeDocument.F;
};

// Check for document.domain and active x support
// No need to use active x approach when document.domain is not set
// see https://github.com/es-shims/es5-shim/issues/150
// variation of https://github.com/kitcambridge/es5-shim/commit/4f738ac066346
// avoid IE GC bug
var activeXDocument;
var NullProtoObject = function () {
  try {
    activeXDocument = new ActiveXObject('htmlfile');
  } catch (error) { /* ignore */ }
  NullProtoObject = typeof document != 'undefined'
    ? document.domain && activeXDocument
      ? NullProtoObjectViaActiveX(activeXDocument) // old IE
      : NullProtoObjectViaIFrame()
    : NullProtoObjectViaActiveX(activeXDocument); // WSH
  var length = enumBugKeys.length;
  while (length--) delete NullProtoObject[PROTOTYPE][enumBugKeys[length]];
  return NullProtoObject();
};

hiddenKeys[IE_PROTO] = true;

// `Object.create` method
// https://tc39.es/ecma262/#sec-object.create
// eslint-disable-next-line es/no-object-create -- safe
module.exports = Object.create || function create(O, Properties) {
  var result;
  if (O !== null) {
    EmptyConstructor[PROTOTYPE] = anObject(O);
    result = new EmptyConstructor();
    EmptyConstructor[PROTOTYPE] = null;
    // add "__proto__" for Object.getPrototypeOf polyfill
    result[IE_PROTO] = O;
  } else result = NullProtoObject();
  return Properties === undefined ? result : definePropertiesModule.f(result, Properties);
};

});

// MODULE: ./node_modules/core-js/internals/object-define-properties.js
var object_define_properties_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(__unused_webpack_module, exports) {

var DESCRIPTORS = (descriptors_namespaceFn());
var V8_PROTOTYPE_DEFINE_BUG = (v8_prototype_define_bug_namespaceFn());
var definePropertyModule = (object_define_property_namespaceFn());
var anObject = (an_object_namespaceFn());
var toIndexedObject = (to_indexed_object_namespaceFn());
var objectKeys = (object_keys_namespaceFn());

// `Object.defineProperties` method
// https://tc39.es/ecma262/#sec-object.defineproperties
// eslint-disable-next-line es/no-object-defineproperties -- safe
exports.f = DESCRIPTORS && !V8_PROTOTYPE_DEFINE_BUG ? Object.defineProperties : function defineProperties(O, Properties) {
  anObject(O);
  var props = toIndexedObject(Properties);
  var keys = objectKeys(Properties);
  var length = keys.length;
  var index = 0;
  var key;
  while (length > index) definePropertyModule.f(O, key = keys[index++], props[key]);
  return O;
};

});

// MODULE: ./node_modules/core-js/internals/object-define-property.js
var object_define_property_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(__unused_webpack_module, exports) {

var DESCRIPTORS = (descriptors_namespaceFn());
var IE8_DOM_DEFINE = (ie8_dom_define_namespaceFn());
var V8_PROTOTYPE_DEFINE_BUG = (v8_prototype_define_bug_namespaceFn());
var anObject = (an_object_namespaceFn());
var toPropertyKey = (to_property_key_namespaceFn());

var $TypeError = TypeError;
// eslint-disable-next-line es/no-object-defineproperty -- safe
var $defineProperty = Object.defineProperty;
// eslint-disable-next-line es/no-object-getownpropertydescriptor -- safe
var $getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var ENUMERABLE = 'enumerable';
var CONFIGURABLE = 'configurable';
var WRITABLE = 'writable';

// `Object.defineProperty` method
// https://tc39.es/ecma262/#sec-object.defineproperty
exports.f = DESCRIPTORS ? V8_PROTOTYPE_DEFINE_BUG ? function defineProperty(O, P, Attributes) {
  anObject(O);
  P = toPropertyKey(P);
  anObject(Attributes);
  if (typeof O === 'function' && P === 'prototype' && 'value' in Attributes && WRITABLE in Attributes && !Attributes[WRITABLE]) {
    var current = $getOwnPropertyDescriptor(O, P);
    if (current && current[WRITABLE]) {
      O[P] = Attributes.value;
      Attributes = {
        configurable: CONFIGURABLE in Attributes ? Attributes[CONFIGURABLE] : current[CONFIGURABLE],
        enumerable: ENUMERABLE in Attributes ? Attributes[ENUMERABLE] : current[ENUMERABLE],
        writable: false
      };
    }
  } return $defineProperty(O, P, Attributes);
} : $defineProperty : function defineProperty(O, P, Attributes) {
  anObject(O);
  P = toPropertyKey(P);
  anObject(Attributes);
  if (IE8_DOM_DEFINE) try {
    return $defineProperty(O, P, Attributes);
  } catch (error) { /* empty */ }
  if ('get' in Attributes || 'set' in Attributes) throw new $TypeError('Accessors not supported');
  if ('value' in Attributes) O[P] = Attributes.value;
  return O;
};

});

// MODULE: ./node_modules/core-js/internals/object-get-own-property-descriptor.js
var object_get_own_property_descriptor_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(__unused_webpack_module, exports) {

var DESCRIPTORS = (descriptors_namespaceFn());
var call = (function_call_namespaceFn());
var propertyIsEnumerableModule = (object_property_is_enumerable_namespaceFn());
var createPropertyDescriptor = (create_property_descriptor_namespaceFn());
var toIndexedObject = (to_indexed_object_namespaceFn());
var toPropertyKey = (to_property_key_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var IE8_DOM_DEFINE = (ie8_dom_define_namespaceFn());

// eslint-disable-next-line es/no-object-getownpropertydescriptor -- safe
var $getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

// `Object.getOwnPropertyDescriptor` method
// https://tc39.es/ecma262/#sec-object.getownpropertydescriptor
exports.f = DESCRIPTORS ? $getOwnPropertyDescriptor : function getOwnPropertyDescriptor(O, P) {
  O = toIndexedObject(O);
  P = toPropertyKey(P);
  if (IE8_DOM_DEFINE) try {
    return $getOwnPropertyDescriptor(O, P);
  } catch (error) { /* empty */ }
  if (hasOwn(O, P)) return createPropertyDescriptor(!call(propertyIsEnumerableModule.f, O, P), O[P]);
};

});

// MODULE: ./node_modules/core-js/internals/object-get-own-property-names.js
var object_get_own_property_names_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(__unused_webpack_module, exports) {

var internalObjectKeys = (object_keys_internal_namespaceFn());
var enumBugKeys = (enum_bug_keys_namespaceFn());

var hiddenKeys = enumBugKeys.concat('length', 'prototype');

// `Object.getOwnPropertyNames` method
// https://tc39.es/ecma262/#sec-object.getownpropertynames
// eslint-disable-next-line es/no-object-getownpropertynames -- safe
exports.f = Object.getOwnPropertyNames || function getOwnPropertyNames(O) {
  return internalObjectKeys(O, hiddenKeys);
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/object-get-own-property-symbols.js
var object_get_own_property_symbols_namespaceFn = function() {
	return __webpack_require__(717);
};

// MODULE: ./node_modules/core-js/internals/object-get-prototype-of.js
var object_get_prototype_of_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var hasOwn = (has_own_property_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var toObject = (to_object_namespaceFn());
var sharedKey = (shared_key_namespaceFn());
var CORRECT_PROTOTYPE_GETTER = (correct_prototype_getter_namespaceFn());

var IE_PROTO = sharedKey('IE_PROTO');
var $Object = Object;
var ObjectPrototype = $Object.prototype;

// `Object.getPrototypeOf` method
// https://tc39.es/ecma262/#sec-object.getprototypeof
// eslint-disable-next-line es/no-object-getprototypeof -- safe
module.exports = CORRECT_PROTOTYPE_GETTER ? $Object.getPrototypeOf : function (O) {
  var object = toObject(O);
  if (hasOwn(object, IE_PROTO)) return object[IE_PROTO];
  var constructor = object.constructor;
  if (isCallable(constructor) && object instanceof constructor) {
    return constructor.prototype;
  } return object instanceof $Object ? ObjectPrototype : null;
};

});

// MODULE: ./node_modules/core-js/internals/object-is-prototype-of.js
var object_is_prototype_of_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());

module.exports = uncurryThis({}.isPrototypeOf);

});

// MODULE: ./node_modules/core-js/internals/object-keys-internal.js
var object_keys_internal_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var toIndexedObject = (to_indexed_object_namespaceFn());
var indexOf = (array_includes_namespaceFn().q);
var hiddenKeys = (hidden_keys_namespaceFn());

var push = uncurryThis([].push);

module.exports = function (object, names) {
  var O = toIndexedObject(object);
  var i = 0;
  var result = [];
  var key;
  for (key in O) !hasOwn(hiddenKeys, key) && hasOwn(O, key) && push(result, key);
  // Don't enum bug & hidden keys
  while (names.length > i) if (hasOwn(O, key = names[i++])) {
    ~indexOf(result, key) || push(result, key);
  }
  return result;
};

});

// MODULE: ./node_modules/core-js/internals/object-keys.js
var object_keys_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var internalObjectKeys = (object_keys_internal_namespaceFn());
var enumBugKeys = (enum_bug_keys_namespaceFn());

// `Object.keys` method
// https://tc39.es/ecma262/#sec-object.keys
// eslint-disable-next-line es/no-object-keys -- safe
module.exports = Object.keys || function keys(O) {
  return internalObjectKeys(O, enumBugKeys);
};

});

// MODULE: ./node_modules/core-js/internals/object-property-is-enumerable.js
var object_property_is_enumerable_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(__unused_webpack_module, exports) {

var $propertyIsEnumerable = {}.propertyIsEnumerable;
// eslint-disable-next-line es/no-object-getownpropertydescriptor -- safe
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

// Nashorn ~ JDK8 bug
var NASHORN_BUG = getOwnPropertyDescriptor && !$propertyIsEnumerable.call({ 1: 2 }, 1);

// `Object.prototype.propertyIsEnumerable` method implementation
// https://tc39.es/ecma262/#sec-object.prototype.propertyisenumerable
exports.f = NASHORN_BUG ? function propertyIsEnumerable(V) {
  var descriptor = getOwnPropertyDescriptor(this, V);
  return !!descriptor && descriptor.enumerable;
} : $propertyIsEnumerable;

});

// MODULE: ./node_modules/core-js/internals/ordinary-to-primitive.js
var ordinary_to_primitive_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var call = (function_call_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var isObject = (is_object_namespaceFn());

var $TypeError = TypeError;

// `OrdinaryToPrimitive` abstract operation
// https://tc39.es/ecma262/#sec-ordinarytoprimitive
module.exports = function (input, pref) {
  var fn, val;
  if (pref === 'string' && isCallable(fn = input.toString) && !isObject(val = call(fn, input))) return val;
  if (isCallable(fn = input.valueOf) && !isObject(val = call(fn, input))) return val;
  if (pref !== 'string' && isCallable(fn = input.toString) && !isObject(val = call(fn, input))) return val;
  throw new $TypeError("Can't convert object to primitive value");
};

});

// MODULE: ./node_modules/core-js/internals/own-keys.js
var own_keys_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var getBuiltIn = (get_built_in_namespaceFn());
var uncurryThis = (function_uncurry_this_namespaceFn());
var getOwnPropertyNamesModule = (object_get_own_property_names_namespaceFn());
var getOwnPropertySymbolsModule = (object_get_own_property_symbols_namespaceFn());
var anObject = (an_object_namespaceFn());

var concat = uncurryThis([].concat);

// all object keys, includes non-enumerable and symbols
module.exports = getBuiltIn('Reflect', 'ownKeys') || function ownKeys(it) {
  var keys = getOwnPropertyNamesModule.f(anObject(it));
  var getOwnPropertySymbols = getOwnPropertySymbolsModule.f;
  return getOwnPropertySymbols ? concat(keys, getOwnPropertySymbols(it)) : keys;
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/require-object-coercible.js
var require_object_coercible_namespaceFn = function() {
	return __webpack_require__(750);
};

// MODULE: ./node_modules/core-js/internals/shared-key.js
var shared_key_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var shared = (shared_namespaceFn());
var uid = (uid_namespaceFn());

var keys = shared('keys');

module.exports = function (key) {
  return keys[key] || (keys[key] = uid(key));
};

});

// MODULE: ./node_modules/core-js/internals/shared-store.js
var shared_store_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var IS_PURE = (is_pure_namespaceFn());
var globalThis = (global_this_namespaceFn());
var defineGlobalProperty = (define_global_property_namespaceFn());

var SHARED = '__core-js_shared__';
var store = module.exports = globalThis[SHARED] || defineGlobalProperty(SHARED, {});

(store.versions || (store.versions = [])).push({
  version: '3.51.0',
  mode: IS_PURE ? 'pure' : 'global',
  copyright: '© 2013–2025 Denis Pushkarev (zloirock.ru), 2025–2026 CoreJS Company (core-js.io). All rights reserved.',
  license: 'https://github.com/zloirock/core-js/blob/v3.51.0/LICENSE',
  source: 'https://github.com/zloirock/core-js'
});

});

// MODULE: ./node_modules/core-js/internals/shared.js
var shared_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var store = (shared_store_namespaceFn());
// eslint-disable-next-line es/no-object-create -- safe
var create = Object.create || Object;

module.exports = function (key, value) {
  return store[key] || (store[key] = value || create(null));
};

});

// MODULE: ./node_modules/core-js/internals/symbol-constructor-detection.js
var symbol_constructor_detection_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

/* eslint-disable es/no-symbol -- required for testing */
var V8_VERSION = (environment_v8_version_namespaceFn());
var fails = (fails_namespaceFn());
var globalThis = (global_this_namespaceFn());

var $String = globalThis.String;

// eslint-disable-next-line es/no-object-getownpropertysymbols -- required for testing
module.exports = !!Object.getOwnPropertySymbols && !fails(function () {
  var symbol = Symbol('symbol detection');
  // Chrome 38 Symbol has incorrect toString conversion
  // `get-own-property-symbols` polyfill symbols converted to object are not Symbol instances
  // nb: Do not call `String` directly to avoid this being optimized out to `symbol+''` which will,
  // of course, fail.
  return !$String(symbol) || !(Object(symbol) instanceof Symbol) ||
    // Chrome 38-40 symbols are not inherited from DOM collections prototypes to instances
    !Symbol.sham && V8_VERSION && V8_VERSION < 41;
});

});

// MODULE: ./node_modules/core-js/internals/to-absolute-index.js
var to_absolute_index_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var toIntegerOrInfinity = (to_integer_or_infinity_namespaceFn());

var max = Math.max;
var min = Math.min;

// Helper for a popular repeating case of the spec:
// Let integer be ? ToInteger(index).
// If integer < 0, let result be max((length + integer), 0); else let result be min(integer, length).
module.exports = function (index, length) {
  var integer = toIntegerOrInfinity(index);
  return integer < 0 ? max(integer + length, 0) : min(integer, length);
};

});

// MODULE: ./node_modules/core-js/internals/to-indexed-object.js
var to_indexed_object_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

// toObject with fallback for non-array-like ES3 strings
var IndexedObject = (indexed_object_namespaceFn());
var requireObjectCoercible = (require_object_coercible_namespaceFn());

module.exports = function (it) {
  return IndexedObject(requireObjectCoercible(it));
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/to-integer-or-infinity.js
var to_integer_or_infinity_namespaceFn = function() {
	return __webpack_require__(291);
};

// EXTERNAL MODULE: ./node_modules/core-js/internals/to-length.js
var to_length_namespaceFn = function() {
	return __webpack_require__(14);
};

// EXTERNAL MODULE: ./node_modules/core-js/internals/to-object.js
var to_object_namespaceFn = function() {
	return __webpack_require__(981);
};

// MODULE: ./node_modules/core-js/internals/to-primitive.js
var to_primitive_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var call = (function_call_namespaceFn());
var isObject = (is_object_namespaceFn());
var isSymbol = (is_symbol_namespaceFn());
var getMethod = (get_method_namespaceFn());
var ordinaryToPrimitive = (ordinary_to_primitive_namespaceFn());
var wellKnownSymbol = (well_known_symbol_namespaceFn());

var $TypeError = TypeError;
var TO_PRIMITIVE = wellKnownSymbol('toPrimitive');

// `ToPrimitive` abstract operation
// https://tc39.es/ecma262/#sec-toprimitive
module.exports = function (input, pref) {
  if (!isObject(input) || isSymbol(input)) return input;
  var exoticToPrim = getMethod(input, TO_PRIMITIVE);
  var result;
  if (exoticToPrim) {
    if (pref === undefined) pref = 'default';
    result = call(exoticToPrim, input, pref);
    if (!isObject(result) || isSymbol(result)) return result;
    throw new $TypeError("Can't convert object to primitive value");
  }
  if (pref === undefined) pref = 'number';
  return ordinaryToPrimitive(input, pref);
};

});

// MODULE: ./node_modules/core-js/internals/to-property-key.js
var to_property_key_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var toPrimitive = (to_primitive_namespaceFn());
var isSymbol = (is_symbol_namespaceFn());

// `ToPropertyKey` abstract operation
// https://tc39.es/ecma262/#sec-topropertykey
module.exports = function (argument) {
  var key = toPrimitive(argument, 'string');
  return isSymbol(key) ? key : key + '';
};

});

// EXTERNAL MODULE: ./node_modules/core-js/internals/try-to-string.js
var try_to_string_namespaceFn = function() {
	return __webpack_require__(823);
};

// MODULE: ./node_modules/core-js/internals/uid.js
var uid_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var uncurryThis = (function_uncurry_this_namespaceFn());

var id = 0;
var postfix = Math.random();
var toString = uncurryThis(1.1.toString);

module.exports = function (key) {
  return 'Symbol(' + (key === undefined ? '' : key) + ')_' + toString(++id + postfix, 36);
};

});

// MODULE: ./node_modules/core-js/internals/use-symbol-as-uid.js
var use_symbol_as_uid_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

/* eslint-disable es/no-symbol -- required for testing */
var NATIVE_SYMBOL = (symbol_constructor_detection_namespaceFn());

module.exports = NATIVE_SYMBOL &&
  !Symbol.sham &&
  typeof Symbol.iterator == 'symbol';

});

// MODULE: ./node_modules/core-js/internals/v8-prototype-define-bug.js
var v8_prototype_define_bug_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var DESCRIPTORS = (descriptors_namespaceFn());
var fails = (fails_namespaceFn());

// V8 ~ Chrome 36-
// https://bugs.chromium.org/p/v8/issues/detail?id=3334
module.exports = DESCRIPTORS && fails(function () {
  // eslint-disable-next-line es/no-object-defineproperty -- required for testing
  return Object.defineProperty(function () { /* empty */ }, 'prototype', {
    value: 42,
    writable: false
  }).prototype !== 42;
});

});

// MODULE: ./node_modules/core-js/internals/weak-map-basic-detection.js
var weak_map_basic_detection_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var isCallable = (is_callable_namespaceFn());

var WeakMap = globalThis.WeakMap;

module.exports = isCallable(WeakMap) && /native code/.test(String(WeakMap));

});

// MODULE: ./node_modules/core-js/internals/well-known-symbol.js
var well_known_symbol_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function(module) {

var globalThis = (global_this_namespaceFn());
var shared = (shared_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var uid = (uid_namespaceFn());
var NATIVE_SYMBOL = (symbol_constructor_detection_namespaceFn());
var USE_SYMBOL_AS_UID = (use_symbol_as_uid_namespaceFn());

var Symbol = globalThis.Symbol;
var WellKnownSymbolsStore = shared('wks');
var createWellKnownSymbol = USE_SYMBOL_AS_UID ? Symbol['for'] || Symbol : Symbol && Symbol.withoutSetter || uid;

module.exports = function (name) {
  if (!hasOwn(WellKnownSymbolsStore, name)) {
    WellKnownSymbolsStore[name] = NATIVE_SYMBOL && hasOwn(Symbol, name)
      ? Symbol[name]
      : createWellKnownSymbol('Symbol.' + name);
  } return WellKnownSymbolsStore[name];
};

});

// MODULE: ./node_modules/core-js/modules/es.iterator.constructor.js
var es_iterator_constructor_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function() {

var $ = (export_namespaceFn());
var globalThis = (global_this_namespaceFn());
var anInstance = (an_instance_namespaceFn());
var anObject = (an_object_namespaceFn());
var isCallable = (is_callable_namespaceFn());
var getPrototypeOf = (object_get_prototype_of_namespaceFn());
var defineBuiltInAccessor = (define_built_in_accessor_namespaceFn());
var createProperty = (create_property_namespaceFn());
var fails = (fails_namespaceFn());
var hasOwn = (has_own_property_namespaceFn());
var wellKnownSymbol = (well_known_symbol_namespaceFn());
var IteratorPrototype = (iterators_core_namespaceFn().H);
var DESCRIPTORS = (descriptors_namespaceFn());
var IS_PURE = (is_pure_namespaceFn());

var CONSTRUCTOR = 'constructor';
var ITERATOR = 'Iterator';
var TO_STRING_TAG = wellKnownSymbol('toStringTag');

var $TypeError = TypeError;
var NativeIterator = globalThis[ITERATOR];

// FF56- have non-standard global helper `Iterator`
var FORCED = IS_PURE
  || !isCallable(NativeIterator)
  || NativeIterator.prototype !== IteratorPrototype
  // FF44- non-standard `Iterator` passes previous tests
  || !fails(function () { NativeIterator({}); });

var IteratorConstructor = function Iterator() {
  anInstance(this, IteratorPrototype);
  if (getPrototypeOf(this) === IteratorPrototype) throw new $TypeError('Abstract class Iterator not directly constructable');
};

var defineIteratorPrototypeAccessor = function (key, value) {
  if (DESCRIPTORS) {
    defineBuiltInAccessor(IteratorPrototype, key, {
      configurable: true,
      get: function () {
        return value;
      },
      set: function (replacement) {
        anObject(this);
        if (this === IteratorPrototype) throw new $TypeError("You can't redefine this property");
        if (hasOwn(this, key)) this[key] = replacement;
        else createProperty(this, key, replacement);
      }
    });
  } else IteratorPrototype[key] = value;
};

if (!hasOwn(IteratorPrototype, TO_STRING_TAG)) defineIteratorPrototypeAccessor(TO_STRING_TAG, ITERATOR);

if (FORCED || !hasOwn(IteratorPrototype, CONSTRUCTOR) || IteratorPrototype[CONSTRUCTOR] === Object) {
  defineIteratorPrototypeAccessor(CONSTRUCTOR, IteratorConstructor);
}

IteratorConstructor.prototype = IteratorPrototype;

// `Iterator` constructor
// https://tc39.es/ecma262/#sec-iterator
$({ global: true, constructor: true, forced: FORCED }, {
  Iterator: IteratorConstructor
});

});

// MODULE: ./node_modules/core-js/modules/es.iterator.map.js
var es_iterator_map_namespaceFn = /*#__PURE__*/__webpack_require__.cw(function() {

var $ = (export_namespaceFn());
var call = (function_call_namespaceFn());
var aCallable = (a_callable_namespaceFn());
var anObject = (an_object_namespaceFn());
var getIteratorDirect = (get_iterator_direct_namespaceFn());
var createIteratorProxy = (iterator_create_proxy_namespaceFn());
var callWithSafeIterationClosing = (call_with_safe_iteration_closing_namespaceFn());
var iteratorClose = (iterator_close_namespaceFn());
var iteratorHelperThrowsOnInvalidIterator = (iterator_helper_throws_on_invalid_iterator_namespaceFn());
var iteratorHelperWithoutClosingOnEarlyError = (iterator_helper_without_closing_on_early_error_namespaceFn());
var IS_PURE = (is_pure_namespaceFn());

var MAP_WITHOUT_THROWING_ON_INVALID_ITERATOR = !IS_PURE && !iteratorHelperThrowsOnInvalidIterator('map', function () { /* empty */ });
var mapWithoutClosingOnEarlyError = !IS_PURE && !MAP_WITHOUT_THROWING_ON_INVALID_ITERATOR
  && iteratorHelperWithoutClosingOnEarlyError('map', TypeError);

var FORCED = IS_PURE || MAP_WITHOUT_THROWING_ON_INVALID_ITERATOR || mapWithoutClosingOnEarlyError;

var IteratorProxy = createIteratorProxy(function () {
  var iterator = this.iterator;
  var result = anObject(call(this.next, iterator));
  var done = this.done = !!result.done;
  if (!done) return callWithSafeIterationClosing(iterator, this.mapper, [result.value, this.counter++], true);
});

// `Iterator.prototype.map` method
// https://tc39.es/ecma262/#sec-iterator.prototype.map
$({ target: 'Iterator', proto: true, real: true, forced: FORCED }, {
  map: function map(mapper) {
    anObject(this);
    try {
      aCallable(mapper);
    } catch (error) {
      iteratorClose(this, 'throw', error);
    }

    if (mapWithoutClosingOnEarlyError) return call(mapWithoutClosingOnEarlyError, this, mapper);

    return new IteratorProxy(getIteratorDirect(this), {
      mapper: mapper
    });
  }
});

});

;// ./node_modules/@vue/cli-service/lib/commands/build/setPublicPath.js
/* eslint-disable no-var */
// This file is imported into lib/wc client bundles.

if (typeof window !== 'undefined') {
  var currentScript = window.document.currentScript
  if (false) // removed by dead control flow
{ var getCurrentScript; }

  var setPublicPath_src = currentScript && currentScript.src.match(/(.+\/)[^/]+\.js(\?.*)?$/)
  if (setPublicPath_src) {
    __webpack_require__.p = setPublicPath_src[1] // eslint-disable-line
  }
}

// Indicate to webpack that this file can be concatenated
/* harmony default export */ var setPublicPath = (null);

// EXTERNAL MODULE: external {"commonjs":"vue","commonjs2":"vue","root":"Vue"}
var external_commonjs_vue_commonjs2_vue_root_Vue_ = __webpack_require__(274);
var external_commonjs_vue_commonjs2_vue_root_Vue_default = /*#__PURE__*/__webpack_require__.n(external_commonjs_vue_commonjs2_vue_root_Vue_);
;// ./node_modules/@vue/vue-loader-v15/lib/loaders/templateLoader.js??vue-loader-options!./node_modules/@vue/vue-loader-v15/lib/index.js??vue-loader-options!./src/canvasPlayer.vue?vue&type=template&id=0dbe3273&scoped=true
var render = function () {var _vm=this;var _h=_vm.$createElement;var _c=_vm._self._c||_h;return _c('div',{staticClass:"popup-layer"},[_c('div',{staticClass:"video-player-wrapper"},[_c('div',{attrs:{"id":"VideoDom"}},[_c('div',{attrs:{"id":"canvasDom"}},[_c('div',{directives:[{name:"show",rawName:"v-show",value:(_vm.showDom),expression:"showDom"}],class:[_vm.paused ? 'show' : ''],attrs:{"id":"progressBar"}},[_c('div',{staticClass:"bar",on:{"click":_vm.skipLine}},[_c('div',{ref:"trunk",staticClass:"line",class:['progress', _vm.paused ? 'pause' : 'play', !_vm.drag ? 'trans' : ''],style:({ width: (((_vm.playedTime / _vm.totalTime) * 100) + "%") })}),_c('div',{class:{ trans: !_vm.drag },attrs:{"id":"circle"}})]),_c('div',{staticClass:"left-box"},[_c('div',{staticClass:"btn",attrs:{"href":"#"}},[_c('button',{staticClass:"play",class:[_vm.paused ? 'play' : 'pause'],on:{"click":_vm.changeVideoState}})]),_c('div',{staticClass:"total-time"},[_vm._v(_vm._s(_vm.sToHs(_vm.playedTime))+" / "+_vm._s(_vm.sToHs(_vm.totalTime)))])]),_c('div',{staticClass:"volume"},[_c('input',{attrs:{"type":"checkbox"},on:{"click":_vm.changeVoiceStatus}}),_c('svg',{attrs:{"viewBox":"0 0 108 96"}},[_c('path',{attrs:{"d":"M7,28 L35,28 L35,28 L59,8 L59,88 L35,68 L7,68 C4.790861,68 3,66.209139 3,64 L3,32 C3,29.790861 4.790861,28 7,28 Z"}}),_c('path',{attrs:{"d":"M79,62 C83,57.3333333 85,52.6666667 85,48 C85,43.3333333 83,38.6666667 79,34 L49,3"}}),_c('path',{attrs:{"d":"M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.6666667,32.3333333 95,25 L75.5,6 L49,33"}})])])])])])]),_c('i',{staticClass:"popup-layer-btn-close",on:{"click":_vm.close}},[_vm._v("x")]),_c('div',{directives:[{name:"show",rawName:"v-show",value:(!_vm.showDom),expression:"!showDom"}],staticClass:"loadEffect"},[_c('span'),_c('span'),_c('span'),_c('span'),_c('span'),_c('span'),_c('span'),_c('span')]),_c('section',{directives:[{name:"show",rawName:"v-show",value:(_vm.paused),expression:"paused"}],staticClass:"playContainer",on:{"click":function($event){$event.preventDefault();return _vm.changeVideoState.apply(null, arguments)}}},[_vm._m(0)])])}
var staticRenderFns = [function () {var _vm=this;var _h=_vm.$createElement;var _c=_vm._self._c||_h;return _c('li',{staticClass:"playBtn"},[_c('a',{attrs:{"href":"#","title":"start"}},[_vm._v("Start")])])}]

;
;// ./node_modules/core-js/modules/es.iterator.constructor.js
es_iterator_constructor_namespaceFn();

;// ./node_modules/core-js/modules/es.iterator.map.js
es_iterator_map_namespaceFn();

;// ./node_modules/thread-loader/dist/cjs.js!./node_modules/babel-loader/lib/index.js??clonedRuleSet-80.use[1]!./node_modules/@vue/vue-loader-v15/lib/index.js??vue-loader-options!./src/canvasPlayer.vue?vue&type=script&lang=js


//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//

/* harmony default export */ var canvasPlayervue_type_script_lang_js = ({
  name: 'CanvasVideoPlayer',
  data() {
    return {
      list: [],
      playerlist: [],
      // 当前片段索引（一次会话内与 videoObj / 绘制循环始终指向同一段）
      playIndex: 0,
      logo: '',
      videoList: [],
      // 当前播放的视频对象
      videoObj: null,
      // 预加载视频对象
      preloadVideoObj: null,
      // 是否暂停
      paused: true,
      // 全部片段累计总时长
      totalTime: 0,
      // 累计已播放时长（进度条显示值）
      playedTime: 0,
      // 是否已播放到结尾
      endFlag: false,
      // 各片段累计结束时间节点，用于进度条快速定位
      skipDict: [],
      // 是否展示进度条
      showDom: false,
      // 是否正在拖动进度条
      drag: 0,
      // 拖动松手后浏览器会补发一次 click，用该标记吞掉，避免同一次操作跳转两次
      justDragged: false,
      // ===== 会话级运行时状态（不参与视图渲染）=====
      // 当前绘制循环的 requestAnimationFrame 句柄
      rafId: null,
      // 绘制循环是否运行中（同一时刻只允许一个绘制循环）
      drawRunning: false,
      // 片段会话代号：每次切换片段自增，旧片段残留的异步事件回调据此失效
      sessionGen: 0,
      // 同一结束窗口内只允许推进一次索引
      isSwitching: false,
      // 播放器是否已销毁（销毁后所有异步回调直接退场）
      destroyed: false,
      // document / DOM 级监听整个会话只绑定一次
      listenersBound: false,
      // 当前片段在累计时间轴上的起点时间
      segmentStart: 0
    };
  },
  beforeDestroy() {
    this.teardown();
  },
  mounted() {
    this.playerlist = this.list.map(item => {
      return {
        start: parseFloat(item.playPoint.start),
        end: parseFloat(item.playPoint.end)
      };
    });
    this.videoList = this.list;
    this.comTotalTime();
    this.playedTime = 0;
    this.bindGlobalListeners();
    this.$nextTick(() => {
      this.gotoPlay();
    });
  },
  methods: {
    // 外部入口（index.js 也会调用），仅做进度复位
    init() {
      this.playedTime = 0;
    },
    // 计算总时长与各片段累计时间节点
    comTotalTime() {
      let totalTime = 0;
      this.skipDict = this.playerlist.map(item => {
        totalTime += item.end - item.start;
        return totalTime;
      });
      this.totalTime = totalTime;
    },
    // 整个播放会话只绑定一次全局监听，引用固定，销毁时可精确移除
    bindGlobalListeners() {
      if (this.listenersBound) return;
      this.listenersBound = true;
      document.addEventListener('keydown', this.keydown);
      document.addEventListener('mousemove', this.mousemove);
      document.addEventListener('mouseup', this.mouseup);
      this.$nextTick(() => {
        if (this.destroyed) return;
        const circle = document.querySelector('#circle');
        if (circle) circle.addEventListener('mousedown', this.onCircleMouseDown);
      });
    },
    onCircleMouseDown() {
      this.drag = 1;
      this.justDragged = false;
      if (this.videoObj && !this.videoObj.paused) {
        this.videoObj.pause();
        this.paused = true;
      }
    },
    mousemove(e) {
      if (this.drag === 1) {
        this.setValue(e);
      }
    },
    mouseup() {
      if (this.drag === 1) {
        // 松手后浏览器会在进度条上补发一次 click，标记后由 skipLine 吞掉
        this.justDragged = true;
        this.skipProgress();
      }
      this.drag = 0;
    },
    // 拖动过程中实时刷新进度条时间（不改播放状态，松手时才跳转）
    setValue(touch) {
      const bar = document.querySelector('.bar');
      if (!bar || !this.totalTime) return;
      const rect = bar.getBoundingClientRect();
      let oLeft = touch.clientX - rect.left;
      oLeft = Math.max(0, Math.min(oLeft, rect.width));
      this.playedTime = oLeft / rect.width * this.totalTime;
    },
    // 点击进度条跳转
    skipLine(e) {
      // 拖动松手补发的 click：跳过，同一次拖动只做一次跳转
      if (this.justDragged) {
        this.justDragged = false;
        return;
      }
      const bar = document.querySelector('.bar');
      if (!bar || !this.totalTime) return;
      const rect = bar.getBoundingClientRect();
      let oLeft = e.clientX - rect.left;
      oLeft = Math.max(0, Math.min(oLeft, rect.width));
      this.playedTime = oLeft / rect.width * this.totalTime;
      this.skipProgress();
    },
    // 拖动松手 / 点击后的统一跳转：累计时间 -> 正确片段 + 片段内偏移
    skipProgress() {
      if (this.destroyed || !this.videoList.length || !this.totalTime) return;
      const target = Math.max(0, Math.min(this.playedTime, this.totalTime));
      // 落在总时长末尾：进入结束态，不允许越界索引
      if (target >= this.totalTime - 0.001) {
        this.enterEndState();
        return;
      }
      // 找到 target 所在片段：第一个累计节点大于 target 的片段
      let curIndex = this.skipDict.length - 1;
      for (let i = 0; i < this.skipDict.length; i++) {
        if (target < this.skipDict[i]) {
          curIndex = i;
          break;
        }
      }
      const segStart = curIndex === 0 ? 0 : this.skipDict[curIndex - 1];
      const segDuration = this.playerlist[curIndex].end - this.playerlist[curIndex].start;
      // 偏移钳制：不允许负偏移，也不允许超出本片段时长
      let offset = Math.max(0, Math.min(target - segStart, segDuration - 0.001));
      this.playedTime = segStart + offset;
      this.endFlag = false;
      this.isSwitching = false;
      this.playIndex = curIndex;
      this.VideoPlay(offset);
    },
    keydown(e) {
      if (e.keyCode === 27) {
        // Esc 关闭
        this.close();
      }
    },
    // 从第一段重新开始一次播放
    gotoPlay() {
      if (this.destroyed || !this.videoList.length) return;
      this.playIndex = 0;
      this.playedTime = 0;
      this.paused = false;
      this.endFlag = false;
      this.isSwitching = false;
      this.VideoPlay(0);
    },
    // 截获当前视频播放器
    updateCurrentVideo(videoObj) {
      this.videoObj = videoObj;
    },
    // 播放 || 暂停：单次点击只切换一次状态
    changeVideoState() {
      if (this.destroyed || this.isSwitching) return;
      if (this.endFlag || !this.videoObj) {
        // 结束态点击：从第一段重新播放
        this.gotoPlay();
        return;
      }
      if (this.videoObj.paused) {
        this.videoObj.play();
        this.paused = false;
      } else {
        this.videoObj.pause();
        this.paused = true;
      }
    },
    // 静音
    changeVoiceStatus() {
      if (this.videoObj) {
        this.videoObj.muted = !this.videoObj.muted;
      }
    },
    // 核心启动逻辑：加载并播放 playIndex 指向的片段，shortSliceTime 为片段内偏移
    VideoPlay(shortSliceTime = 0) {
      if (this.destroyed) return;
      if (this.playIndex < 0 || this.playIndex >= this.videoList.length) return;
      // 新片段会话：代号自增，上一片段残留的 timeupdate / onseeked / 绘制循环全部失效
      const gen = ++this.sessionGen;
      this.isSwitching = false;
      // 停掉上一片段的绘制循环，保证同一时刻只有一个绘制循环
      this.stopDrawLoop();
      const elDom = document.querySelector('#VideoDom');
      const canvasDom = document.querySelector('#canvasDom');

      // 一、解析当前片段参数
      const currentVideo = this.videoList[this.playIndex];
      const currentUrl = currentVideo.url;
      const baseStartTime = parseFloat(currentVideo.playPoint.start);
      const currentStartTime = baseStartTime + shortSliceTime;
      const currentEndTime = parseFloat(currentVideo.playPoint.end);
      const currentLogoInfo = {
        logo: this.logo,
        position: currentVideo.logoPosition,
        videoWidth: currentVideo.width
      };
      // 当前片段在累计时间轴上的起点，与 playIndex 同步写入
      this.segmentStart = this.playIndex === 0 ? 0 : this.skipDict[this.playIndex - 1];

      // 二、下一片段（用于预加载），没有下一 片段时记为 -1
      const nextIndex = this.playIndex + 1 < this.videoList.length ? this.playIndex + 1 : -1;

      // 三、复用或创建视频 / canvas 对象（固定角色，源被替换；旧对象先停止再复用）
      const videoObj = this.createVideo(elDom, 'AutoVideoId', false);
      const nextVideoObj = this.createVideo(elDom, 'preLoadVideoId', true);
      const CanvasEle = this.createCanvas(canvasDom, 'AutoCanvasId');
      const context = CanvasEle.getContext('2d');

      // 清掉两个视频元素上一次会话残留的事件与播放状态
      this.clearVideoHandlers(videoObj);
      this.clearVideoHandlers(nextVideoObj);
      try {
        nextVideoObj.pause();
      } catch (e) {
        /* noop */
      }
      this.updateCurrentVideo(videoObj);
      videoObj.src = currentUrl;

      // 视频源改变时，定位到片段起点（含跳转偏移）
      videoObj.ondurationchange = () => {
        if (gen !== this.sessionGen || this.destroyed) return;
        videoObj.currentTime = currentStartTime;
      };
      // 重新定位完成后继续播放
      videoObj.onseeked = () => {
        if (gen !== this.sessionGen || this.destroyed) return;
        videoObj.volume = 1;
        const playPromise = videoObj.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(error => {
            console.log('sorry! 视频初始化失败', error);
          });
        }
      };
      // 播放位置改变：累计进度直接由视频原始时间推导，显示与实际视频时间一致
      videoObj.ontimeupdate = () => {
        if (gen !== this.sessionGen || this.destroyed) return;
        if (videoObj.seeking) return;
        // 累计进度直接由视频原始时间推导；钳制在本片段起点与总时长之间
        const rawProgress = this.segmentStart + (videoObj.currentTime - baseStartTime);
        this.playedTime = Math.max(this.segmentStart, Math.min(this.totalTime, rawProgress));
        if (videoObj.currentTime >= currentEndTime) {
          // 自然结束：playNext 内部有开关保护，同一结束窗口不会重复跳段
          this.playNext();
        }
      };
      videoObj.onplay = () => {
        if (gen !== this.sessionGen || this.destroyed) return;
        this.paused = false;
        // 画布尺寸跟随当前片段配置
        CanvasEle.width = videoObj.videoWidth || currentVideo.width;
        CanvasEle.height = videoObj.videoHeight || currentVideo.height;
        // logo 跟随当前片段配置
        this.createAndPutLogo(canvasDom, 'logoId', currentLogoInfo);
        this.showDom = true;
        this.startDrawLoop(gen, videoObj, context, CanvasEle, currentStartTime, currentEndTime);
      };
      // 视频原生结束事件同样走带保护的推进逻辑
      videoObj.onended = () => {
        if (gen !== this.sessionGen || this.destroyed) return;
        this.playNext();
      };

      // 四、预加载下一 片段：复用预加载对象并替换其源；没有下一 片段则释放
      this.preloadVideoObj = nextVideoObj;
      if (nextIndex >= 0) {
        const nextVideo = this.videoList[nextIndex];
        nextVideoObj.src = nextVideo.url;
        nextVideoObj.ondurationchange = () => {
          if (this.destroyed) return;
          try {
            nextVideoObj.currentTime = parseFloat(nextVideo.playPoint.start);
          } catch (e) {
            /* noop */
          }
        };
      } else {
        this.clearVideoHandlers(nextVideoObj);
        nextVideoObj.removeAttribute('src');
        nextVideoObj.load();
      }
    },
    // 启动当前片段唯一的绘制循环
    startDrawLoop(gen, videoObj, context, CanvasEle, currentStartTime, currentEndTime) {
      this.stopDrawLoop();
      this.drawRunning = true;
      const drawData = () => {
        // 会话已切换 / 播放器已销毁 / 循环被主动停止：立即退场，不再安排下一帧
        if (!this.drawRunning || this.destroyed || gen !== this.sessionGen) {
          return;
        }
        if (videoObj.paused) {
          this.drawRunning = false;
          this.rafId = null;
          return;
        }
        if (videoObj.ended || videoObj.currentTime >= currentEndTime) {
          this.drawRunning = false;
          this.rafId = null;
          this.playNext();
          return;
        }
        if (videoObj.currentTime < currentStartTime) {
          // seek 过程中保持循环存活但不绘制，等待新画面
          this.rafId = window.requestAnimationFrame(drawData);
          return;
        }
        context.drawImage(videoObj, 0, 0, CanvasEle.width, CanvasEle.height);
        this.rafId = window.requestAnimationFrame(drawData);
      };
      this.rafId = window.requestAnimationFrame(drawData);
    },
    stopDrawLoop() {
      this.drawRunning = false;
      if (this.rafId !== null) {
        window.cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    },
    // 播放下一段：同一结束窗口只推进一次索引，重复触发不会跳过片段
    playNext() {
      if (this.destroyed || this.isSwitching) return;
      if (this.playIndex >= this.videoList.length - 1) {
        this.enterEndState();
        return;
      }
      this.isSwitching = true;
      try {
        if (this.videoObj) this.videoObj.pause();
      } catch (e) {
        /* noop */
      }
      this.playIndex += 1;
      this.VideoPlay(0);
    },
    // 进入结束态：停循环、停视频、索引停在末尾（点击后可从第一段重播）
    enterEndState() {
      this.stopDrawLoop();
      this.isSwitching = false;
      this.endFlag = true;
      this.paused = true;
      this.playIndex = this.videoList.length;
      this.playedTime = this.totalTime;
      if (this.videoObj) {
        try {
          this.videoObj.pause();
        } catch (e) {
          /* noop */
        }
      }
    },
    // 创建并摆放 logo（每次切换片段时按新配置重排位置）
    createAndPutLogo(parentDom, domId, logoInfo) {
      this.$nextTick(() => {
        if (this.destroyed) return;
        const canvasDom = document.querySelector('#AutoCanvasId');
        parentDom = parentDom || document.body;
        let obj = document.getElementById(domId);
        if (!obj) {
          obj = document.createElement('img');
          obj.id = domId;
          parentDom.appendChild(obj);
        }
        // 先清空上一片段残留的方位样式，避免两个方向的定位同时生效
        obj.style.position = 'absolute';
        obj.style.display = 'none';
        obj.style.left = '';
        obj.style.right = '';
        obj.style.top = '';
        obj.style.bottom = '';
        obj.style.width = `${canvasDom.width * 150 / 1080}px`;
        obj.style[logoInfo.position.x] = `${canvasDom.width / 1080 * 60}px`;
        obj.style[logoInfo.position.y] = `${canvasDom.width / 1080 * 60}px`;
        obj.src = logoInfo.logo;
        this.$nextTick(() => {
          if (!this.destroyed) obj.style.display = 'block';
        });
      });
    },
    // 根据父容器大小设置视频尺寸
    setVideoStyle(vObj) {
      let parentWidth = vObj.parentNode.getBoundingClientRect().width;
      let parentHeight = vObj.parentNode.getBoundingClientRect().height;
      // 根据父容器宽高计算 视频缩放比例
      let scaleVal = Math.max(vObj.videoWidth / parentWidth, vObj.videoHeight / parentHeight);
      let scaleWidth = vObj.videoWidth / scaleVal;
      let scaleHeight = vObj.videoHeight / scaleVal;
      vObj.width = scaleWidth;
      vObj.height = scaleHeight;
    },
    // 创建视频对象（同 id 对象已存在时直接复用）
    createVideo(parentDom, domId, isMuted = false) {
      if (!domId) {
        console.warn('缺少命名ID');
        return;
      }
      parentDom = parentDom || document.body;
      let obj = document.getElementById(domId);
      if (!obj) {
        obj = document.createElement('Video');
        obj.id = domId;
        parentDom.appendChild(obj);
        let videoSize = parseInt(document.getElementsByTagName('video').length);
        // 设置视频属性
        obj.preload = 'auto';
        obj.style = 'background:#000000;display:none;position:absolute;left:100%;top:0;';
        obj.autoplay = '';
        obj.style.left = videoSize * 100 + '%';
        obj.controls = true;
        obj.muted = isMuted;
        obj.volume = 0.1;
        // 视频加载 meta 信息后，把自身尺寸修改了
        obj.onloadedmetadata = () => {
          this.setVideoStyle(obj);
        };
      }
      return obj;
    },
    // 创建 Canvas 对象（同 id 对象已存在时直接复用；画布点击监听只绑一次）
    createCanvas(parentDom, domId) {
      if (!domId) {
        console.warn('缺少命名ID');
        return;
      }
      parentDom = parentDom || document.body;
      let Obj = document.getElementById(domId);
      if (!Obj) {
        Obj = document.createElement('Canvas');
        Obj.id = domId;
        parentDom.appendChild(Obj);
        Obj.addEventListener('click', this.changeVideoState);
      }
      return Obj;
    },
    clearVideoHandlers(v) {
      if (!v) return;
      v.ondurationchange = null;
      v.onseeked = null;
      v.ontimeupdate = null;
      v.onplay = null;
      v.onended = null;
      v.onseeking = null;
      v.onpause = null;
    },
    releaseVideo(v) {
      if (!v) return;
      this.clearVideoHandlers(v);
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch (e) {
        /* noop */
      }
    },
    // 会话结束时的彻底释放：动画帧、定时器、键盘鼠标监听、画布点击监听、视频资源
    teardown() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stopDrawLoop();
      document.removeEventListener('keydown', this.keydown);
      document.removeEventListener('mousemove', this.mousemove);
      document.removeEventListener('mouseup', this.mouseup);
      const circle = document.querySelector('#circle');
      if (circle) circle.removeEventListener('mousedown', this.onCircleMouseDown);
      const canvas = document.querySelector('#AutoCanvasId');
      if (canvas) canvas.removeEventListener('click', this.changeVideoState);
      this.releaseVideo(document.getElementById('AutoVideoId'));
      this.releaseVideo(document.getElementById('preLoadVideoId'));
      this.videoObj = null;
      this.preloadVideoObj = null;
      // 通知入口（index.js）释放单例占位，允许再次打开
      if (typeof this.setFree === 'function') {
        this.setFree();
      }
    },
    close() {
      // 幂等：Esc 与关闭按钮同时触发、或重复点击只执行一次
      if (this.destroyed) return;
      try {
        if (typeof this.onClose === 'function') {
          this.onClose(this);
        }
      } catch (e) {
        console.log(e);
      }
      try {
        this.$destroy();
        if (this.$el && this.$el.parentNode) {
          this.$el.parentNode.removeChild(this.$el);
        }
      } catch (e) {
        console.log(e);
      }
    },
    sToHs(s) {
      // 计算分钟
      s = parseFloat(s).toFixed(0);
      var h;
      h = Math.floor(s / 60);
      // 计算秒
      s = s % 60;
      // 将变量转换为字符串
      h += '';
      s += '';
      // 如果只有一位数，前面增加一个0
      h = h.length == 1 ? '0' + h : h;
      s = s.length == 1 ? '0' + s : s;
      return h + ':' + s;
    }
  }
});
;// ./src/canvasPlayer.vue?vue&type=script&lang=js
 /* harmony default export */ var src_canvasPlayervue_type_script_lang_js = (canvasPlayervue_type_script_lang_js); 
// EXTERNAL MODULE: ./node_modules/vue-style-loader/index.js??clonedRuleSet-52.use[0]!./node_modules/css-loader/dist/cjs.js??clonedRuleSet-52.use[1]!./node_modules/@vue/vue-loader-v15/lib/loaders/stylePostLoader.js!./node_modules/postcss-loader/dist/cjs.js??clonedRuleSet-52.use[2]!./node_modules/postcss-loader/dist/cjs.js??clonedRuleSet-52.use[3]!./node_modules/@vue/vue-loader-v15/lib/index.js??vue-loader-options!./src/canvasPlayer.vue?vue&type=style&index=0&id=0dbe3273&prod&lang=css
var canvasPlayervue_type_style_index_0_id_0dbe3273_prod_lang_css = __webpack_require__(583);
;// ./src/canvasPlayer.vue?vue&type=style&index=0&id=0dbe3273&prod&lang=css

// EXTERNAL MODULE: ./node_modules/vue-style-loader/index.js??clonedRuleSet-72.use[0]!./node_modules/css-loader/dist/cjs.js??clonedRuleSet-72.use[1]!./node_modules/@vue/vue-loader-v15/lib/loaders/stylePostLoader.js!./node_modules/postcss-loader/dist/cjs.js??clonedRuleSet-72.use[2]!./node_modules/postcss-loader/dist/cjs.js??clonedRuleSet-72.use[3]!./node_modules/less-loader/dist/cjs.js??clonedRuleSet-72.use[4]!./node_modules/@vue/vue-loader-v15/lib/index.js??vue-loader-options!./src/canvasPlayer.vue?vue&type=style&index=1&id=0dbe3273&prod&lang=less&scoped=true
var canvasPlayervue_type_style_index_1_id_0dbe3273_prod_lang_less_scoped_true = __webpack_require__(378);
;// ./src/canvasPlayer.vue?vue&type=style&index=1&id=0dbe3273&prod&lang=less&scoped=true

;// ./node_modules/@vue/vue-loader-v15/lib/runtime/componentNormalizer.js
/* globals __VUE_SSR_CONTEXT__ */

// IMPORTANT: Do NOT use ES2015 features in this file (except for modules).
// This module is a runtime utility for cleaner component module output and will
// be included in the final webpack user bundle.

function normalizeComponent(
  scriptExports,
  render,
  staticRenderFns,
  functionalTemplate,
  injectStyles,
  scopeId,
  moduleIdentifier /* server only */,
  shadowMode /* vue-cli only */
) {
  // Vue.extend constructor export interop
  var options =
    typeof scriptExports === 'function' ? scriptExports.options : scriptExports

  // render functions
  if (render) {
    options.render = render
    options.staticRenderFns = staticRenderFns
    options._compiled = true
  }

  // functional template
  if (functionalTemplate) {
    options.functional = true
  }

  // scopedId
  if (scopeId) {
    options._scopeId = 'data-v-' + scopeId
  }

  var hook
  if (moduleIdentifier) {
    // server build
    hook = function (context) {
      // 2.3 injection
      context =
        context || // cached call
        (this.$vnode && this.$vnode.ssrContext) || // stateful
        (this.parent && this.parent.$vnode && this.parent.$vnode.ssrContext) // functional
      // 2.2 with runInNewContext: true
      if (!context && typeof __VUE_SSR_CONTEXT__ !== 'undefined') {
        context = __VUE_SSR_CONTEXT__
      }
      // inject component styles
      if (injectStyles) {
        injectStyles.call(this, context)
      }
      // register component module identifier for async chunk inferrence
      if (context && context._registeredComponents) {
        context._registeredComponents.add(moduleIdentifier)
      }
    }
    // used by ssr in case component is cached and beforeCreate
    // never gets called
    options._ssrRegister = hook
  } else if (injectStyles) {
    hook = shadowMode
      ? function () {
          injectStyles.call(
            this,
            (options.functional ? this.parent : this).$root.$options.shadowRoot
          )
        }
      : injectStyles
  }

  if (hook) {
    if (options.functional) {
      // for template-only hot-reload because in that case the render fn doesn't
      // go through the normalizer
      options._injectStyles = hook
      // register for functional component in vue file
      var originalRender = options.render
      options.render = function renderWithStyleInjection(h, context) {
        hook.call(context)
        return originalRender(h, context)
      }
    } else {
      // inject component registration as beforeCreate hook
      var existing = options.beforeCreate
      options.beforeCreate = existing ? [].concat(existing, hook) : [hook]
    }
  }

  return {
    exports: scriptExports,
    options: options
  }
}

;// ./src/canvasPlayer.vue







/* normalize component */

var component = normalizeComponent(
  src_canvasPlayervue_type_script_lang_js,
  render,
  staticRenderFns,
  false,
  null,
  "0dbe3273",
  null
  
)

/* harmony default export */ var canvasPlayer = (component.exports);
;// ./src/data.js
/*
 * @description:
 * @Author: ljc
 * @Date: 2021-07-13 12:01:04
 * @LastEditors: ljc
 * @LastEditTime: 2021-07-13 14:28:20
 */
const videoObj = {
  logo: "//cms-static.pengwin.com/data/product_logo/20210713/2671411626148786627659.png",
  thumb: "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
  list: [{
    id: 352,
    name: "简单充充_衻_1038",
    url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
    thumb: "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
    width: 1080,
    height: 1920,
    logoPosition: {
      x: "left",
      y: "top"
    },
    playPoint: {
      end: "3.120000",
      start: "0"
    },
    index: 0
  }, {
    id: 352,
    name: "简单充充_衻_1038",
    url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
    thumb: "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
    width: 1080,
    height: 1920,
    logoPosition: {
      x: "right",
      y: "top"
    },
    playPoint: {
      end: "10.200000",
      start: "4.320000"
    },
    index: 1
  }, {
    id: 352,
    name: "简单充充_衻_1038",
    url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
    thumb: "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
    width: 1080,
    height: 1920,
    logoPosition: {
      x: "left",
      y: "bottom"
    },
    playPoint: {
      end: "20.320000",
      start: "11.400000"
    },
    index: 2
  }, {
    id: 352,
    name: "简单充充_衻_1038",
    url: "//cms-static.pengwin.com/data/ingredient/20210709/9974121625796764465380.mp4",
    thumb: "//cms-static.pengwin.com/data/thumb/20210709/6300931625796768500909.jpg",
    width: 1080,
    height: 1920,
    logoPosition: {
      x: "right",
      y: "bottom"
    },
    playPoint: {
      end: "24.72",
      start: "21.520000"
    },
    index: 3
  }],
  duration: 21.12,
  common: 1,
  name: "简单充充_01_0713"
};
/* harmony default export */ var src_data = (videoObj);
;// ./src/index.js
/*
 * @description:
 * @Author: ljc
 * @Date: 2021-07-13 14:22:35
 * @LastEditors: ljc
 * @LastEditTime: 2021-07-30 11:07:31
 */



let Player = external_commonjs_vue_commonjs2_vue_root_Vue_default().extend(canvasPlayer);
let instance;
let seed = 1;
const src_component = options => {
  if ((external_commonjs_vue_commonjs2_vue_root_Vue_default()).prototype.$isServer || seed !== 1) return;
  options = options || src_data;
  instance = new Player({
    data: options
  });
  instance.id = "player_" + seed++;
  instance.vm = instance.$mount();
  instance.dom = instance.vm.$el;
  document.body.appendChild(instance.dom);
  instance.vm.init();
  instance.dom.style.zIndex = seed + 1001;
  seed = 2;
  instance.vm.setFree = function () {
    seed = 1;
  };
  return instance.vm;
};
/* harmony default export */ var src_0 = ({
  install: Vue => {
    Vue.prototype.$canvasVideoPlayer = src_component;
  }
});
;// ./node_modules/@vue/cli-service/lib/commands/build/entry-lib.js


/* harmony default export */ var entry_lib = (src_0);
;

}();
/******/ 	return __webpack_exports__;
/******/ })()
;
});
//# sourceMappingURL=canvas-player.umd.js.map
(function() {
  if (!JZZ) return;
  if (!JZZ.input) JZZ.input = {};

  function _name(name) { return name ? name : 'Qwerty-Hancock'; }
  var _version;

  function _init() {
    _init = function(){};
    var dummy = {};
    try { QwertyHancock.call(dummy, {id:'*'}); }
    catch (e) {} // ridiculous way to obtain the version
    _version = dummy.version;
  }

  function Engine() {
    _init();
  }

  Engine.prototype._info = function(name) {
    return {
      type: 'qwerty-hancock.js',
      name: _name(name),
      manufacturer: 'virtual',
      version: _version
    };
  }

  Engine.prototype._openIn = function(port, name) {
    var qwerty;
    try {
      qwerty = new QwertyHancock(this._arg);
    }
    catch (e) {
      // The keyboard library failed to construct: surface the error
      // through the port instead of silently dropping it.
      port._crash(e.toString());
      return;
    }
    qwerty.keyDown = function (note, frequency) {
      port._emit(JZZ.MIDI(0x90, note, 127));
    };
    qwerty.keyUp = function (note, frequency) {
      port._emit(JZZ.MIDI(0x80, note, 127));
    };
    // Keep the underlying keyboard reachable from the port, e.g. to switch
    // the starting octave at runtime via port.qwerty.setStartNote('A4').
    port.qwerty = qwerty;
    port._info = this._info(name);
    port._resume();
  }

  JZZ.input.Qwerty = function() {
    var name, arg;
    if (arguments.length == 1) {
      if (typeof arguments[0] == 'string') name = arguments[0];
      else arg = arguments[0];
    }
    else { name = arguments[0]; arg = arguments[1];}
    var _engine = new Engine;
    _engine._arg = arg;
    return JZZ.lib.openMidiIn(name, _engine);
  }

  JZZ.input.Qwerty.register = function() {
    var name, arg;
    if (arguments.length == 1) {
      if (typeof arguments[0] == 'string') name = arguments[0];
      else arg = arguments[0];
    }
    else { name = arguments[0]; arg = arguments[1];}
    var _engine = new Engine;
    _engine._arg = arg;
    return JZZ.lib.registerMidiIn(name, _engine);
  }

})();

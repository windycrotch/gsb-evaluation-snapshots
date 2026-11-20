"""Minimal offline mock of the bpy/bmesh API surface used by uv_mesh.py.

This is NOT Blender. It exists so the batch-conversion logic can be executed and
asserted on a machine without Blender installed. Behaviour modelled deliberately:

  * datablock name uniquification (Foo -> Foo.001) for meshes and objects
  * mesh.users counts
  * bmesh vert/face creation, degenerate-face area, remove_doubles welding
  * selection list order and the active object
  * operator registration and poll/execute dispatch
"""

import types


###########################################################################
# math

class Vector:
	__slots__ = ("x", "y", "z")

	def __init__(self, values):
		if isinstance(values, Vector):
			self.x, self.y, self.z = values.x, values.y, values.z
			return
		self.x = float(values[0])
		self.y = float(values[1])
		self.z = float(values[2]) if len(values) > 2 else 0.0

	def __iter__(self):
		return iter((self.x, self.y, self.z))

	def __getitem__(self, index):
		return (self.x, self.y, self.z)[index]

	def __eq__(self, other):
		return tuple(self) == tuple(other)

	def __hash__(self):
		return hash(tuple(self))

	def __repr__(self):
		return f"Vector({self.x}, {self.y}, {self.z})"


###########################################################################
# collections with Blender-style naming

def _unique_name(taken, wanted):
	if wanted not in taken:
		return wanted
	stem = wanted
	index = 1
	while True:
		candidate = f"{stem}.{index:03d}"
		if candidate not in taken:
			return candidate
		index += 1


class _Collection:
	def __init__(self, factory):
		self._factory = factory
		self._items = []

	def _names(self):
		return {item.name for item in self._items}

	def new(self, name, *args, **kwargs):
		name = _unique_name(self._names(), name)
		item = self._factory(name, *args, **kwargs)
		self._items.append(item)
		return item

	def remove(self, item, **kwargs):
		if item in self._items:
			self._items.remove(item)

	def get(self, name, default=None):
		for item in self._items:
			if item.name == name:
				return item
		return default

	def __getitem__(self, name):
		for item in self._items:
			if item.name == name:
				return item
		raise KeyError(name)

	def keys(self):
		return [item.name for item in self._items]

	def __iter__(self):
		return iter(list(self._items))

	def __len__(self):
		return len(self._items)

	def __contains__(self, name):
		return self.get(name) is not None


def _rename(collection, item, new_name):
	others = {other.name for other in collection._items if other is not item}
	item.name = _unique_name(others, new_name)


###########################################################################
# mesh

class MeshUVLoop:
	def __init__(self):
		self._value = (0.0, 0.0)

	@property
	def uv(self):
		return self._value

	@uv.setter
	def uv(self, value):
		self._value = (float(value[0]), float(value[1]))

	@property
	def vector(self):
		return Vector((self._value[0], self._value[1], 0.0))


class MeshUVLayer:
	def __init__(self, name, mesh=None):
		self.name = name
		self._mesh = mesh
		self._entries = []

	def _ensure(self, count):
		while len(self._entries) < count:
			self._entries.append(MeshUVLoop())

	@property
	def data(self):
		if self._mesh is not None:
			self._ensure(self._mesh.loop_total)
		return self._entries

	@property
	def uv(self):
		return self.data


class MeshUVLayerCollection:
	def __init__(self, mesh=None):
		self._layers = []
		self._mesh = mesh

	@property
	def _loop_count(self):
		if self._mesh is not None:
			return self._mesh.loop_total
		return 0

	def new(self, name="UVMap"):
		layer = MeshUVLayer(_unique_name({l.name for l in self._layers}, name), self._mesh)
		layer._ensure(self._loop_count)
		self._layers.append(layer)
		return layer

	def get(self, name, default=None):
		for layer in self._layers:
			if layer.name == name:
				return layer
		return default

	def __iter__(self):
		return iter(list(self._layers))

	def __len__(self):
		return len(self._layers)


class Polygon:
	def __init__(self, loop_start, loop_total):
		self.loop_start = loop_start
		self.loop_total = loop_total

	@property
	def loop_indices(self):
		return list(range(self.loop_start, self.loop_start + self.loop_total))


class Mesh:
	_data_collection = None

	def __init__(self, name):
		self.name = name
		self.vertices = []
		self.polygons = []
		self.loop_total = 0
		self.uv_layers = MeshUVLayerCollection(self)
		self._loop_vert_indices = []

	def from_pydata(self, verts, edges, faces):
		self.vertices = [Vector(v) for v in verts]
		self.polygons = []
		self._loop_vert_indices = []
		loop = 0
		for face in faces:
			self.polygons.append(Polygon(loop, len(face)))
			self._loop_vert_indices.extend(face)
			loop += len(face)
		self.loop_total = loop
		for layer in self.uv_layers:
			layer._ensure(loop)

	def update(self):
		pass

	def validate(self):
		pass

	@property
	def users(self):
		return sum(1 for obj in _data.objects if obj.data is self)

	def __repr__(self):
		return f"<Mesh {self.name}>"


###########################################################################
# object

class Object:
	def __init__(self, name, data):
		self.name = name
		self.data = data
		self.type = 'MESH' if data is not None else 'EMPTY'
		self.mode = 'OBJECT'
		self._selected = False

	def select_set(self, value):
		if self not in list(_scene_objects()):
			raise RuntimeError("Object is not in the view layer")
		self._selected = bool(value)

	def select_get(self):
		return self._selected

	def evaluated_get(self, depsgraph):
		return self

	def to_mesh(self, preserve_all_data_layers=False, depsgraph=None):
		return self.data

	def to_mesh_clear(self):
		pass

	def __repr__(self):
		return f"<Object {self.name}>"


###########################################################################
# bmesh

class BMVert:
	def __init__(self, co):
		self.co = Vector(co)
		self.link_faces = []
		self.dead = False


class BMLoop:
	def __init__(self, face, vert):
		self.face = face
		self.vert = vert
		self._uv = {}

	def __getitem__(self, layer):
		return _LoopUV(self, layer)


class _LoopUV:
	def __init__(self, loop, layer):
		self._loop = loop
		self._layer = layer

	@property
	def uv(self):
		return self._loop._uv.get(self._layer, (0.0, 0.0))

	@uv.setter
	def uv(self, value):
		self._loop._uv[self._layer] = (float(value[0]), float(value[1]))


class BMFace:
	def __init__(self, verts):
		self.verts = list(verts)
		self.loops = [BMLoop(self, vert) for vert in self.verts]
		for vert in self.verts:
			vert.link_faces.append(self)
		self.dead = False

	def calc_area(self):
		total = 0.0
		points = [(v.co.x, v.co.y) for v in self.verts]
		for index in range(len(points)):
			x1, y1 = points[index]
			x2, y2 = points[(index + 1) % len(points)]
			total += x1 * y2 - x2 * y1
		return abs(total) / 2.0


class _UVLayer:
	def __init__(self, name):
		self.name = name


class _LoopLayerCollection:
	def __init__(self):
		self._uv = []

	def new(self, name="UVMap"):
		layer = _UVLayer(name)
		self._uv.append(layer)
		return layer


class _LoopLayers:
	def __init__(self):
		self.uv = _LoopLayerCollection()


class _LoopLayerNamespace:
	def __init__(self, layers):
		self.layers = layers


class BMesh:
	def __init__(self):
		self._verts = []
		self._faces = []
		self.verts = _BMVertCollection(self)
		self.faces = _BMFaceCollection(self)
		self.loops = _LoopLayerNamespace(_LoopLayers())

	def to_mesh(self, mesh):
		index = {}
		mesh.vertices = []
		for i, vert in enumerate(self.verts):
			index[id(vert)] = i
			mesh.vertices.append(Vector(vert.co))
		mesh.polygons = []
		mesh._loop_vert_indices = []
		mesh.loop_total = sum(len(face.verts) for face in self.faces)

		# Mirror bmesh's per-loop UV layer data into the new mesh
		uv_values = [None] * mesh.loop_total
		loop = 0
		for face in self.faces:
			mesh.polygons.append(Polygon(loop, len(face.verts)))
			for loop_obj in face.loops:
				mesh._loop_vert_indices.append(index[id(loop_obj.vert)])
				for layer, value in loop_obj._uv.items():
					uv_values[loop] = value
				loop += 1

		uv_layer = mesh.uv_layers.new("UVMap")
		for i, value in enumerate(uv_values):
			if value is not None:
				uv_layer.data[i].uv = value
		return mesh

	def normal_update(self):
		pass

	def free(self):
		pass


class _BMVertCollection:
	def __init__(self, bm):
		self._bm = bm

	def new(self, co):
		vert = BMVert(co)
		self._bm._verts.append(vert)
		return vert

	def __iter__(self):
		return iter([v for v in self._bm._verts if not v.dead])

	def __len__(self):
		return len([v for v in self._bm._verts if not v.dead])

	def ensure_lookup_table(self):
		# Real bmesh requires this before indexing/ops; the mock keeps live lists
		pass


class _BMFaceCollection:
	def __init__(self, bm):
		self._bm = bm

	def new(self, verts):
		unique = []
		for vert in verts:
			if vert.dead:
				raise ValueError("dead vert")
			if vert in unique:
				raise ValueError("duplicate vert in face")
			unique.append(vert)
		if len(unique) < 3:
			raise ValueError("face needs 3 verts")
		signature = frozenset(id(v) for v in unique)
		for face in self._bm._faces:
			if not face.dead and frozenset(id(v) for v in face.verts) == signature:
				raise ValueError("face exists")
		face = BMFace(unique)
		self._bm._faces.append(face)
		return face

	def __iter__(self):
		return iter([f for f in self._bm._faces if not f.dead])

	def __len__(self):
		return len([f for f in self._bm._faces if not f.dead])

	def ensure_lookup_table(self):
		pass


def _bmesh_new():
	return BMesh()


def _op_delete(bm, geom, context):
	geometry = list(geom)
	if context in {'FACES', 'FACES_ONLY'}:
		for face in geometry:
			if isinstance(face, BMFace):
				face.dead = True
				for vert in face.verts:
					if face in vert.link_faces:
						vert.link_faces.remove(face)
	elif context == 'VERTS':
		for vert in geometry:
			if not isinstance(vert, BMVert):
				continue
			for face in list(vert.link_faces):
				face.dead = True
				for other in face.verts:
					if face in other.link_faces:
						other.link_faces.remove(face)
			for face in bm.faces:
				if vert in face.verts and not face.dead:
					face.dead = True
			vert.dead = True
	pass


def _op_remove_doubles(bm, verts, dist):
	verts = [v for v in verts if not v.dead]
	parent = {id(v): v for v in verts}

	def find(vert):
		key = id(vert)
		while id(parent[key]) != key:
			key = id(parent[key])
		return parent[key]

	for i, a in enumerate(verts):
		for b in verts[i + 1:]:
			if (a.co.x - b.co.x) ** 2 + (a.co.y - b.co.y) ** 2 + (a.co.z - b.co.z) ** 2 <= dist * dist:
				ra, rb = find(a), find(b)
				if ra is not rb:
					parent[id(rb)] = ra
					rb.dead = True

	seen_signatures = set()
	for face in list(bm.faces):
		if face.dead:
			continue
		remapped = []
		for vert in face.verts:
			root = find(vert)
			if not remapped or remapped[-1] is not root:
				remapped.append(root)
		if len(remapped) > 1 and remapped[0] is remapped[-1]:
			remapped.pop()
		signature = frozenset(id(v) for v in remapped)
		if len(remapped) < 3 or signature in seen_signatures:
			face.dead = True
			for vert in face.verts:
				if face in vert.link_faces:
					vert.link_faces.remove(face)
			continue
		seen_signatures.add(signature)
		for old in face.verts:
			if old not in remapped and face in old.link_faces:
				old.link_faces.remove(face)
		face.verts = remapped
		face.loops = [BMLoop(face, vert) for vert in remapped]
		for vert in remapped:
			if face not in vert.link_faces:
				vert.link_faces.append(face)


###########################################################################
# operator registry

class Operator:
	bl_idname = ""
	bl_label = ""
	bl_options = set()

	def report(self, type, message):
		pass

	@classmethod
	def poll(cls, context):
		return True


class _OperatorNamespace:
	def __init__(self, registry, category):
		self._registry = registry
		self._category = category

	def __getattr__(self, name):
		key = f"{self._category}.{name}"
		if key not in self._registry:
			raise AttributeError(key)

		def call(**kwargs):
			cls = self._registry[key]
			instance = cls()
			context = _data.context
			if not cls.poll(context):
				raise RuntimeError(f"Operator {key} poll failed")
			return instance.execute(context)

		return call


class _Ops:
	def __init__(self):
		self._registry = {}
		self.object = _OperatorNamespace(self._registry, "object")
		self.mesh = _OperatorNamespace(self._registry, "mesh")


###########################################################################
# data / context singletons

class _Data:
	def __init__(self):
		self.objects = _Collection(lambda name, data: Object(name, data))
		self.meshes = _Collection(lambda name: Mesh(name))
		self.collections = []
		self.scenes = []
		self.context = None

	def __repr__(self):
		return "<bpy.data mock>"


_data = _Data()


class _ObjectCollectionView:
	def __init__(self):
		pass

	@property
	def active(self):
		return _state.active

	@active.setter
	def active(self, obj):
		if obj is not None and obj not in list(_data.objects):
			raise RuntimeError("Object not in view layer")
		_state.active = obj

	def __contains__(self, name):
		return name in {obj.name for obj in _data.objects}

	def __iter__(self):
		return iter(list(_data.objects))


class _State:
	def __init__(self):
		self.active = None

	def selected(self):
		return [obj for obj in _data.objects if obj._selected]


_state = _State()


def _scene_objects():
	return _data.objects


class _CollectionLink:
	def link(self, obj):
		if obj not in list(_data.objects):
			_data.objects._items.append(obj)


class _SceneCollection:
	def __init__(self):
		self.objects = _CollectionLink()


class Scene:
	pass


class PropertyGroup:
	pass


_settings_class = [None]


class _SceneMeta(type):
	def __setattr__(cls, name, value):
		if name == "mesh_kit_settings":
			_settings_class[0] = type(value)
			return
		super().__setattr__(name, value)

	def __delattr__(cls, name):
		if name == "mesh_kit_settings":
			_settings_class[0] = None
			return
		super().__delattr__(name)


class _SceneClass(Scene, metaclass=_SceneMeta):
	pass


class SceneInstance:
	def __init__(self):
		self.collection = _SceneCollection()
		self.name = "Scene"
		self._settings = None

	@property
	def mesh_kit_settings(self):
		# Mirrors bpy.types.Scene.mesh_kit_settings registered as a PointerProperty
		if self._settings is None:
			if _settings_class[0] is None:
				raise AttributeError("mesh_kit_settings")
			self._settings = _settings_class[0]()
		return self._settings


class _Context:
	def __init__(self):
		self.scene = SceneInstance()
		self.view_layer = types.SimpleNamespace(objects=_ObjectCollectionView())
		self.collection = self.scene.collection

	@property
	def selected_objects(self):
		return _state.selected()

	@property
	def active_object(self):
		return _state.active

	@property
	def object(self):
		return _state.active

	def evaluated_depsgraph_get(self):
		return object()


def _build():
	bpy = types.ModuleType("bpy")
	bpy.types = types.SimpleNamespace(
		Operator=Operator,
		PropertyGroup=PropertyGroup,
		Scene=_SceneClass,
		Object=Object,
		Panel=type("Panel", (), {"draw": lambda self, context: None}),
		AddonPreferences=type("AddonPreferences", (), {}),
	)
	bpy.data = _data
	bpy.app = types.SimpleNamespace(version_string="mock (offline)", background=True)
	bpy.ops = _Ops()
	bpy.props = types.SimpleNamespace(
		PointerProperty=lambda **kwargs: kwargs.get("type", PropertyGroup)(),
	)

	def register_class(cls):
		if cls.__name__ == "MeshKitSettings":
			return
		if getattr(cls, "bl_idname", ""):
			bpy.ops._registry[cls.bl_idname] = cls

	def unregister_class(cls):
		bpy.ops._registry.pop(getattr(cls, "bl_idname", ""), None)

	bpy.utils = types.SimpleNamespace(
		register_class=register_class,
		unregister_class=unregister_class,
	)

	context = _Context()
	_data.context = context
	_data.scenes = [context.scene]
	bpy.context = context

	bmesh = types.ModuleType("bmesh")
	bmesh.new = _bmesh_new
	bmesh.ops = types.SimpleNamespace(delete=_op_delete, remove_doubles=_op_remove_doubles)
	return bpy, bmesh


def install(repo_root):
	import importlib.util
	import os
	import sys

	# A synthetic package that exposes the real uv_mesh.py with a stub utility_panel
	package = types.ModuleType("Launch_MeshKit")
	package.__path__ = []
	package.__package__ = "Launch_MeshKit"

	panel = types.ModuleType("Launch_MeshKit.utility_panel")
	panel.register_panels = lambda panels: None
	panel.unregister_panels = lambda panels: None

	class MeshKitSettings(PropertyGroup):
		def __init__(self):
			self.uv_mesh_map = ""
			self.uv_mesh_separator = "_"
			self.uv_mesh_weld_distance = 0.000001

	package.MeshKitSettings = MeshKitSettings
	package.MeshKitPreferences = type("MeshKitPreferences", (), {})

	bpy, bmesh = _build()
	sys.modules["bpy"] = bpy
	sys.modules["bmesh"] = bmesh
	sys.modules["mathutils"] = types.SimpleNamespace(Vector=Vector)
	sys.modules["Launch_MeshKit"] = package
	sys.modules["Launch_MeshKit.utility_panel"] = panel

	spec = importlib.util.spec_from_file_location(
		"Launch_MeshKit.uv_mesh",
		os.path.join(repo_root, "uv_mesh.py"),
	)
	module = importlib.util.module_from_spec(spec)
	sys.modules["Launch_MeshKit.uv_mesh"] = module
	spec.loader.exec_module(module)
	package.uv_mesh = module

	return bpy, bmesh, package

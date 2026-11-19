"""Minimal in-memory stubs for the Blender Python API (bpy/bmesh/mathutils).

Only the surface used by Launch_MeshKit.planar_uv and its tests is implemented.
Importing :mod:`blender_stubs` registers ``bpy``, ``bmesh`` and ``mathutils``
in ``sys.modules`` so the production module can be loaded without Blender.

Call :func:`reset` between tests for a clean global state.
"""

import sys
import types
import math


###########################################################################
# mathutils

class Vector:
	def __init__(self, values=(0.0, 0.0, 0.0)):
		self._v = [float(v) for v in values]

	def copy(self):
		return Vector(self._v)

	@property
	def x(self):
		return self._v[0]

	@x.setter
	def x(self, value):
		self._v[0] = float(value)

	@property
	def y(self):
		return self._v[1]

	@y.setter
	def y(self, value):
		self._v[1] = float(value)

	@property
	def z(self):
		return self._v[2]

	@z.setter
	def z(self, value):
		self._v[2] = float(value)

	def __getitem__(self, index):
		return self._v[index]

	def __setitem__(self, index, value):
		self._v[index] = float(value)

	def __len__(self):
		return len(self._v)

	def __iter__(self):
		return iter(self._v)

	def __add__(self, other):
		return Vector([a + b for a, b in zip(self._v, other)])

	def __sub__(self, other):
		return Vector([a - b for a, b in zip(self._v, other)])

	def __mul__(self, scalar):
		return Vector([a * scalar for a in self._v])

	__rmul__ = __mul__

	def __eq__(self, other):
		try:
			return self._v == list(other)
		except TypeError:
			return NotImplemented

	def __repr__(self):
		return f"Vector({tuple(self._v)})"


class Matrix:
	def __init__(self, rows):
		self.rows = [list(row) for row in rows]

	@staticmethod
	def Identity(size):
		return Matrix([[1.0 if i == j else 0.0 for j in range(size)] for i in range(size)])

	@staticmethod
	def Translation(vector):
		rows = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
		rows[0][3] = vector[0]
		rows[1][3] = vector[1]
		rows[2][3] = vector[2]
		return Matrix(rows)

	def __matmul__(self, other):
		if isinstance(other, Vector):
			v = list(other) + [1.0]
			out = [sum(row[j] * v[j] for j in range(4)) for row in self.rows[:3]]
			return Vector(out)
		raise NotImplementedError("Only matrix @ vector is stubbed")


mathutils = types.ModuleType("mathutils")
mathutils.Vector = Vector
mathutils.Matrix = Matrix


###########################################################################
# bmesh

class BMLayerUV:
	def __init__(self, name):
		self.name = name
		self.is_stub_layer = True


class _UVRef:
	"""Stand-in for loop[layer].uv, backed by the mesh's per-layer store."""

	def __init__(self, mesh, layer, loop_index):
		self._mesh = mesh
		self._layer = layer
		self._index = loop_index

	@property
	def uv(self):
		store = self._mesh.loop_uvs.setdefault(self._layer.name, {})
		return Vector(store.get(self._index, (0.0, 0.0)))

	@uv.setter
	def uv(self, value):
		store = self._mesh.loop_uvs.setdefault(self._layer.name, {})
		store[self._index] = (float(value[0]), float(value[1]))


class BMLoop:
	def __init__(self, bm, bm_vert, mesh_loop):
		self._bm = bm
		self.vert = bm_vert
		self._mesh_loop = mesh_loop

	def __getitem__(self, layer):
		return _UVRef(self._bm._mesh, layer, self._mesh_loop.index)


class BMFace:
	def __init__(self, bm, mesh_poly, loops):
		self._bm = bm
		self._poly = mesh_poly
		self.loops = loops
		self.index = mesh_poly.index

	@property
	def select(self):
		return self._poly.select

	@select.setter
	def select(self, value):
		self._poly.select = bool(value)


class BMVert:
	def __init__(self, mesh_vert):
		self._vert = mesh_vert

	@property
	def co(self):
		return self._vert.co

	@property
	def select(self):
		return self._vert.select

	@select.setter
	def select(self, value):
		self._vert.select = bool(value)


class _UVLayerAccess:
	def __init__(self, bm):
		self._bm = bm

	@property
	def active(self):
		return self._bm._layers[0] if self._bm._layers else None

	def new(self, name):
		layer = BMLayerUV(name)
		self._bm._layers.append(layer)
		return layer

	def remove(self, layer):
		self._bm._layers = [item for item in self._bm._layers if item is not layer]


class _BMLoopLayers:
	def __init__(self, bm):
		self.uv = _UVLayerAccess(bm)


class _BMLoops:
	def __init__(self, bm):
		self.layers = _BMLoopLayers(bm)


class BMesh:
	def __init__(self, mesh):
		self._mesh = mesh
		self._layers = [BMLayerUV(layer.name) for layer in mesh.uv_layers]
		self.verts = [BMVert(vert) for vert in mesh.verts]
		self.loops = _BMLoops(self)
		self.faces = []
		for poly in mesh.polygons:
			face_loops = []
			for loop_index in range(poly.loop_start, poly.loop_start + poly.loop_total):
				mesh_loop = mesh.loops[loop_index]
				bm_vert = self.verts[mesh_loop.vert_index]
				face_loops.append(BMLoop(self, bm_vert, mesh_loop))
			self.faces.append(BMFace(self, poly, face_loops))


_bmesh_cache = {}


def from_edit_mesh(mesh):
	bm = _bmesh_cache.get(mesh)
	if bm is None:
		bm = BMesh(mesh)
		_bmesh_cache[mesh] = bm
	return bm


def update_edit_mesh(mesh):
	bm = _bmesh_cache.get(mesh)
	if bm is None:
		return
	# Sync layer existence/order back into the mesh data.
	wanted = [layer.name for layer in bm._layers]
	for layer in list(mesh.uv_layers):
		if layer.name not in wanted:
			mesh.uv_layers._remove(layer.name)
	for name in wanted:
		if mesh.uv_layers.get(name) is None:
			mesh.uv_layers._create(name)
	mesh.uv_layers._active_name = wanted[0] if wanted else None


bmesh = types.ModuleType("bmesh")
bmesh.from_edit_mesh = from_edit_mesh
bmesh.update_edit_mesh = update_edit_mesh


###########################################################################
# bpy

class FakeUVLayerData:
	def __init__(self, name, loop_count):
		self.name = name
		self.uv = [Vector((0.0, 0.0)) for _ in range(loop_count)]


class FakeUVLayers:
	def __init__(self, mesh):
		self._mesh = mesh
		self._layers = []
		self._active_name = None

	def _create(self, name):
		layer = FakeUVLayerData(name, len(self._mesh.loops))
		self._layers.append(layer)
		if self._active_name is None:
			self._active_name = name
		return layer

	def new(self, name="UVMap"):
		return self._create(name)

	def _remove(self, name):
		self._layers = [layer for layer in self._layers if layer.name != name]
		if self._active_name == name:
			self._active_name = self._layers[0].name if self._layers else None
		self._mesh.loop_uvs.pop(name, None)

	def get(self, name):
		for layer in self._layers:
			if layer.name == name:
				return layer
		return None

	@property
	def active(self):
		return self.get(self._active_name) if self._active_name else None

	def __contains__(self, name):
		return self.get(name) is not None

	def __iter__(self):
		return iter(self._layers)

	def __len__(self):
		return len(self._layers)


class FakeVert:
	def __init__(self, co):
		self.co = Vector(co)
		self.select = False


class FakePoly:
	def __init__(self, index, loop_start, loop_total):
		self.index = index
		self.loop_start = loop_start
		self.loop_total = loop_total
		self.select = False


class FakeLoop:
	def __init__(self, index, vert_index):
		self.index = index
		self.vert_index = vert_index


class FakeMesh:
	def __init__(self, name, vert_coords, face_vert_indices):
		self.name = name
		self.verts = [FakeVert(co) for co in vert_coords]
		self.loops = []
		self.polygons = []
		for face_index, vert_indices in enumerate(face_vert_indices):
			loop_start = len(self.loops)
			for vert_index in vert_indices:
				self.loops.append(FakeLoop(len(self.loops), vert_index))
			self.polygons.append(FakePoly(face_index, loop_start, len(vert_indices)))
		self.uv_layers = FakeUVLayers(self)
		# Per-layer dict of {loop_index: (u, v)} written through bmesh.
		self.loop_uvs = {}

	@property
	def vertices(self):
		# Blender mesh data exposes geometry as both .verts (bmesh-free access
		# uses .vertices in the operators' empty-geometry guard).
		return self.verts

	def update_tag(self):
		pass


class FakeObjects:
	def __init__(self, view_layer):
		self._view_layer = view_layer
		self.active = None
		self._all = []

	def __iter__(self):
		return iter(self._all)

	def __len__(self):
		return len(self._all)


class FakeViewLayer:
	def __init__(self):
		self.objects = FakeObjects(self)


class FakeObject:
	def __init__(self, name, data, view_layer, object_type="MESH", matrix_world=None):
		self.name = name
		self.type = object_type
		self.data = data
		self.mode = "OBJECT"
		self.selected = False
		self.matrix_world = matrix_world if matrix_world is not None else Matrix.Identity(4)
		self._view_layer = view_layer
		view_layer.objects._all.append(self)

	@property
	def view_layer(self):
		return self._view_layer

	def select_set(self, state):
		self.selected = bool(state)


class FakeDataObjects:
	def __init__(self):
		self._objects = []

	def register(self, obj):
		if obj not in self._objects:
			self._objects.append(obj)

	def get(self, name):
		for obj in self._objects:
			if obj.name == name:
				return obj
		return None

	def __contains__(self, name):
		return self.get(name) is not None


class FakeScene:
	def __init__(self):
		self.mesh_kit_settings = None


class FakeContext:
	def __init__(self, view_layer, scene):
		self.view_layer = view_layer
		self.scene = scene

	@property
	def selected_objects(self):
		return [obj for obj in self.view_layer.objects._all if obj.selected]

	@property
	def active_object(self):
		return self.view_layer.objects.active


def _default_mode_set(mode=None):
	ctx = bpy._context
	if ctx is None:
		raise RuntimeError("No active context")
	obj = ctx.view_layer.objects.active
	if obj is None:
		raise RuntimeError("Context has no active object")
	if mode not in ("OBJECT", "EDIT"):
		raise RuntimeError(f"Unsupported stub mode {mode!r}")
	obj.mode = mode


class _OpsObject:
	def __init__(self):
		self.mode_set = _default_mode_set


class _Ops:
	def __init__(self):
		self.object = _OpsObject()


class _OperatorBase:
	pass


class _PanelBase:
	pass


class _Types:
	Operator = _OperatorBase
	Panel = _PanelBase


class _Utils:
	@staticmethod
	def register_class(cls):
		pass

	@staticmethod
	def unregister_class(cls):
		pass


bpy = types.ModuleType("bpy")
bpy.types = _Types()
bpy.utils = _Utils()
bpy.ops = _Ops()
bpy.data = types.SimpleNamespace(objects=FakeDataObjects())
bpy.app = types.SimpleNamespace()
bpy._context = None


###########################################################################
# Factory helpers and reset

def new_world():
	"""Return a fresh (context, scene, view_layer) trio."""
	view_layer = FakeViewLayer()
	scene = FakeScene()
	context = FakeContext(view_layer, scene)
	bpy._context = context
	return context, scene, view_layer


def make_object(view_layer, name, mesh=None, object_type="MESH", selected=False,
				active=False, matrix_world=None, data=None):
	obj_data = data if data is not None else mesh
	obj = FakeObject(name, obj_data, view_layer, object_type, matrix_world)
	bpy.data.objects.register(obj)
	if selected:
		obj.select_set(True)
	if active:
		view_layer.objects.active = obj
	return obj


def reset():
	"""Restore global stub state between tests."""
	bpy.data = types.SimpleNamespace(objects=FakeDataObjects())
	bpy.ops = _Ops()
	bpy._context = None
	_bmesh_cache.clear()


def install():
	sys.modules["bpy"] = bpy
	sys.modules["bmesh"] = bmesh
	sys.modules["mathutils"] = mathutils

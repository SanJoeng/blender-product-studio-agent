"""Generic editable bottle/box fixture for first-run and integration tests.
Dimensions/materials are illustrative; this is not a measured product model.
"""
import bpy
import math
from mathutils import Vector

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
scene.unit_settings.length_unit = 'MILLIMETERS'
scene.render.engine = 'CYCLES'
scene.cycles.samples = 64
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 10
scene.cycles.transmission_bounces = 8
scene.render.resolution_x = 1000
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.8, .84, .87, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .15

def linear(v):
    return v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4

def material(name, rgb, rough=.4, metal=0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*[linear(v) for v in rgb], 1)
    shader.inputs['Roughness'].default_value = rough
    shader.inputs['Metallic'].default_value = metal
    return m

def paper(name, rgb):
    m = material(name, rgb, .48)
    n, l = m.node_tree.nodes, m.node_tree.links
    geo = n.new('ShaderNodeNewGeometry')
    noise = n.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value = 3200
    bump = n.new('ShaderNodeBump'); bump.inputs['Strength'].default_value = .12
    bump.inputs['Distance'].default_value = .000025
    l.new(geo.outputs['Position'], noise.inputs['Vector'])
    l.new(noise.outputs['Fac'], bump.inputs['Height'])
    l.new(bump.outputs['Normal'], n.get('Principled BSDF').inputs['Normal'])
    return m

green = paper('Paper | forest green', (.17, .27, .24))
ivory = paper('Paper | warm ivory', (.80, .77, .69))
gold = material('Metal | champagne satin', (.69, .57, .38), .3, 1)
ink = material('Ink | ivory', (.86, .82, .71), .52)
glass = material('Glass | amber, 1.2mm wall', (1, 1, 1), .075)
glass.node_tree.nodes['Principled BSDF'].inputs['Transmission Weight'].default_value = 1
glass.node_tree.nodes['Principled BSDF'].inputs['IOR'].default_value = 1.48
absorb = glass.node_tree.nodes.new('ShaderNodeVolumeAbsorption')
absorb.inputs['Color'].default_value = (.53, .21, .045, 1)
absorb.inputs['Density'].default_value = 80
glass.node_tree.links.new(absorb.outputs['Volume'], glass.node_tree.nodes['Material Output'].inputs['Volume'])
liquid = material('Liquid | transparent amber', (.9, .72, .44), .045)
liquid.node_tree.nodes['Principled BSDF'].inputs['Transmission Weight'].default_value = 1
liquid.node_tree.nodes['Principled BSDF'].inputs['IOR'].default_value = 1.333

product = bpy.data.collections.new('Product')
scene.collection.children.link(product)
def move_to_product(ob):
    for c in list(ob.users_collection): c.objects.unlink(ob)
    product.objects.link(ob)
    return ob

def lathe(name, profile, mat, center=(.046, -.03, 0), segments=96):
    verts, faces, rings = [], [], []
    for radius, z in profile:
        count = segments if radius > 0 else 1
        ring = []
        for i in range(count):
            a = 2 * math.pi * i / segments
            ring.append(len(verts)); verts.append((radius * math.cos(a), radius * math.sin(a), z))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1:
            faces += [(a[0], b[(i + 1) % segments], b[i]) for i in range(segments)]
        elif len(b) == 1:
            faces += [(a[i], a[(i + 1) % segments], b[0]) for i in range(segments)]
        else:
            faces += [(a[i], a[(i + 1) % segments], b[(i + 1) % segments], b[i]) for i in range(segments)]
    mesh = bpy.data.meshes.new(name); mesh.from_pydata(verts, [], faces); mesh.update()
    ob = bpy.data.objects.new(name, mesh); product.objects.link(ob); ob.location = center
    ob.data.materials.append(mat)
    for p in mesh.polygons: p.use_smooth = True
    return ob

# A closed cross-section creates real inner/outer walls and a thicker floor.
lathe('Bottle | thick-walled glass', [(0,0),(.010,0),(.0122,.0006),(.013,.0025),(.013,.065),(.0128,.069),(.0115,.073),(.0086,.079),(.0086,.083),(.0074,.083),(.0074,.079),(.0105,.072),(.0118,.068),(.0118,.004),(.010,.003),(0,.003)], glass)
lathe('Bottle | liquid', [(0,.0035),(.0105,.0035),(.01145,.005),(.01145,.057),(.0113,.058),(0,.0575)], liquid)
lathe('Bottle | paper label', [(.0131,.01),(.0131,.061)], green)

def cylinder(name, radius, depth, location, mat, vertices=96):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    ob = move_to_product(bpy.context.object); ob.name = name; ob.data.materials.append(mat)
    bevel = ob.modifiers.new('Manufactured edges', 'BEVEL'); bevel.width=.00025; bevel.segments=3
    for poly in ob.data.polygons: poly.use_smooth = len(poly.vertices)==4
    return ob

cylinder('Cap | brushed metal', .0097, .017, (.046,-.03,.0915), gold)
for i in range(64):
    a=2*math.pi*i/64
    cylinder('Cap | fine grip %02d'%i, .00019, .014, (.046+.0097*math.cos(a),-.03+.0097*math.sin(a),.0915), gold, 6)
cylinder('Cap | lower seal', .0097, .002, (.046,-.03,.0808), gold)

def cube(name, size, location, mat, bevel=.0005, is_product=True):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    ob=bpy.context.object; ob.name=name; ob.dimensions=size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if is_product: move_to_product(ob)
    ob.data.materials.append(mat)
    mod=ob.modifiers.new('Real edge radius','BEVEL'); mod.width=bevel; mod.segments=3
    ob.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
    return ob

cube('Carton | lower tray', (.075,.034,.021), (-.028,.022,.0105), ivory)
cube('Carton | closed sleeve', (.075,.034,.101), (-.028,.022,.0715), green)

def lettering(name, body, size, location, mat):
    c=bpy.data.curves.new(name,'FONT'); c.body=body; c.size=size; c.align_x='CENTER'; c.space_line=1.25; c.extrude=.000006
    ob=bpy.data.objects.new(name,c); product.objects.link(ob); ob.location=location; ob.rotation_euler=(math.pi/2,0,0); ob.data.materials.append(mat)
    return ob

lettering('Carton | title','PRODUCT\nSTUDIO',.0065,(-.028,.0047,.094),ink)
lettering('Carton | edition','MATERIAL / 01',.0024,(-.028,.0047,.03),ink)
lettering('Carton | footer','A STUDY IN FORM',.0023,(-.028,.0047,.0105),gold)
lettering('Bottle | type','FORM\n01',.003,(.046,-.04325,.048),ink)
lettering('Bottle | size','25 mL',.0017,(.046,-.0433,.018),ink)

floor=material('Studio | warm neutral surface',(.70,.70,.66),.34)
cube('Studio | ground',(200,200,.02),(0,0,-.01),floor,.001,False)

def aim(ob, target): ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
def area(name, pos, target, power, size, size_y=None):
    data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.shape='RECTANGLE' if size_y else 'DISK'; data.size=size
    if size_y: data.size_y=size_y
    ob=bpy.data.objects.new(name,data); scene.collection.objects.link(ob); ob.location=pos; aim(ob,target)

target=(0,0,.055)
area('Light | broad key',(-.18,-.24,.27),target,3.6,.22,.3)
area('Light | gentle fill',(.22,-.13,.19),target,1.6,.2,.26)
area('Light | glass rim',(.08,.15,.23),target,4,.08,.23)
area('Light | overhead',(-.03,.03,.38),target,1,.2)
camdata=bpy.data.cameras.new('Camera | 85mm'); cam=bpy.data.objects.new('Camera | 85mm',camdata); scene.collection.objects.link(cam)
cam.location=(.22,-.48,.24); aim(cam,(0,.005,.06)); camdata.lens=85; camdata.dof.use_dof=False; scene.camera=cam

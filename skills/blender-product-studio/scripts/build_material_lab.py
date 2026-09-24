"""Build a new, isolated material sample studio; never load or edit a product file.

Import create_material/create_light_rig for additive use in explicit scene scripts.
Presets are illustrative starting points, not measured material specifications.
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene_report import cli_args, digest


def load_presets(path=None):
    source = Path(path) if path else Path(__file__).resolve().parent.parent / 'assets/material-presets.json'
    data = json.loads(source.read_text(encoding='utf-8'))
    if data.get('schema_version') != 1 or not data.get('presets'):
        raise ValueError('Expected material preset schema 1 with nonempty presets')
    return data['presets']


def linear_rgba(hex_color):
    value = hex_color.removeprefix('#')
    if len(value) != 6:
        raise ValueError('Expected six-digit sRGB hex color')
    rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb) + (1.0,)


def create_material(key, spec, meters_per_unit=1.0):
    """Create a new material without assigning it or modifying existing datablocks.

    Object-space textures assume unit object scale. Active UV defines brush tangent.
    """
    if not math.isfinite(meters_per_unit) or meters_per_unit <= 0:
        raise ValueError('meters_per_unit must be finite and positive')
    mat = bpy.data.materials.new(f'BPS::{key}')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    surface = nodes.new('ShaderNodeBsdfPrincipled')
    surface.location = (380, 80)
    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (720, 80)
    links.new(surface.outputs['BSDF'], output.inputs['Surface'])
    mapping = {'roughness': 'Roughness', 'metallic': 'Metallic', 'ior': 'IOR',
               'transmission': 'Transmission Weight', 'coat': 'Coat Weight',
               'coat_roughness': 'Coat Roughness', 'subsurface': 'Subsurface Weight'}
    surface.inputs['Base Color'].default_value = linear_rgba(spec['base_srgb'])
    for key_name, socket in mapping.items():
        if key_name in spec:
            if surface.inputs.get(socket) is None:
                raise RuntimeError(f'This Blender version lacks Principled input {socket}')
            surface.inputs[socket].default_value = spec[key_name]
    if spec.get('subsurface'):
        surface.inputs['Subsurface Scale'].default_value = spec['subsurface_scale_m'] / meters_per_unit
        surface.inputs['Subsurface Radius'].default_value = (1.0, 1.0, 1.0)
    if spec.get('anisotropy'):
        anisotropic = surface.inputs.get('Anisotropic') or surface.inputs.get('Anisotropy')
        if anisotropic is None:
            raise RuntimeError('This Blender version lacks Principled anisotropy')
        anisotropic.default_value = spec['anisotropy']
        tangent = nodes.new('ShaderNodeTangent')
        tangent.direction_type = 'UV_MAP'
        tangent.location = (100, -300)
        tangent.label = 'Active UV U direction; verify on the product'
        links.new(tangent.outputs['Tangent'], surface.inputs['Tangent'])
    if spec.get('micro_pitch_m'):
        tex = nodes.new('ShaderNodeTexCoord')
        tex.location = (-760, 40)
        stretch = nodes.new('ShaderNodeVectorMath')
        stretch.operation = 'MULTIPLY'
        stretch.inputs[1].default_value = spec.get('coordinate_stretch', (1, 1, 1))
        stretch.location = (-580, 40)
        links.new(tex.outputs['Object'], stretch.inputs[0])
        noise = nodes.new('ShaderNodeTexNoise')
        noise.location = (-380, 40)
        noise.inputs['Scale'].default_value = meters_per_unit / spec['micro_pitch_m']
        noise.inputs['Detail'].default_value = 2.0
        noise.inputs['Roughness'].default_value = 0.5
        links.new(stretch.outputs['Vector'], noise.inputs['Vector'])
        bump = nodes.new('ShaderNodeBump')
        bump.location = (120, -80)
        bump.inputs['Strength'].default_value = 0.25
        bump.inputs['Distance'].default_value = spec['micro_height_m'] / meters_per_unit
        links.new(noise.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs['Normal'], surface.inputs['Normal'])
        variance = spec.get('roughness_variation', 0)
        if variance:
            remap = nodes.new('ShaderNodeMapRange')
            remap.location = (-100, 140)
            remap.inputs['To Min'].default_value = max(0, spec['roughness'] - variance)
            remap.inputs['To Max'].default_value = min(1, spec['roughness'] + variance)
            links.new(noise.outputs['Fac'], remap.inputs['Value'])
            links.new(remap.outputs['Result'], surface.inputs['Roughness'])
    if spec.get('absorption_density_per_m'):
        volume = nodes.new('ShaderNodeVolumeAbsorption')
        volume.location = (380, -440)
        volume.inputs['Color'].default_value = linear_rgba(spec['absorption_srgb'])
        volume.inputs['Density'].default_value = spec['absorption_density_per_m'] * meters_per_unit
        links.new(volume.outputs['Volume'], output.inputs['Volume'])
    mat.diffuse_color = linear_rgba(spec['base_srgb'])
    mat.use_fake_user = True
    mat['bps_preset_id'] = key
    mat['bps_evidence_status'] = 'illustrative_unmeasured'
    mat['bps_spec_json'] = json.dumps(spec, ensure_ascii=False, sort_keys=True)
    mat['bps_meters_per_unit'] = meters_per_unit
    mat.asset_mark()
    mat.asset_data.description = f'{spec.get("label", key)}. Unmeasured starting point; verify on actual product geometry and lighting.'
    return mat


def aim(ob, target, axis='-Z'):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat(axis, 'Y').to_euler()


def card(collection, name, center, dimensions, target, material):
    width, height = dimensions
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(-width/2, -height/2, 0), (width/2, -height/2, 0),
                      (width/2, height/2, 0), (-width/2, height/2, 0)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new(name, mesh)
    collection.objects.link(ob)
    ob.location = center
    aim(ob, target, 'Z')
    ob.data.materials.append(material)
    ob.visible_camera = False
    ob['bps_role'] = 'reflection_card_not_visible_to_camera'
    return ob


def create_light_rig(scene, kind='neutral', target=(0, 0, 0), span_m=0.3):
    """Add a new collection only; do not hide/delete existing lights or set World."""
    if kind not in {'neutral', 'surface', 'glass'}:
        raise ValueError('Unknown rig')
    if not math.isfinite(span_m) or span_m <= 0:
        raise ValueError('span_m must be finite and positive')
    unit = scene.unit_settings.scale_length
    span = span_m / unit
    center = Vector(target)
    collection = bpy.data.collections.new(f'BPS_Rig_{kind}')
    scene.collection.children.link(collection)
    collection['bps_role'] = 'additive_photography_rig'
    collection['bps_reference_span_m'] = span_m
    presets = {
        'neutral': [('Key', (-1.2, -1.6, 1.7), 2.0, 2.5, 65),
                    ('Fill', (1.5, -1.2, 0.6), 1.8, 2.2, 40),
                    ('Top', (0.0, 0.6, 2.2), 1.7, 1.0, 45)],
        'surface': [('Key', (-1.0, -1.1, 0.8), 0.45, 2.4, 35),
                    ('Fill', (1.7, -1.2, 0.5), 1.7, 2.2, 28),
                    ('Top', (0.2, 0.5, 2.0), 1.4, 0.6, 45)],
        'glass': [('EdgeL', (-1.1, 0.3, 0.6), 0.45, 2.3, 50),
                  ('EdgeR', (1.1, 0.3, 0.6), 0.45, 2.3, 50),
                  ('Front', (0.0, -1.8, 1.0), 1.8, 2.0, 24)]}
    for name, offset, width, height, watts in presets[kind]:
        data = bpy.data.lights.new(f'BPS_{kind}_{name}', 'AREA')
        data.shape = 'RECTANGLE'
        data.size, data.size_y = width * span, height * span
        data.energy = watts * 0.18 * (span_m / 0.3) ** 2
        ob = bpy.data.objects.new(data.name, data)
        collection.objects.link(ob)
        ob.location = center + Vector(offset) * span
        aim(ob, center)
        ob['bps_role'] = name
    white = create_material('card_white', {'base_srgb': 'dedede', 'roughness': 0.9, 'metallic': 0})
    black = create_material('card_black', {'base_srgb': '151515', 'roughness': 0.95, 'metallic': 0})
    card(collection, 'BPS_WhiteBounce', center + Vector((0.1, -1.3, -0.65)) * span,
         (1.5 * span, 0.8 * span), center, white)
    card(collection, 'BPS_BlackFlag', center + Vector((1.2, -0.2, 0.1)) * span,
         (0.20 * span, 1.8 * span), center, black)
    return collection


def place_in_collection(ob, collection):
    for existing in list(ob.users_collection):
        existing.objects.unlink(ob)
    collection.objects.link(ob)


def box(collection, name, center, dimensions, material, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center)
    ob = bpy.context.object
    ob.name = name
    ob.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    place_in_collection(ob, collection)
    ob.data.materials.append(material)
    if bevel:
        modifier = ob.modifiers.new('Physical edge radius', 'BEVEL')
        modifier.width, modifier.segments = bevel, 3
        modifier = ob.modifiers.new('Weighted surface normals', 'WEIGHTED_NORMAL')
    return ob


def cup(collection, name, center, material):
    """Closed, manifold cup wall with open cavity; UV U follows the circumference."""
    profile = [(0, 0), (0.017, 0), (0.021, 0.003), (0.022, 0.008),
               (0.022, 0.068), (0.0217, 0.070), (0.0205, 0.071),
               (0.0193, 0.070), (0.019, 0.068), (0.019, 0.008),
               (0.017, 0.005), (0, 0.005)]
    vertices, rings, faces = [], [], []
    count = 96
    for radius, height in profile:
        ring = []
        for index in range(count if radius else 1):
            angle = 2 * math.pi * index / count
            ring.append(len(vertices))
            vertices.append((radius * math.cos(angle), radius * math.sin(angle), height))
        rings.append(ring)
    for a, b in zip(rings, rings[1:]):
        for j in range(count):
            k = (j + 1) % count
            if len(a) == 1:
                faces.append((a[0], b[k], b[j]))
            elif len(b) == 1:
                faces.append((a[j], a[k], b[0]))
            else:
                faces.append((a[j], a[k], b[k], b[j]))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    uv = mesh.uv_layers.new(name='SurfaceUV')
    for poly in mesh.polygons:
        poly.use_smooth = True
        values = []
        for loop in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            values.append((loop, (math.atan2(co.y, co.x) / (2 * math.pi)) % 1, co.z / 0.071))
        seam = max(v[1] for v in values) - min(v[1] for v in values) > 0.5
        for loop, u, v in values:
            uv.data[loop].uv = (u + 1 if seam and u < 0.5 else u, v)
    ob = bpy.data.objects.new(name, mesh)
    collection.objects.link(ob)
    ob.location = center
    mesh.materials.append(material)
    return ob


def label(collection, name, body, position, material, size=0.006):
    font = bpy.data.curves.new(name, 'FONT')
    font.body, font.size, font.align_x = body, size, 'CENTER'
    font.align_y = 'CENTER'
    ob = bpy.data.objects.new(name, font)
    collection.objects.link(ob)
    ob.location = position
    ob.rotation_euler[0] = math.pi / 2
    font.materials.append(material)
    return ob


def build_lab(keys, presets, rig):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = 'BPS_MaterialLab'
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'MILLIMETERS'
    scene.unit_settings.scale_length = 1
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 8
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure = 0
    if hasattr(scene.view_settings, 'use_white_balance'):
        scene.view_settings.use_white_balance = False
    collection = bpy.data.collections.new('BPS_Swatches')
    scene.collection.children.link(collection)
    stage = bpy.data.collections.new('BPS_Stage')
    scene.collection.children.link(stage)
    base = create_material('stage', {'base_srgb': '333a3e', 'roughness': 0.75, 'metallic': 0})
    plinth = create_material('plinth', {'base_srgb': '555b5f', 'roughness': 0.6, 'metallic': 0})
    ink = create_material('type', {'base_srgb': 'eeeeee', 'roughness': 0.85, 'metallic': 0})
    columns = min(4, len(keys))
    rows = math.ceil(len(keys) / columns)
    width, height = columns * 0.145 + 0.045, rows * 0.133 + 0.075
    for index, key in enumerate(keys):
        x = (index % columns - (columns - 1) / 2) * 0.145
        z = (rows - 1 - index // columns) * 0.133 + 0.060
        material = create_material(key, presets[key])
        cup(collection, f'Swatch::{key}::cup', (x - 0.027, 0, z), material)
        box(collection, f'Swatch::{key}::panel', (x + 0.027, 0.012, z + 0.035),
            (0.04, 0.004, 0.070), material, 0.0008)
        box(stage, f'Plinth::{key}', (x, 0.003, z - 0.005), (0.128, 0.085, 0.010), plinth, 0.001)
        label(stage, f'Label::{key}', presets[key]['label'], (x, -0.0428, z - 0.019), ink)
    box(stage, 'Backdrop', (0, 0.085, height / 2), (width * 1.5, 0.015, height * 1.5), base)
    label(stage, 'Title', 'MATERIAL STUDY / ' + rig.upper(), (0, -0.003, height - 0.018), ink, 0.011)
    label(stage, 'Disclaimer', 'ILLUSTRATIVE STARTERS - NOT MEASURED PRODUCT MATERIALS', (0, -0.003, 0.012), ink, 0.006)
    target = (0, 0.0, height / 2)
    create_light_rig(scene, rig, target=target, span_m=max(width, height))
    world = bpy.data.worlds.new('BPS_NeutralWorld')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.5, 0.5, 0.5, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.3
    scene.world = world
    data = bpy.data.cameras.new('BPS_LabCamera')
    camera = bpy.data.objects.new(data.name, data)
    scene.collection.objects.link(camera)
    camera.location = (0, -1.4, height / 2 + 0.15)
    aim(camera, target)
    data.type = 'ORTHO'
    data.ortho_scale = max(width, height) * 1.1
    data.lens = 85
    data.clip_start, data.clip_end = 0.01, 100
    data.dof.use_dof = False
    scene.camera = camera
    scene.render.resolution_x = 1440
    scene.render.resolution_y = round(1440 * height / width)
    scene.render.resolution_percentage = 100
    scene['bps_status'] = 'Unmeasured material/light starting points; validate against actual product photos.'
    scene['bps_preset_ids'] = ','.join(keys)
    return scene


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--rig', choices=['neutral', 'surface', 'glass'], default='neutral')
    parser.add_argument('--presets', help='Comma-separated preset IDs; default all')
    args = parser.parse_args(cli_args())
    if not bpy.app.background or bpy.data.filepath:
        raise RuntimeError('Use a new background --factory-startup process without a source .blend')
    output = Path(args.output).expanduser().resolve()
    if output.suffix.lower() != '.blend':
        raise ValueError('Output must end in .blend')
    report = output.with_suffix('.lab.json')
    if output.exists() or report.exists():
        raise FileExistsError('Refusing to overwrite a lab or its report')
    presets = load_presets()
    keys = [key.strip() for key in args.presets.split(',')] if args.presets else list(presets)
    if len(keys) != len(set(keys)) or any(key not in presets for key in keys):
        raise ValueError('Preset IDs must exist and must not be repeated')
    scene = build_lab(keys, presets, args.rig)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output))
    data = {'blender_version': bpy.app.version_string, 'scene': scene.name,
            'output': str(output), 'sha256': digest(output), 'presets': keys, 'rig': args.rig,
            'status': 'built_not_product_calibrated', 'geometry_units': 'meters',
            'view_transform': scene.view_settings.view_transform, 'look': scene.view_settings.look,
            'exposure': scene.view_settings.exposure}
    with report.open('x', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    print(json.dumps(data, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

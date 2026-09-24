"""Read-only Blender scene/dependency report; run with Blender --python."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector


def cli_args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def floats(values):
    return [round(float(v), 9) for v in values]


def matrix_rows(matrix):
    return [floats(row) for row in matrix]


def resolve_external(path, library=None):
    return str(Path(bpy.path.abspath(path, library=library)).resolve()) if path else None


def select_scene(name=None):
    scene = bpy.data.scenes.get(name) if name else bpy.context.scene
    if scene is None:
        raise ValueError(f'Scene not found: {name}')
    if bpy.context.scene != scene:
        if bpy.context.window is None:
            raise RuntimeError('Cannot select another scene without a context window')
        bpy.context.window.scene = scene
    return scene


def dependencies():
    libraries, images, missing, unverified = [], [], [], []
    for lib in bpy.data.libraries:
        path = resolve_external(lib.filepath, getattr(lib, 'parent', None))
        packed = bool(getattr(lib, 'packed_file', None))
        exists = bool(path and Path(path).is_file())
        item = {'name': lib.name, 'stored_path': lib.filepath, 'path': path,
                'packed': packed, 'exists': exists}
        if exists:
            stat = Path(path).stat()
            item.update(size_bytes=stat.st_size, mtime_ns=stat.st_mtime_ns)
        if not packed and not exists:
            missing.append({'kind': 'library', 'path': path, 'name': lib.name})
        libraries.append(item)
    for image in bpy.data.images:
        if image.source in {'VIEWER', 'GENERATED'}:
            continue
        packed = bool(image.packed_file or len(image.packed_files))
        path = resolve_external(image.filepath, image.library)
        ordinary_file = image.source in {'FILE', 'MOVIE'}
        exists = bool(path and Path(path).is_file()) if ordinary_file else None
        item = {'name': image.name, 'source': image.source, 'path': path,
                'packed': packed, 'exists': exists, 'size': list(image.size),
                'color_space': image.colorspace_settings.name, 'alpha_mode': image.alpha_mode}
        images.append(item)
        if not packed and ordinary_file and not exists:
            missing.append({'kind': 'image', 'path': path, 'name': image.name})
        if not packed and not ordinary_file:
            unverified.append({'kind': image.source, 'path': path, 'name': image.name})
    return {'libraries': libraries, 'images': images, 'missing': missing,
            'unverified_sequences_or_tiles': unverified,
            'limits': 'Fonts, simulation caches and external files referenced by custom nodes require separate inspection.'}


def compositor_outputs(scene):
    if not scene.render.use_compositing:
        return []
    tree = getattr(scene, 'compositing_node_group', None)
    if tree is None:
        tree = getattr(scene, 'node_tree', None)
    stack, seen, outputs = [tree] if tree else [], set(), []
    while stack:
        tree = stack.pop()
        if tree.as_pointer() in seen:
            continue
        seen.add(tree.as_pointer())
        for node in tree.nodes:
            if node.mute:
                continue
            if node.bl_idname == 'CompositorNodeOutputFile':
                outputs.append({'tree': tree.name, 'node': node.name})
            nested = getattr(node, 'node_tree', None)
            if nested is not None:
                stack.append(nested)
    return outputs


def camera_info(camera, depsgraph):
    if camera is None:
        return None
    evaluated = camera.evaluated_get(depsgraph)
    data = evaluated.data
    return {'name': camera.name, 'type': data.type, 'lens_mm': data.lens,
            'sensor_mm': [data.sensor_width, data.sensor_height], 'sensor_fit': data.sensor_fit,
            'ortho_scale': data.ortho_scale, 'shift': [data.shift_x, data.shift_y],
            'matrix_world': matrix_rows(evaluated.matrix_world),
            'dof': {'enabled': data.dof.use_dof, 'fstop': data.dof.aperture_fstop,
                    'focus_distance': data.dof.focus_distance,
                    'focus_object': data.dof.focus_object.name if data.dof.focus_object else None},
            'constraints': [{'name': c.name, 'type': c.type, 'muted': c.mute} for c in camera.constraints]}


def render_info(scene):
    render, view = scene.render, scene.view_settings
    return {'engine': render.engine, 'base_size': [render.resolution_x, render.resolution_y],
            'percentage': render.resolution_percentage,
            'pixel_aspect': [render.pixel_aspect_x, render.pixel_aspect_y],
            'border': {'enabled': render.use_border, 'crop': render.use_crop_to_border,
                       'rect': [render.border_min_x, render.border_min_y, render.border_max_x, render.border_max_y]},
            'film_transparent': render.film_transparent, 'filepath': render.filepath,
            'format': render.image_settings.file_format, 'color_mode': render.image_settings.color_mode,
            'bit_depth': render.image_settings.color_depth,
            'view_transform': view.view_transform, 'look': view.look,
            'exposure': view.exposure, 'gamma': view.gamma,
            'display_device': scene.display_settings.display_device,
            'white_balance': {key: getattr(view, key, None) for key in
                              ('use_white_balance', 'temperature', 'tint')},
            'output_color_management': render.image_settings.color_management,
            'output_view': {key: getattr(render.image_settings.view_settings, key, None) for key in
                            ('view_transform', 'look', 'exposure', 'gamma', 'use_white_balance', 'temperature', 'tint')},
            'output_linear_space': render.image_settings.linear_colorspace_settings.name,
            'output_media_type': getattr(render.image_settings, 'media_type', None),
            'exr_codec': render.image_settings.exr_codec,
            'exr_interleave': getattr(render.image_settings, 'use_exr_interleave', None),
            'use_compositing': render.use_compositing, 'use_sequencer': render.use_sequencer,
            'cycles': {k: getattr(scene.cycles, k, None) for k in
                       ('device', 'samples', 'use_denoising', 'use_adaptive_sampling',
                        'adaptive_threshold', 'max_bounces', 'transmission_bounces', 'transparent_max_bounces')},
            'compositor_file_outputs': compositor_outputs(scene)}


def collect_report(scene):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    instances = []
    camera = scene.camera.evaluated_get(depsgraph) if scene.camera else None
    for inst in depsgraph.object_instances:
        ob = inst.object
        if ob.type not in {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META', 'VOLUME'}:
            continue
        corners = [inst.matrix_world @ Vector(p) for p in ob.bound_box]
        low = [min(p[i] for p in corners) for i in range(3)]
        high = [max(p[i] for p in corners) for i in range(3)]
        item = {'object': ob.name, 'type': ob.type, 'is_instance': inst.is_instance,
                'parent': inst.parent.name if inst.parent else None,
                'source_library': ob.original.library.filepath if ob.original.library else None,
                'data_library': ob.data.library.filepath if ob.data and ob.data.library else None,
                'object_material_overrides': [slot.material.name for slot in ob.material_slots
                                              if slot.link == 'OBJECT' and slot.material],
                'hide_render': ob.hide_render, 'show_self': getattr(inst, 'show_self', None),
                'persistent_id': list(inst.persistent_id),
                'world_aabb': {'min': floats(low), 'max': floats(high)},
                'world_aabb_size_mm': [(high[i] - low[i]) * scene.unit_settings.scale_length * 1000 for i in range(3)]}
        if camera and camera.data.type in {'PERSP', 'ORTHO'}:
            projected = [world_to_camera_view(scene, camera, p) for p in corners]
            item['camera_aabb'] = {'min': [min(p[i] for p in projected) for i in range(3)],
                                   'max': [max(p[i] for p in projected) for i in range(3)],
                                   'all_in_front': all(p.z > 0 for p in projected)}
        instances.append(item)
    lights = []
    for ob in scene.objects:
        if ob.type != 'LIGHT':
            continue
        evaluated = ob.evaluated_get(depsgraph)
        light = evaluated.data
        lights.append({'name': ob.name, 'type': light.type, 'energy': light.energy,
                       'color': floats(light.color), 'hide_render': ob.hide_render,
                       'matrix_world': matrix_rows(evaluated.matrix_world),
                       'shape': getattr(light, 'shape', None), 'size': getattr(light, 'size', None),
                       'size_y': getattr(light, 'size_y', None)})
    return {'blender_version': bpy.app.version_string, 'source_blend': bpy.data.filepath,
            'scene': scene.name, 'frame': scene.frame_current,
            'unit_system': scene.unit_settings.system, 'meters_per_unit': scene.unit_settings.scale_length,
            'render': render_info(scene), 'active_camera': camera_info(scene.camera, depsgraph),
            'cameras': [camera_info(o, depsgraph) for o in scene.objects if o.type == 'CAMERA'],
            'lights': lights, 'dependencies': dependencies(),
            'evaluation_mode': depsgraph.mode, 'geometry_instances': instances,
            'limits': 'Evaluated AABBs are conservative, not collision/contact tests. Viewport dependency graph and render visibility/subdivision can differ; collection visibility is not fully resolved by this report.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--scene')
    args = parser.parse_args(cli_args())
    path = Path(args.output).expanduser().resolve()
    if path.exists():
        raise FileExistsError(f'Refusing to overwrite report: {path}')
    report = collect_report(select_scene(args.scene))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps({'report': str(path), 'geometry_instances': len(report['geometry_instances']),
                      'missing_dependencies': len(report['dependencies']['missing'])}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()

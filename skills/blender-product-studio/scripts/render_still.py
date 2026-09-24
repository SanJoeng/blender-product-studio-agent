"""Render a versioned Cycles PNG or raw multilayer EXR without saving the source."""
import argparse
import hashlib
import json
import os
import re
import struct
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scene_report import (camera_info, cli_args, compositor_outputs, dependencies,
                          digest, render_info, select_scene)


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def positive_int(value):
    value = int(value)
    if value < 1:
        raise argparse.ArgumentTypeError('Value must be positive')
    return value


def set_device(scene, requested):
    if requested == 'cpu':
        scene.cycles.device = 'CPU'
        return {'requested': requested, 'actual': 'CPU', 'devices': ['CPU']}
    prefs = bpy.context.preferences.addons['cycles'].preferences
    backends = [prefs.compute_device_type]
    backends += ['METAL'] if sys.platform == 'darwin' else ['OPTIX', 'CUDA', 'HIP', 'ONEAPI']
    errors = []
    for backend in dict.fromkeys(backends):
        if backend in {'NONE', 'CPU', ''}:
            continue
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            selected = [d for d in prefs.devices if d.type == backend]
            if not selected:
                continue
            for device in prefs.devices:
                device.use = device.type == backend
            scene.cycles.device = 'GPU'
            return {'requested': requested, 'actual': 'GPU', 'backend': backend,
                    'devices': [d.name for d in selected]}
        except Exception as exc:
            errors.append(f'{backend}: {exc}')
    if requested == 'gpu':
        raise RuntimeError('No usable Cycles GPU was detected. ' + '; '.join(errors))
    scene.cycles.device = 'CPU'
    return {'requested': requested, 'actual': 'CPU', 'devices': ['CPU'],
            'fallback_reason': 'No usable Cycles GPU detected', 'detection_errors': errors}


def set_resolution(scene, args):
    render = scene.render
    width, height = render.resolution_x, render.resolution_y
    if args.size:
        width, height = args.size
    elif args.long_edge:
        scale = args.long_edge / max(width, height)
        width, height = round(width * scale), round(height * scale)
    elif args.short_edge:
        scale = args.short_edge / min(width, height)
        width, height = round(width * scale), round(height * scale)
    elif args.stage == 'preview':
        scale = min(render.resolution_percentage / 100, 1280 / max(width, height))
        width, height = round(width * scale), round(height * scale)
    else:
        width, height = round(width * render.resolution_percentage / 100), round(height * render.resolution_percentage / 100)
    if min(width, height) < 4:
        raise ValueError('Both output dimensions must be at least 4 pixels')
    render.resolution_x, render.resolution_y = width, height
    render.resolution_percentage = 100
    if (render.resolution_x, render.resolution_y) != (width, height):
        raise ValueError('Requested output exceeds this Blender version resolution limits')
    return [width, height]


def read_png_header(path):
    with path.open('rb') as handle:
        header = handle.read(26)
    if header[:8] != b'\x89PNG\r\n\x1a\n' or len(header) < 26:
        raise RuntimeError('Output is not a readable PNG header')
    width, height = struct.unpack('>II', header[16:24])
    return {'size': [width, height], 'bit_depth': header[24], 'color_type': header[25]}


def read_exr_header(path):
    """Read single-part EXR metadata, not pixels; Blender decoding is separate QA."""
    def cstring(handle):
        value = bytearray()
        while len(value) < 65536:
            char = handle.read(1)
            if not char:
                raise ValueError('Truncated EXR string')
            if char == b'\0':
                return value.decode('utf-8', errors='replace')
            value.extend(char)
        raise ValueError('Unbounded EXR string')

    attrs = {}
    with path.open('rb') as handle:
        head = handle.read(8)
        if len(head) != 8 or struct.unpack('<I', head[:4])[0] != 20000630:
            raise ValueError('Output is not an OpenEXR file')
        version = struct.unpack('<I', head[4:])[0]
        if version & 0x1000:
            raise ValueError('Multipart EXR needs separate validation')
        while True:
            name = cstring(handle)
            if not name:
                break
            kind = cstring(handle)
            size_bytes = handle.read(4)
            if len(size_bytes) != 4:
                raise ValueError('Truncated EXR attribute')
            size = struct.unpack('<I', size_bytes)[0]
            if size > 64 * 1024 * 1024:
                raise ValueError('Unexpectedly large EXR attribute')
            payload = handle.read(size)
            if len(payload) != size:
                raise ValueError('Truncated EXR attribute data')
            attrs[name] = (kind, payload)
    x0, y0, x1, y1 = struct.unpack('<4i', attrs['dataWindow'][1])
    channels, cursor = [], 0
    channel_data = attrs['channels'][1]
    while cursor < len(channel_data) and channel_data[cursor] != 0:
        end = channel_data.index(b'\0', cursor)
        channels.append(channel_data[cursor:end].decode('utf-8'))
        cursor = end + 1 + 16
    if not channels or x1 < x0 or y1 < y0:
        raise ValueError('EXR has no channels or invalid dimensions')
    return {'size': [x1 - x0 + 1, y1 - y0 + 1], 'channels': channels,
            'cryptomatte_metadata': [key for key in attrs if key.startswith('cryptomatte/')],
            'pixel_validation': 'Header only; open EXR in Blender or an EXR-aware compositor for visual QA.'}


def setup_studio_passes(scene, group_lights=False):
    """Configure in-memory view layers only. Emissive meshes are not auto-grouped."""
    layers = [layer for layer in scene.view_layers if layer.use]
    if not layers:
        raise ValueError('No enabled view layers')
    fields = ('use_pass_combined', 'use_pass_z', 'use_pass_normal',
              'use_pass_diffuse_direct', 'use_pass_diffuse_indirect', 'use_pass_diffuse_color',
              'use_pass_glossy_direct', 'use_pass_glossy_indirect', 'use_pass_glossy_color',
              'use_pass_transmission_direct', 'use_pass_transmission_indirect', 'use_pass_transmission_color',
              'use_pass_emit', 'use_pass_environment', 'use_pass_cryptomatte_object',
              'use_pass_cryptomatte_material')
    for layer in layers:
        for field in fields:
            if not hasattr(layer, field):
                raise RuntimeError(f'This Blender version lacks {field}')
            setattr(layer, field, True)
        layer.pass_cryptomatte_depth = 6
        layer.use_pass_cryptomatte_accurate = True
    assignments = []
    if group_lights:
        targets = [(ob, 'LIGHT') for ob in scene.objects if ob.type == 'LIGHT']
        if scene.world:
            targets.append((scene.world, 'WORLD'))
        for target, kind in targets:
            name = target.lightgroup
            if not name:
                if target.library:
                    raise ValueError(f'Cannot auto-group linked {kind}: {target.name}; use a local scene light rig')
                slug = re.sub(r'[^A-Za-z0-9_-]', '_', target.name)[:28]
                token = hashlib.sha256((kind + ':' + target.name).encode()).hexdigest()[:8]
                name = f'Studio_{slug}_{token}'
                target.lightgroup = name
            for layer in layers:
                if layer.lightgroups.get(name) is None:
                    layer.lightgroups.add(name=name)
            assignments.append({'object': target.name, 'type': kind, 'group': name})
    return {'view_layers': [layer.name for layer in layers], 'enabled': list(fields),
            'light_groups': {layer.name: [group.name for group in layer.lightgroups] for layer in layers},
            'assignments': assignments,
            'limits': 'Raw scene-linear view-layer passes; no final compositor grade. Emissive meshes are not automatically assigned light groups. No separate shadow catcher is created.'}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--stage', choices=['preview', 'final'], default='preview')
    parser.add_argument('--scene')
    parser.add_argument('--camera')
    parser.add_argument('--frame', type=int)
    parser.add_argument('--device', choices=['auto', 'gpu', 'cpu'], default='auto')
    parser.add_argument('--samples', type=positive_int)
    parser.add_argument('--depth', choices=['8', '16', '32'], default='16')
    parser.add_argument('--studio-passes', action='store_true', help='EXR only: enable object/material masks and lighting passes')
    parser.add_argument('--light-groups', action='store_true', help='With --studio-passes: group unassigned scene lights and World')
    dimensions = parser.add_mutually_exclusive_group()
    dimensions.add_argument('--long-edge', type=positive_int)
    dimensions.add_argument('--short-edge', type=positive_int)
    dimensions.add_argument('--size', type=positive_int, nargs=2, metavar=('WIDTH', 'HEIGHT'))
    alpha = parser.add_mutually_exclusive_group()
    alpha.add_argument('--transparent', dest='transparent', action='store_true')
    alpha.add_argument('--opaque', dest='transparent', action='store_false')
    parser.set_defaults(transparent=None)
    return parser.parse_args(cli_args())


def main():
    args = parse_args()
    if not bpy.app.background or not bpy.data.filepath:
        raise RuntimeError('Run in background mode with a saved source .blend')
    source = Path(bpy.data.filepath).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    output = Path(args.output).expanduser().resolve()
    suffix = output.suffix.lower()
    if suffix not in {'.png', '.exr'}:
        raise ValueError('Output must be PNG or raw multilayer EXR')
    if suffix == '.png' and (args.depth == '32' or args.studio_passes or args.light_groups):
        raise ValueError('PNG supports depth 8/16 and no studio/light-group passes')
    if suffix == '.exr' and args.depth == '8':
        raise ValueError('EXR supports depth 16/32 only')
    if args.light_groups and not args.studio_passes:
        raise ValueError('--light-groups requires --studio-passes')
    status_path = output.with_suffix('.render.json')
    lock_path = output.with_suffix('.render.lock')
    for path in (output, status_path, lock_path):
        if path.exists():
            raise FileExistsError(f'Refusing to overwrite output, report or active/stale lock: {path}')
    output.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('x', encoding='utf-8') as handle:
        json.dump({'pid': os.getpid(), 'output': str(output), 'source': str(source), 'created': timestamp()}, handle)
    started = time.monotonic()
    state = {'state': 'preparing', 'pid': os.getpid(), 'started': timestamp(),
             'blender_version': bpy.app.version_string, 'source_blend': str(source),
             'output': str(output), 'stage': args.stage}

    def save_state():
        state['updated'] = timestamp()
        state['elapsed_seconds'] = round(time.monotonic() - started, 3)
        status_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

    try:
        save_state()
        scene = select_scene(args.scene)
        if scene.render.engine != 'CYCLES':
            raise ValueError('This helper requires an existing Cycles scene; it does not switch render engines')
        if compositor_outputs(scene):
            raise ValueError('Active compositor File Output nodes require a separate, explicit multi-output workflow')
        if scene.render.use_border:
            raise ValueError('Render border can omit part of the composition; resolve the intended full-frame or crop workflow first')
        if scene.render.use_multiview:
            raise ValueError('Multiview output requires a separate, explicit multi-output workflow')
        if args.camera:
            camera = scene.objects.get(args.camera)
            if camera is None or camera.type != 'CAMERA':
                raise ValueError(f'Camera not found in scene: {args.camera}')
            scene.camera = camera
        if scene.camera is None:
            raise ValueError('Scene has no active camera')
        if args.frame is not None:
            scene.frame_set(args.frame)
        state['source_sha256'] = digest(source)
        state['dependencies'] = dependencies()
        if state['dependencies']['missing']:
            raise ValueError('Missing linked libraries or external images; inspect render report before retrying')
        state['requested_size'] = set_resolution(scene, args)
        if args.samples is not None:
            scene.cycles.samples = args.samples
        elif args.stage == 'preview':
            scene.cycles.samples = min(scene.cycles.samples, 32)
        if args.transparent is not None:
            scene.render.film_transparent = args.transparent
        scene.render.filepath = str(output)
        if hasattr(scene.render.image_settings, 'media_type'):
            scene.render.image_settings.media_type = 'IMAGE' if suffix == '.png' else 'MULTI_LAYER_IMAGE'
        scene.render.image_settings.file_format = 'PNG' if suffix == '.png' else 'OPEN_EXR_MULTILAYER'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.image_settings.color_depth = args.depth
        if suffix == '.exr':
            scene.render.image_settings.exr_codec = 'ZIP'
            if hasattr(scene.render.image_settings, 'use_exr_interleave'):
                scene.render.image_settings.use_exr_interleave = True
            scene.render.use_compositing = False
            scene.render.use_sequencer = False
            state['output_semantics'] = 'Raw multilayer scene-linear EXR, not the final composited/display-transformed image'
        if args.studio_passes:
            state['studio_passes'] = setup_studio_passes(scene, args.light_groups)
        scene.render.use_file_extension = True
        state['device'] = set_device(scene, args.device)
        state['scene'] = scene.name
        state['frame'] = scene.frame_current
        state['camera'] = camera_info(scene.camera, bpy.context.evaluated_depsgraph_get())
        state['settings'] = render_info(scene)
        state['state'] = 'rendering'
        save_state()
        print(json.dumps({'state': 'rendering', 'output': str(output), 'size': state['requested_size'],
                          'samples': scene.cycles.samples, 'device': state['device']}, ensure_ascii=False), flush=True)
        render_start = time.monotonic()
        result = bpy.ops.render.render(write_still=True, scene=scene.name)
        if 'FINISHED' not in result or not output.is_file():
            raise RuntimeError('Render did not finish with an output file')
        state['render_seconds'] = round(time.monotonic() - render_start, 3)
        actual = read_png_header(output) if suffix == '.png' else read_exr_header(output)
        state['actual_png' if suffix == '.png' else 'actual_exr'] = actual
        if actual['size'] != state['requested_size']:
            raise RuntimeError('Saved image size differs from requested size; inspect compositor and crop settings')
        if args.studio_passes:
            for layer_name in state['studio_passes']['view_layers']:
                for pass_name in ('Combined', 'CryptoObject00', 'CryptoMaterial00'):
                    prefix = layer_name + '.' + pass_name + '.'
                    if not any(channel.startswith(prefix) for channel in actual['channels']):
                        raise RuntimeError(f'Expected EXR pass is absent: {layer_name}.{pass_name}')
                if args.light_groups:
                    for group in state['studio_passes']['light_groups'][layer_name]:
                        prefix = layer_name + '.Combined_' + group + '.'
                        if not any(channel.startswith(prefix) for channel in actual['channels']):
                            raise RuntimeError(f'Expected light group is absent: {group}')
            if not actual['cryptomatte_metadata']:
                raise RuntimeError('Expected Cryptomatte metadata is absent from EXR')
        state['output_bytes'] = output.stat().st_size
        state['output_sha256'] = digest(output)
        state['state'] = 'completed'
        save_state()
        print(json.dumps({'state': 'completed', 'output': str(output), 'size': actual['size'],
                          'render_seconds': state['render_seconds'], 'report': str(status_path)}, ensure_ascii=False), flush=True)
    except Exception as exc:
        state.update(state='failed', error=f'{type(exc).__name__}: {exc}')
        save_state()
        print(json.dumps({'state': 'failed', 'error': state['error'], 'report': str(status_path)}, ensure_ascii=False), flush=True)
        raise
    finally:
        lock_path.unlink(missing_ok=True)


if __name__ == '__main__':
    main()

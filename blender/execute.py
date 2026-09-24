"""Product Studio's Blender worker. Receives a local, application-generated spec."""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Euler, Matrix

spec_path = Path(sys.argv[sys.argv.index('--') + 1])
spec = json.loads(spec_path.read_text())
PROJECT_ROOT = Path(spec['project_root'])
INPUT_FILES = spec.get('inputs', {})
ASSETS = spec.get('assets', {})
sys.path.insert(0, str(Path(spec['skill_root']) / 'scripts'))
from scene_report import collect_report, dependencies

out = Path(spec['output'])
if out.exists() and not spec.get('allow_overwrite', False):
    raise RuntimeError('Refusing to overwrite a snapshot: ' + str(out))
if spec.get('code_file'):
    code_file = Path(spec['code_file'])
    exec(compile(code_file.read_text(), str(code_file), 'exec'), globals())

if spec.get('required_collections'):
    missing = [n for n in spec['required_collections'] if n not in bpy.data.collections]
    if missing:
        raise ValueError('Collections do not exist: ' + repr(missing))

if spec.get('freeze'):
    deps = dependencies()
    if deps['missing']:
        raise RuntimeError('Missing dependencies: ' + json.dumps(deps['missing'], ensure_ascii=False))
    if deps['unverified_sequences_or_tiles']:
        raise RuntimeError('Sequence/UDIM dependencies require a dedicated snapshot workflow.')
    # Pack textures and linked .blend files so later master-asset updates cannot
    # silently change an already queued render. Simulation caches need separate QA.
    bpy.ops.file.pack_all()
    bpy.ops.file.pack_libraries()

out.parent.mkdir(parents=True, exist_ok=True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(out), relative_remap=True)
report = collect_report(bpy.context.scene)
report['collections'] = [{'name': c.name, 'library': c.library.filepath if c.library else None} for c in bpy.data.collections]
Path(spec['report']).write_text(json.dumps(report, ensure_ascii=False, indent=2))
print('STUDIO_SAVED ' + str(out), flush=True)

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { cubeMesh } from '../src/demo.js';
import { export3mf } from '../src/three-mf.js';

const executable = process.env.ORCA_SLICER || 'C:/Program Files/OrcaSlicer/orca-slicer.exe';

test(
  'Orca 2.4.2 slices paint slot 16 into extrusion with tool 15',
  { skip: !existsSync(executable) },
  () => {
    const root = resolve('.tmp/orca-paint-slicing');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(resolve(root, 'run-'));
    const input = resolve(dir, 'input.3mf'),
      saved = resolve(dir, 'saved.3mf'),
      sliceInput = resolve(dir, 'slice.3mf');
    const mesh = cubeMesh();
    const lo = [0, 1, 2].map((axis) => Math.min(...mesh.vertices.map((v) => v[axis])));
    mesh.vertices = mesh.vertices.map((v) =>
      v.map((n, axis) => (n - lo[axis]) / 10 + (axis === 2 ? 0 : 20)),
    );
    mesh.faces.forEach((face) => {
      face.material = 16;
    });
    writeFileSync(input, export3mf([mesh], Array(16).fill('#FFFFFF'), { format: 'orca' }));
    const run = (args) => {
      const result = spawnSync(executable, args, {
        cwd: dir,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 45000,
      });
      assert.equal(result.status, 0, String(result.error || '') + result.stdout + result.stderr);
    };
    run(['--arrange', '0', '--export-3mf', saved, input]);

    // A model-only archive deliberately has no printer. Configure a temporary
    // virtual printer here so the native slicer must interpret its paint.
    const files = unzipSync(readFileSync(saved));
    const config = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
    for (const key of Object.keys(config)) {
      if (/line_width$/.test(key) && config[key] === '0') config[key] = '0.42';
    }
    for (const [key, value] of Object.entries(config)) {
      if (
        Array.isArray(value) &&
        value.length === 1 &&
        /^(filament_|nozzle_temperature|cool_plate_temp|hot_plate_temp|textured_plate_temp|eng_plate_temp)/.test(
          key,
        )
      ) {
        config[key] = Array(16).fill(value[0]);
      }
    }
    Object.assign(config, {
      printer_settings_id: 'Validation printer',
      print_settings_id: 'Validation process',
      filament_settings_id: Array(16).fill('Validation PLA'),
      filament_colour: Array(16).fill('#FFFFFF'),
      printer_model: 'Generic',
      printer_variant: '0.4',
      printable_area: ['0x0', '200x0', '200x200', '0x200'],
      printable_height: '200',
      layer_height: '0.2',
      initial_layer_print_height: '0.2',
      brim_type: 'no_brim',
      brim_width: '0',
      enable_prime_tower: '0',
      skirt_loops: '0',
      skirt_height: '0',
      nozzle_temperature: Array(16).fill('200'),
      nozzle_temperature_initial_layer: Array(16).fill('200'),
      machine_start_gcode: 'G28\nG92 E0',
      machine_end_gcode: 'M104 S0',
      layer_change_gcode: 'G92 E0',
      change_filament_gcode: 'T[next_extruder]',
      gcode_flavor: 'marlin',
      use_relative_e_distances: '1',
      sparse_infill_density: '0%',
      wall_loops: '1',
      top_shell_layers: '0',
      bottom_shell_layers: '0',
      flush_volumes_matrix: Array(256).fill('0'),
      flush_volumes_vector: Array(32).fill('0'),
    });
    files['Metadata/project_settings.config'] = strToU8(JSON.stringify(config));
    const settings = strFromU8(files['Metadata/model_settings.config']);
    assert.ok(settings.includes('</plate>'), 'Native save did not create a plate');
    files['Metadata/model_settings.config'] = strToU8(
      settings.replace(
        '</plate>',
        '<model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/><metadata key="identify_id" value="1"/></model_instance></plate>',
      ),
    );
    writeFileSync(sliceInput, zipSync(files));
    run(['--arrange', '0', '--slice', '1', '--outputdir', dir, sliceInput]);

    let tool = -1,
      extrusionMoves = 0;
    const extrudingTools = new Set();
    for (const raw of readFileSync(resolve(dir, 'plate_1.gcode'), 'utf8').split(/\r?\n/)) {
      const line = raw.split(';')[0];
      const change = line.match(/^T(\d+)\b/);
      if (change) tool = Number(change[1]);
      if (
        /^G[01]\s/.test(line) &&
        /[XY][-\d.]/.test(line) &&
        Number(line.match(/\bE([-\d.]+)/)?.[1]) > 0
      ) {
        extrudingTools.add(tool);
        extrusionMoves++;
      }
    }
    assert.ok(extrusionMoves > 0, 'No printable extrusion was found');
    assert.deepEqual([...extrudingTools], [15], 'All painted perimeters must use slot 16');
  },
);

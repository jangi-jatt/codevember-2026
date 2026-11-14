// node 14/tools/bake.mjs [shape|all] [res]  ->  14/assets/<shape>.sdf
// Signed distance grids for the water, finer than day 3's, in the same normalised space as day 3's meshes.
// Layout, gzipped: uint32 JSON byte length, JSON { res, min, size, scale }, padding to 4 bytes, then res^3 int16 of
// round(d * scale), stored as second differences along x then y, split into a low-byte plane and a high-byte plane.
import { writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { SHAPES } from "../../3/tools/sdf.mjs";
import { surfaceNets, compact, relax, meshSdfGrid, sdfGrid, gridSampler, aabb } from "../../3/tools/mesher.mjs";
import { SUZANNE_LEVELS } from "../../3/tools/bake.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = `${here}../assets/`;
const MARGIN = 0.3;
const SCALE = 4096;

function write(key, grid) {
  const { res } = grid;
  const header = JSON.stringify({ res, min: grid.min, size: grid.size, scale: SCALE });
  const json = new TextEncoder().encode(header);
  const start = 4 + ((json.length + 3) & ~3);
  const count = res ** 3;
  const out = new Uint8Array(start + count * 2);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.fill(0x20, 4, start);
  out.set(json, 4);
  const q = new Int32Array(count);
  for (let i = 0; i < count; i++) q[i] = Math.max(-32767, Math.min(32767, Math.round(grid.data[i] * SCALE)));
  // Second differences: along x within each row, then along y between rows.
  const dx = new Int32Array(count);
  for (let r = 0; r < res * res; r++) for (let x = 0; x < res; x++) dx[r * res + x] = q[r * res + x] - (x ? q[r * res + x - 1] : 0);
  for (let z = 0; z < res; z++)
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const i = x + res * (y + res * z);
        const v = (dx[i] - (y ? dx[i - res] : 0)) & 0xffff;
        out[start + i] = v & 0xff;
        out[start + count + i] = v >> 8;
      }
  const bytes = gzipSync(out, { level: 9 });
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(`${ASSETS}${key}.sdf`, bytes);
  return bytes.length;
}

// Same centring and scale as day 3's bake, so the grid matches its mesh.
function bakeShape(key, res) {
  const { f, bound } = SHAPES[key];
  const coarse = compact(surfaceNets(f, bound, 48, { newtonSteps: 2 }));
  const { lo, hi } = aabb(coarse.pos);
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let R = 0;
  for (let v = 0; v < coarse.pos.length; v += 3) R = Math.max(R, Math.hypot(coarse.pos[v] - c[0], coarse.pos[v + 1] - c[1], coarse.pos[v + 2] - c[2]));
  R *= 1.01;
  const g = (x, y, z) => f(x * R + c[0], y * R + c[1], z * R + c[2]) / R;
  const mesh = compact(surfaceNets(g, 1.04, 160));
  relax(mesh, g, 3);
  const box = aabb(mesh.pos);
  return meshSdfGrid(mesh, (x, y, z) => g(x, y, z) < 0, box.lo, box.hi, res, MARGIN);
}

async function bakeSuzanne(res) {
  const { loadSuzanne, suzanneField } = await import("../../3/tools/suzanne.mjs");
  const levels = loadSuzanne(`${here}../../3/assets/suzanne.obj`, [Math.max(...SUZANNE_LEVELS)]);
  const top = levels[0];
  const { lo, hi } = aabb(top.pos);
  const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  let R = 0;
  for (let v = 0; v < top.pos.length; v += 3) R = Math.max(R, Math.hypot(top.pos[v] - c[0], top.pos[v + 1] - c[1], top.pos[v + 2] - c[2]));
  R *= 1.01;
  for (let v = 0; v < top.pos.length; v += 3) for (let k = 0; k < 3; k++) top.pos[v + k] = (top.pos[v + k] - c[k]) / R;
  const fine = suzanneField(top, { R: 288, margin: MARGIN + 0.05, sigma: 1 });
  const box = aabb(top.pos);
  return sdfGrid(gridSampler(fine), box.lo, box.hi, res, MARGIN);
}

const ALL = ["suzanne", ...Object.keys(SHAPES)];
const arg = process.argv[2] || "all";
const res = +(process.argv[3] || 96);
for (const key of arg === "all" ? ALL : arg.split(",")) {
  const t0 = performance.now();
  const grid = key === "suzanne" ? await bakeSuzanne(res) : bakeShape(key, res);
  const bytes = write(key, grid);
  console.log(key, res, `${(bytes / 1e6).toFixed(2)} MB`, `${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

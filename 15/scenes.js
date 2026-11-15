// Light scenes for the hologram, beside the gear spray and the burst: Suzanne's head, a cluster of crystals, one big
// gear with pinions round it, chess pieces on a board, a knot and an atom. Each builds in a frame or two, from a seed.
// userData.surf: metalness, roughness, albedo, per mesh.
import { BufferGeometry, Float32BufferAttribute, BufferAttribute, Group, Mesh, LatheGeometry, Vector2, Vector3, Quaternion, TorusKnotGeometry, TorusGeometry, IcosahedronGeometry, BoxGeometry, CylinderGeometry } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";
import { suzanneGeometry } from "modules/suzanne/suzanneMesh.js";
import { getSolid, families } from "modules/polyhedra/solids.js";
import * as gearLib from "../11/gears.js";

export const LIGHT_SCENES = ["head", "crystals", "gear", "chess", "knot", "atom"];

const mulberry = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomDirection = (r) => new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();

const SHINY = [0.9, 0.3, 0.9];
const SATIN = [0.1, 0.45, 0.85];
const GLOSS = [0.0, 0.18, 0.8];

function add(group, geometry, surf, { position = null, quaternion = null, scale = 1 } = {}) {
  const mesh = new Mesh(geometry);
  mesh.userData.surf = surf;
  if (position) mesh.position.copy(position);
  if (quaternion) mesh.quaternion.copy(quaternion);
  mesh.scale.setScalar(scale);
  group.add(mesh);
  return mesh;
}

// A polyhedron with flat faces (each face fanned from its centre, so star faces work too).
function solidGeometry(solid) {
  const P = [], N = [];
  const v = solid.vertices.map((p) => new Vector3(...p));
  for (const f of solid.faces) {
    const c = new Vector3();
    for (const i of f) c.add(v[i]);
    c.divideScalar(f.length);
    const n = new Vector3();
    for (let k = 0; k < f.length; k++) n.add(new Vector3().crossVectors(v[f[k]], v[f[(k + 1) % f.length]]));
    n.normalize();
    for (let k = 0; k < f.length; k++) {
      for (const p of [c, v[f[k]], v[f[(k + 1) % f.length]]]) {
        P.push(p.x, p.y, p.z);
        N.push(n.x, n.y, n.z);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(P, 3));
  g.setAttribute("normal", new Float32BufferAttribute(N, 3));
  return g;
}

function gearGeometry(data) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.position, 3));
  if (data.normal) g.setAttribute("normal", new BufferAttribute(data.normal, 3));
  g.setIndex(new BufferAttribute(data.index, 1));
  if (!data.normal) g.computeVertexNormals();
  return g;
}

let suzanneText = null;
async function head(r, group) {
  suzanneText ??= await (await fetch(new URL("../assets/suzanne.obj", import.meta.url))).text();
  const g = suzanneGeometry(suzanneText, 2);
  g.computeVertexNormals();
  g.computeBoundingBox();
  const c = g.boundingBox.getCenter(new Vector3());
  g.translate(-c.x, -c.y, -c.z);
  add(group, g, SATIN, { quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (r() - 0.5) * 0.8) });
}

// A star polyhedron in the middle, smaller solids round it at different depths.
function crystals(r, group) {
  const stars = families.keplerPoinsot;
  const centre = getSolid(stars[Math.floor(r() * stars.length)]);
  add(group, solidGeometry(centre), SHINY, { quaternion: new Quaternion().setFromAxisAngle(randomDirection(r), r() * 6.3), scale: 0.55 });
  const others = [...families.platonic, ...families.archimedean.slice(0, 6)];
  const placed = [];
  for (let i = 0, tries = 0; i < 9 && tries < 200; tries++) {
    const size = 0.1 + 0.14 * r();
    const at = randomDirection(r).multiplyScalar(0.62 + 0.38 * r());
    if (placed.some((p) => p.at.distanceTo(at) < p.size + size + 0.04)) continue;
    placed.push({ at, size });
    add(group, solidGeometry(getSolid(others[Math.floor(r() * others.length)])), r() < 0.5 ? SHINY : GLOSS, { position: at, quaternion: new Quaternion().setFromAxisAngle(randomDirection(r), r() * 6.3), scale: size });
    i++;
  }
}

// One big gear with pinions meshing round it, a little forward and back.
function gear(r, group) {
  const m = 0.03;
  const big = gearLib.spurGear({ teeth: 40 + Math.floor(r() * 12), module: m, width: m * 6, bore: m * 3, hub: m * 6, style: ["spokes", "holes", "web"][Math.floor(r() * 3)], seed: Math.floor(r() * 1e6), chamfer: 0.18 * m });
  add(group, gearGeometry(big), SHINY);
  const count = 3 + Math.floor(r() * 3);
  for (let k = 0; k < count; k++) {
    const teeth = 10 + Math.floor(r() * 10);
    const pinion = gearLib.spurGear({ teeth, module: m, width: m * (6 + 4 * r()), bore: m * 1.5, hub: m * 2.5, style: "solid", seed: Math.floor(r() * 1e6), chamfer: 0.18 * m });
    const pair = gearLib.meshSpur(big, pinion, (k / count) * Math.PI * 2 + r() * 0.4);
    const mesh = add(group, gearGeometry(pinion), r() < 0.5 ? SHINY : SATIN);
    mesh.applyMatrix4(pair.transform);
    mesh.rotation.z = pair.phase;
    mesh.position.z = (r() - 0.5) * m * 4;
  }
}

// Turned pieces (a profile spun round), standing on a board of squares.
const PROFILES = {
  pawn: [[0.32, 0], [0.32, 0.06], [0.22, 0.12], [0.14, 0.4], [0.22, 0.46], [0.12, 0.5], [0.17, 0.62], [0.16, 0.72], [0.09, 0.8], [0, 0.82]],
  rook: [[0.36, 0], [0.36, 0.07], [0.26, 0.14], [0.22, 0.7], [0.3, 0.76], [0.3, 0.98], [0.2, 0.98], [0.2, 0.9], [0, 0.9]],
  bishop: [[0.34, 0], [0.34, 0.07], [0.24, 0.13], [0.15, 0.62], [0.24, 0.68], [0.14, 0.72], [0.2, 0.9], [0.16, 1.04], [0.06, 1.14], [0.07, 1.18], [0, 1.2]],
  queen: [[0.38, 0], [0.38, 0.08], [0.27, 0.15], [0.16, 0.8], [0.28, 0.86], [0.17, 0.9], [0.27, 1.16], [0.2, 1.22], [0.12, 1.24], [0.09, 1.3], [0, 1.34]],
  king: [[0.4, 0], [0.4, 0.08], [0.28, 0.15], [0.17, 0.86], [0.3, 0.92], [0.18, 0.96], [0.25, 1.22], [0.08, 1.26], [0.08, 1.36], [0, 1.36]],
};
function chess(r, group) {
  const board = new Group();
  const n = 4, s = 0.42;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dark = (i + j) % 2 === 1;
      const sq = add(board, new BoxGeometry(s, 0.06, s), dark ? [0.0, 0.3, 0.25] : GLOSS);
      sq.position.set((i - (n - 1) / 2) * s, -0.03, (j - (n - 1) / 2) * s);
    }
  }
  const names = Object.keys(PROFILES);
  const cells = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cells.push([i, j]);
  for (let k = 0; k < 5; k++) {
    const [i, j] = cells.splice(Math.floor(r() * cells.length), 1)[0];
    const name = k === 0 ? "king" : k === 1 ? "queen" : names[Math.floor(r() * names.length)];
    const g = new LatheGeometry(PROFILES[name].map(([x, y]) => new Vector2(x, y)), 40);
    const piece = add(board, g, r() < 0.5 ? SATIN : SHINY, { scale: s * 0.95 });
    piece.position.set((i - (n - 1) / 2) * s, 0, (j - (n - 1) / 2) * s);
    if (name === "king") add(board, new BoxGeometry(0.05, 0.22, 0.05), SATIN, { position: piece.position.clone().add(new Vector3(0, 1.45 * s * 0.95, 0)) });
    if (name === "king") add(board, new BoxGeometry(0.16, 0.05, 0.05), SATIN, { position: piece.position.clone().add(new Vector3(0, 1.48 * s * 0.95, 0)) });
  }
  // Seen from above and in front, turned a little.
  board.rotation.set(0.55, (r() - 0.5) * 1.2, 0);
  group.add(board);
}

function knot(r, group) {
  // Only the trefoil (most often) and the cinquefoil, so the loops read through the hologram's blur.
  const [p, q] = [[2, 3], [2, 3], [2, 5]][Math.floor(r() * 3)];
  const g = new TorusKnotGeometry(0.62, 0.12 + 0.03 * r(), 300, 20, p, q);
  // Its axis within 25 degrees of the viewer, so the loops spread across the plate instead of piling up end-on.
  const tilt = new Quaternion().setFromAxisAngle(new Vector3(Math.cos(r() * 6.3), Math.sin(r() * 6.3), 0).normalize(), ((r() * 25) * Math.PI) / 180);
  const spin = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), r() * 6.3);
  add(group, g, r() < 0.5 ? SHINY : GLOSS, { quaternion: tilt.multiply(spin) });
}

// A nucleus of packed spheres, three or four tilted orbits, an electron on each.
function atom(r, group) {
  const ball = mergeVertices(new IcosahedronGeometry(1, 3));
  ball.computeVertexNormals();
  const count = 9 + Math.floor(r() * 6);
  for (let i = 0; i < count; i++) {
    const at = randomDirection(r).multiplyScalar(0.12 * Math.cbrt(r()));
    add(group, ball, i % 2 ? SATIN : SHINY, { position: at, scale: 0.075 });
  }
  const orbits = 3 + Math.floor(r() * 2);
  for (let k = 0; k < orbits; k++) {
    const ring = new TorusGeometry(1, 0.012, 8, 160);
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (k / orbits) * Math.PI).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1.15 + 0.2 * r()));
    const mesh = add(group, ring, SHINY, { quaternion: q });
    mesh.scale.set(0.9, 0.4 + 0.12 * r(), 0.9);
    const a = r() * Math.PI * 2;
    const e = new Vector3(Math.cos(a) * 0.9, Math.sin(a) * mesh.scale.y, 0).applyQuaternion(q);
    add(group, ball, GLOSS, { position: e, scale: 0.06 });
  }
}

const BUILDERS = { head, crystals, gear, chess, knot, atom };

export async function buildLightScene(kind, seed) {
  const r = mulberry(seed * 2654435761 + kind.length * 97);
  const group = new Group();
  await BUILDERS[kind](r, group);
  return { group, dispose: () => group.traverse((o) => o.geometry?.dispose()) };
}

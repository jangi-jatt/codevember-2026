// Light scenes for the hologram, beside the gear spray and the burst: Suzanne's head, a cluster of crystals, one big
// gear with pinions round it, chess pieces on a board, a knot and an atom. Each builds in a frame or two, from a seed.
// userData.surf: metalness, roughness, albedo, per mesh.
import { BufferGeometry, Float32BufferAttribute, BufferAttribute, Group, Mesh, LatheGeometry, Vector2, Vector3, Quaternion, TorusKnotGeometry, TorusGeometry, IcosahedronGeometry, BoxGeometry, CylinderGeometry, SphereGeometry, RingGeometry, ConeGeometry, Euler } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "third_party/three-rounded-box.js";
import { suzanneGeometry } from "modules/suzanne/suzanneMesh.js";
import { getSolid, families } from "modules/polyhedra/solids.js";
import * as gearLib from "../11/gears.js";

export const LIGHT_SCENES = ["head", "crystals", "gear", "chess", "knot", "atom", "cube", "saturn", "pyramid"];

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

// Suzanne subdivided and centred, built once (preloadLightScenes) and copied for each card.
let suzanne = null;
async function headGeometry() {
  if (!suzanne) {
    const text = await (await fetch(new URL("../assets/suzanne.obj", import.meta.url))).text();
    const g = suzanneGeometry(text, 2);
    g.computeVertexNormals();
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new Vector3());
    g.translate(-c.x, -c.y, -c.z);
    suzanne = g;
  }
  return suzanne;
}
export function preloadLightScenes() {
  return headGeometry();
}
// The mesh comes pitched nose-down: tilted back (as day 10 does) so she faces the viewer, then turned a little either way.
async function head(r, group) {
  add(group, (await headGeometry()).clone(), SATIN, { quaternion: new Quaternion().setFromEuler(new Euler(-0.37, (r() - 0.5) * 0.8, 0, "YXZ")) });
}

// A star polyhedron in the middle, smaller solids round it at different depths.
async function crystals(r, group, yieldFrame) {
  const stars = families.keplerPoinsot;
  const centre = getSolid(stars[Math.floor(r() * stars.length)]);
  add(group, solidGeometry(centre), SHINY, { quaternion: new Quaternion().setFromAxisAngle(randomDirection(r), r() * 6.3), scale: 0.55 });
  await yieldFrame();
  const others = [...families.platonic, ...families.archimedean.slice(0, 6)];
  const placed = [];
  for (let i = 0, tries = 0; i < 9 && tries < 200; tries++) {
    const size = 0.1 + 0.14 * r();
    const at = randomDirection(r).multiplyScalar(0.62 + 0.38 * r());
    if (placed.some((p) => p.at.distanceTo(at) < p.size + size + 0.04)) continue;
    placed.push({ at, size });
    add(group, solidGeometry(getSolid(others[Math.floor(r() * others.length)])), r() < 0.5 ? SHINY : GLOSS, { position: at, quaternion: new Quaternion().setFromAxisAngle(randomDirection(r), r() * 6.3), scale: size });
    i++;
    await yieldFrame();
  }
}

// One big gear with pinions meshing round it; each pinion is a compound gear, a second wheel on its shaft standing
// out in front or behind, so the train has depth. Seen in three-quarter view.
async function gear(r, group, yieldFrame) {
  const m = 0.03;
  const train = new Group();
  const big = gearLib.spurGear({ teeth: 40 + Math.floor(r() * 12), module: m, width: m * 6, bore: m * 3, hub: m * 6, style: ["spokes", "holes", "web"][Math.floor(r() * 3)], seed: Math.floor(r() * 1e6), chamfer: 0.18 * m });
  add(train, gearGeometry(big), SHINY);
  await yieldFrame();
  // The big gear's shaft.
  add(train, new CylinderGeometry(m * 2.2, m * 2.2, m * 26, 24).rotateX(Math.PI / 2), SATIN);
  const count = 3 + Math.floor(r() * 3);
  for (let k = 0; k < count; k++) {
    const teeth = 10 + Math.floor(r() * 10);
    const pinion = gearLib.spurGear({ teeth, module: m, width: m * (6 + 4 * r()), bore: m * 1.5, hub: m * 2.5, style: "solid", seed: Math.floor(r() * 1e6), chamfer: 0.18 * m });
    const pair = gearLib.meshSpur(big, pinion, (k / count) * Math.PI * 2 + r() * 0.4);
    const axle = new Group();
    axle.applyMatrix4(pair.transform);
    const mesh = add(axle, gearGeometry(pinion), r() < 0.5 ? SHINY : SATIN);
    mesh.rotation.z = pair.phase;
    // The compound wheel, out along the shaft.
    const side = r() < 0.5 ? 1 : -1;
    const reach = m * (10 + 8 * r());
    const wheel = gearLib.spurGear({ teeth: 16 + Math.floor(r() * 20), module: m * 0.8, width: m * 5, bore: m * 1.5, hub: m * 2.5, style: r() < 0.5 ? "web" : "holes", seed: Math.floor(r() * 1e6), chamfer: 0.15 * m });
    const w = add(axle, gearGeometry(wheel), r() < 0.5 ? SATIN : SHINY);
    w.position.z = side * reach;
    w.rotation.z = r() * 6.3;
    const shaft = add(axle, new CylinderGeometry(m * 1.2, m * 1.2, reach + m * 6, 16).rotateX(Math.PI / 2), SATIN);
    shaft.position.z = side * reach * 0.5;
    train.add(axle);
    await yieldFrame();
  }
  // Three-quarter view: turned and tipped toward the viewer.
  train.rotation.set(-0.5 + 0.15 * r(), (r() < 0.5 ? -1 : 1) * (0.7 + 0.2 * r()), 0.2 * (r() - 0.5));
  group.add(train);
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

// Saturn: a banded planet (latitude bands in alternating tones), a tilted ring system with a dark gap, and a moon or
// three, the whole tipped toward the viewer.
function saturn(r, group) {
  const system = new Group();
  const bands = 7;
  for (let b = 0; b < bands; b++) {
    const from = (b / bands) * Math.PI, span = Math.PI / bands;
    const tone = b % 2 ? 0.55 + 0.1 * r() : 0.8 + 0.1 * r();
    add(system, new SphereGeometry(0.42, 64, 6, 0, Math.PI * 2, from, span), [0.0, 0.5, tone]);
  }
  // The rings: inner to outer, a gap after the second, each its own brightness.
  const rings = [[0.55, 0.66, 0.5], [0.67, 0.84, 0.9], [0.9, 1.02, 0.75], [1.03, 1.08, 0.45]];
  for (const [inner, outer, tone] of rings) add(system, new RingGeometry(inner, outer, 128, 1).rotateX(-Math.PI / 2), [0.1, 0.4, tone * (0.9 + 0.2 * r())]);
  const moons = 1 + Math.floor(r() * 3);
  for (let k = 0; k < moons; k++) {
    const a = r() * Math.PI * 2, d = 1.2 + 0.25 * r();
    add(system, new SphereGeometry(1, 24, 16), GLOSS, { position: new Vector3(Math.cos(a) * d, (r() - 0.5) * 0.4, Math.sin(a) * d), scale: 0.05 + 0.04 * r() });
  }
  system.rotation.set(0.35 + 0.2 * r(), r() * Math.PI * 2, (r() < 0.5 ? -1 : 1) * (0.25 + 0.2 * r()));
  group.add(system);
}

// A pyramid, smooth or stepped, its capstone floating above it with an orb and a halo in the gap, seen three-quarter on.
const flat = (g) => {
  const f = g.toNonIndexed();
  f.computeVertexNormals();
  return f;
};
function pyramid(r, group) {
  const temple = new Group();
  const base = 1.1, top = 0.36, height = 0.75;
  if (r() < 0.5) add(temple, flat(new CylinderGeometry(top / Math.SQRT2, base / Math.SQRT2, height, 4, 1).rotateY(Math.PI / 4)), SATIN, { position: new Vector3(0, height / 2, 0) });
  else {
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const w = base + (top - base) * (k / (steps - 1));
      add(temple, new BoxGeometry(w, height / steps, w), SATIN, { position: new Vector3(0, (k + 0.5) * (height / steps), 0) });
    }
  }
  const lift = height + 0.32;
  add(temple, flat(new ConeGeometry(top / Math.SQRT2 * 1.05, 0.3, 4, 1).rotateY(Math.PI / 4)), SHINY, { position: new Vector3(0, lift + 0.15, 0) });
  add(temple, new SphereGeometry(1, 32, 16), GLOSS, { position: new Vector3(0, height + 0.16, 0), scale: 0.1 });
  add(temple, new TorusGeometry(0.24, 0.012, 8, 96), SHINY, { position: new Vector3(0, height + 0.16, 0), quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2 - 0.25) });
  temple.position.y = -(lift + 0.3) / 2;
  const view = new Group();
  view.add(temple);
  view.rotation.set(0.3 + 0.1 * r(), (r() < 0.5 ? -1 : 1) * (0.35 + 0.3 * r()), 0);
  group.add(view);
}

// A Rubik's cube caught mid-turn: 26 rounded cubies with their stickers (each face's colour as a grey, which is all a
// hologram keeps), one layer twisted part way, the whole seen corner-on.
const STICKER_GREYS = [0.95, 0.7, 0.55, 0.4, 0.82, 0.28];
function cube(r, group) {
  const cubie = new RoundedBoxGeometry(0.3, 0.3, 0.3, 3, 0.04);
  const sticker = new RoundedBoxGeometry(0.24, 0.24, 0.02, 2, 0.03);
  const body = new Group();
  const twist = new Group();
  const axis = Math.floor(r() * 3);
  const layer = r() < 0.5 ? -1 : 1;
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const at = [x, y, z];
        const parent = at[axis] === layer ? twist : body;
        add(parent, cubie, [0.0, 0.5, 0.05], { position: new Vector3(x, y, z).multiplyScalar(0.31) });
        faces.forEach((n, fi) => {
          if (n[0] && n[0] !== x) return;
          if (n[1] && n[1] !== y) return;
          if (n[2] && n[2] !== z) return;
          const nv = new Vector3(...n);
          const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), nv);
          // Scrambled: each sticker one of the six greys, its face's most often.
          const g = r() < 0.55 ? STICKER_GREYS[fi] : STICKER_GREYS[Math.floor(r() * 6)];
          add(parent, sticker, [0.0, 0.25, g], { position: new Vector3(x, y, z).multiplyScalar(0.31).addScaledVector(nv, 0.152), quaternion: q });
        });
      }
    }
  }
  const ax = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  twist.quaternion.setFromAxisAngle(ax, (r() < 0.5 ? -1 : 1) * (0.35 + 0.35 * r()));
  body.add(twist);
  // Corner-on, three faces showing.
  body.rotation.set(0.55 + 0.15 * r(), 0.75 + 0.15 * (r() - 0.5), 0.1 * (r() - 0.5));
  group.add(body);
}

const BUILDERS = { head, crystals, gear, chess, knot, atom, cube, saturn, pyramid };
// Scenes that sit further back in the window.
const FILL = { cube: 0.72, pyramid: 0.8 };

// yieldFrame: awaited between the heavier pieces, so a build is spread over frames.
export async function buildLightScene(kind, seed, { yieldFrame = async () => {} } = {}) {
  const r = mulberry(seed * 2654435761 + kind.length * 97);
  const group = new Group();
  await BUILDERS[kind](r, group, yieldFrame);
  return { group, fill: FILL[kind] ?? 1, dispose: () => group.traverse((o) => o.geometry?.dispose()) };
}

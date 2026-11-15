// The gears in the hologram, from day 11's gear builders: a frozen spray of chunky gears thrown out from the middle
// (buildGearSpray), and day 11's whole trains (buildMachine). diorama.js renders them inside the glass.
import { BufferGeometry, BufferAttribute, BoxGeometry, CylinderGeometry, Mesh, InstancedMesh, Group, Matrix4, Vector3 } from "three";
import { createMachine } from "../11/train.js";
import * as gearLib from "../11/gears.js";
import * as escLib from "../11/escapement.js";
import * as chainLib from "../11/chain.js";

function toGeometry(data) {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(data.position, 3));
  if (data.normal) g.setAttribute("normal", new BufferAttribute(data.normal, 3));
  g.setIndex(new BufferAttribute(data.index, 1));
  if (!data.normal) g.computeVertexNormals();
  return g;
}

function merge(list) {
  let nv = 0, ni = 0;
  for (const g of list) {
    nv += g.attributes.position.count;
    ni += g.index.count;
  }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), I = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of list) {
    P.set(g.attributes.position.array, ov * 3);
    N.set(g.attributes.normal.array, ov * 3);
    const idx = g.index.array;
    for (let k = 0; k < idx.length; k++) I[oi + k] = idx[k] + ov;
    ov += g.attributes.position.count;
    oi += idx.length;
    g.dispose();
  }
  return toGeometry({ position: P, normal: N, index: I });
}

function zCylinder(r, length, x = 0, y = 0, z = 0, segments = 32) {
  const g = new CylinderGeometry(r, r, length, segments);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

// Day 11's crank, yoke and carrier, which its main.js makes from primitives.
const BUILDERS = {
  crank: (a) => {
    const side = a.pinSide ?? 1;
    return merge([
      zCylinder(a.radius, a.thickness, 0, 0, 0, 48),
      zCylinder(a.hubRadius ?? a.radius * 0.3, a.thickness * 1.6),
      zCylinder(a.pinRadius, a.pinLength, a.pinOffset, 0, side * (a.thickness / 2 + a.pinLength / 2), 20),
    ]);
  },
  yoke: (a) => {
    const ox = a.slotWidth / 2 + a.wall / 2, oy = a.slotLength / 2 + a.wall / 2;
    const side = (x) => new BoxGeometry(a.wall, a.slotLength + 2 * a.wall, a.thickness).translate(x, 0, 0);
    const end = (y) => new BoxGeometry(a.slotWidth, a.wall, a.thickness).translate(0, y, 0);
    return merge([side(-ox), side(ox), end(-oy), end(oy)]);
  },
  carrier: (a) => {
    const side = a.pinSide ?? 1;
    const parts = [zCylinder(a.hubRadius ?? a.armWidth, a.thickness, 0, 0, 0, 32)];
    for (const ang of a.angles) {
      const x = Math.cos(ang) * a.radius, y = Math.sin(ang) * a.radius;
      const arm = new BoxGeometry(a.radius, a.armWidth, a.thickness);
      arm.translate(a.radius / 2, 0, 0);
      arm.rotateZ(ang);
      parts.push(arm, zCylinder(a.armWidth / 2, a.thickness, x, y), zCylinder(a.pinRadius, a.pinLength, x, y, side * (a.thickness / 2 + a.pinLength / 2), 16));
    }
    return merge(parts);
  },
};

function partGeometry(part) {
  const b = part.build;
  if (b.result?.position) return toGeometry(b.result);
  if (b.module === "train") return BUILDERS[b.fn] ? BUILDERS[b.fn](b.args) : null;
  const lib = b.module === "escapement.js" ? escLib : b.module === "chain.js" ? chainLib : gearLib;
  return lib[b.fn] ? toGeometry(lib[b.fn](b.args)) : null;
}

// One machine: its parts (and axles) as meshes in a group, centred on the origin, R its bounding radius.
export function buildMachine(seed, material) {
  const machine = createMachine({ seed, chamfer: 0.5 });
  const group = new Group();
  const meshes = [];
  for (const part of machine.parts) {
    if (part.kind === "chain") {
      const ids = Array.from({ length: part.linkCount }, (_, i) => i);
      const kinds = { inner: ids.filter((i) => part.linkKind(i) === "inner"), outer: ids.filter((i) => part.linkKind(i) !== "inner") };
      for (const [kind, list] of Object.entries(kinds)) {
        if (!list.length) continue;
        const g = toGeometry(kind === "inner" ? chainLib.rollerLink({ pitch: part.pitch }) : chainLib.plateLink({ pitch: part.pitch }));
        const inst = new InstancedMesh(g, material, list.length);
        inst.frustumCulled = false;
        inst.userData = { part, links: list };
        group.add(inst);
        meshes.push(inst);
      }
      continue;
    }
    const g = partGeometry(part);
    if (!g) continue;
    const mesh = new Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.userData = { part };
    group.add(mesh);
    meshes.push(mesh);
  }
  for (const a of machine.axles) {
    const dir = new Vector3(...a.dir).normalize();
    const g = new CylinderGeometry(a.radius, a.radius, a.to - a.from, 16);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, (a.from + a.to) / 2);
    const mesh = new Mesh(g, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.matrix.lookAt(new Vector3(), dir.clone().negate(), Math.abs(dir.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0));
    mesh.matrix.setPosition(...a.origin);
    group.add(mesh);
    meshes.push(mesh);
  }
  const dispose = () => meshes.forEach((m) => m.geometry.dispose());
  return { machine, group, meshes, R: machine.bounds?.radius ?? 0.7, layout: machine.escapement.layout, dispose };
}

const _link = new Matrix4();
// Poses every part at this moment of its escapement.
export function poseMachine(m, time, period) {
  const esc = escLib.motion(time, { period, layout: m.layout });
  for (const mesh of m.meshes) {
    const { part, links } = mesh.userData;
    if (!part) continue;
    if (links) {
      links.forEach((i, j) => mesh.setMatrixAt(j, part.linkPose(i, esc.wheel, _link)));
      mesh.instanceMatrix.needsUpdate = true;
    } else mesh.matrix.copy(part.pose(esc.wheel, esc.anchor));
    mesh.matrixWorldNeedsUpdate = true;
  }
}

const mulberry = (a) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The gears a spray is made of (picked from a gallery of day 11's): spur gears with a solid, web, spoked or holed body, a
// coarse one, a worn one, helical, herringbone, bevel (chamfered or sharp), internal ring, worm and worm wheel.
const GEAR_KINDS = [
  (a) => gearLib.spurGear({ ...a, style: "solid" }),
  (a) => gearLib.spurGear({ ...a, style: "web" }),
  (a) => gearLib.spurGear({ ...a, style: "spokes" }),
  (a) => gearLib.spurGear({ ...a, style: "holes" }),
  (a, rand) => gearLib.spurGear({ ...a, teeth: Math.round(rand(7, 10)), width: a.module * rand(8, 11), style: "solid" }),
  (a) => gearLib.spurGear({ ...a, style: "web", erosion: 0.6 }),
  (a, rand, r) => gearLib.helicalGear({ ...a, style: "solid", helix: rand(15, 30) * (Math.PI / 180) * (r() < 0.5 ? 1 : -1) }),
  (a, rand) => gearLib.helicalGear({ ...a, style: "solid", herringbone: true, helix: rand(20, 30) * (Math.PI / 180) }),
  (a, rand) => gearLib.bevelGear({ teeth: a.teeth, module: a.module, pitchAngle: rand(0.5, 1.0), bore: a.bore, chamfer: a.chamfer, seed: a.seed }),
  (a, rand) => gearLib.bevelGear({ teeth: a.teeth, module: a.module, pitchAngle: rand(0.5, 1.0), bore: a.bore, chamfer: 0, seed: a.seed }),
  (a, rand) => gearLib.ringGear({ teeth: a.teeth + 12, module: a.module, width: a.module * rand(4, 7), rim: a.module * rand(2.5, 4), chamfer: a.chamfer, seed: a.seed }),
  (a, rand) => gearLib.worm({ module: a.module * 1.4, starts: 1, length: a.module * rand(14, 22), chamfer: a.chamfer, seed: a.seed }),
  (a) => gearLib.wormWheel({ ...a, style: "solid" }),
];

// A frozen burst of chunky gears (GEAR_KINDS), scattered through a ball and flung outward, each turned partly to face
// out. surf: metalness, roughness, albedo, per mesh.
export async function buildGearSpray(seed, { count = 26, radius = 1, yieldFrame = null } = {}) {
  const r = mulberry(seed * 2654435761);
  const rand = (a, b) => a + (b - a) * r();
  const group = new Group();
  const placed = [];
  const surfaces = [[0.95, 0.28, 0.9], [0.9, 0.35, 0.75], [0.85, 0.22, 0.95]];
  for (let i = 0, tries = 0; i < count && tries < count * 60; tries++) {
    const big = i < 3 && tries < 40;
    const teeth = Math.round(big ? rand(18, 34) : rand(8, 22));
    const mod = (big ? rand(0.022, 0.03) : rand(0.016, 0.03)) * radius;
    const R = (teeth * mod) / 2 + mod;
    // Somewhere in the ball, the big ones nearer the middle, not cutting through another.
    const dir = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
    const at = dir.clone().multiplyScalar(radius * (big ? rand(0.0, 0.3) : rand(0.25, 1.0)));
    // A quick estimate first (a ring gear is wider than its teeth say), the exact bounds once it's built.
    if (placed.some((p) => p.at.distanceTo(at) < p.R + R * 1.1)) continue;
    const args = { teeth, module: mod, width: mod * rand(5, 10), bore: mod * rand(1.2, 2.2), hub: mod * rand(2.6, 3.6), seed: Math.floor(r() * 1e6), chamfer: 0.18 * mod };
    const data = GEAR_KINDS[Math.floor(r() * GEAR_KINDS.length)](args, rand, r);
    const mesh = new Mesh(toGeometry(data));
    // Gears never cut through each other: their bounding spheres (teeth, width and hub) don't overlap.
    mesh.geometry.computeBoundingSphere();
    const bound = mesh.geometry.boundingSphere;
    // Its axis partly toward the way out, the rest random, and a random turn about it.
    const axis = dir.clone().lerp(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), 0.6).normalize();
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), axis);
    mesh.rotateZ(r() * Math.PI * 2);
    mesh.position.copy(at);
    mesh.updateMatrix();
    const centre = bound.center.clone().applyMatrix4(mesh.matrix);
    if (placed.some((p) => p.at.distanceTo(centre) < p.R + bound.radius)) {
      mesh.geometry.dispose();
      continue;
    }
    mesh.userData.surf = surfaces[Math.floor(r() * surfaces.length)];
    group.add(mesh);
    placed.push({ at: centre, R: bound.radius });
    i++;
    // A gear a frame, so building the next spray doesn't hold up the one on show.
    if (yieldFrame) await yieldFrame();
  }
  return { group, radius, dispose: () => group.traverse((o) => o.geometry?.dispose()) };
}

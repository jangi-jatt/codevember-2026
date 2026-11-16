// Day 2's burst as a 3D scene for the hologram: a shell torn into curved pieces flying out with chips and drops,
// everything at position = start + velocity * t (after 2/main.js's build and place).
import { Group, Mesh, InstancedMesh, IcosahedronGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { mergeVertices } from "third_party/BufferGeometryUtils.js";
import { peelPieces, peelPiecesAsync, chipGeometry, mulberry32, randomDirection } from "../2/fruit.js";
import { loadShape, offsetGeometry } from "../2/shapes.js";
import { SUBJECTS } from "../2/subjects.js";

// The bursts recorded: day 2's subjects on its shapes.
export const BURSTS = [
  { subject: "shell", form: "sphere" },
  { subject: "bronze", form: "torus" },
];

// Day 2's shapes tessellated coarser: seen through the hologram's blurred, half-resolution bands, its full detail (some
// 350k vertices a burst) only cost frames to merge and bake.
const DETAIL = 0.6;
// Chips smaller than this are left out: too small to show, and each one a part to merge.
const MIN_CHIP = 0.03;

// Builds every form's shape up front (each is built once and kept), a frame apart.
export async function preloadShatterForms(yieldFrame) {
  for (const { form } of BURSTS) {
    await loadShape(form, { detail: DETAIL });
    await yieldFrame?.();
  }
}

const surfOf = (hex, metal, rough) => {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => (v / 255) ** 2.2);
  return [metal, rough, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]];
};

// Every burst is recorded in the lightest of day 2's finishes: the recording keeps only brightness.
const LIGHTEST = Object.values(SUBJECTS)
  .filter((s) => !s.disabled)
  .map((s) => surfOf(s.shell.outer, s.shell.metal ?? 0, s.shell.outerRough))
  .reduce((a, b) => (b[2] > a[2] ? b : a));

const MAX_CHIPS = 240;
const MAX_DROPS = 160;
const HIDE = new Matrix4().makeScale(0, 0, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _v = new Vector3();
const _z = new Vector3(0, 0, 1);
const _x = new Vector3(1, 0, 0);

// spray: how much of the subject's spray (0..1), as day 2's slider.
export async function buildShatter({ seed, subject: subjectName, form, material, spray: amount = 0.5, yieldFrame = null }) {
  const subject = SUBJECTS[subjectName] ?? SUBJECTS.shell;
  const shape = await loadShape(form, { detail: DETAIL });
  const group = new Group();
  const rand = mulberry32(seed);
  // A side burst (day 2's), from a side turned 25 to 55 degrees off the viewer (+z, as the plate shows it): the pieces
  // there thrown out toward the viewer and across, so the stream shows in depth, fading to none round the back, which
  // stays whole.
  const tilt = ((25 + 30 * rand()) * Math.PI) / 180;
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const a = rand() * Math.PI * 2;
  const side = new Vector3(Math.cos(a) * sin, Math.sin(a) * sin + 0.1, cos).normalize();
  const energy = (d) => Math.max(0, Math.min(1, (d.dot(side) + 0.1) / 0.8)) ** 1.6;
  const launch = (d, speed) => d.clone().multiplyScalar(0.5).add(side).normalize().multiplyScalar(speed).add(randomDirection(rand).multiplyScalar(speed * 0.25));

  const outer = LIGHTEST;
  const fracture = subject.fracture ?? {};
  let impact = null;
  if (fracture.stretch) {
    let best = -Infinity;
    const P = shape.position;
    for (let i = 0; i < P.length; i += 3) {
      const d = P[i] * side.x + P[i + 1] * side.y + P[i + 2] * side.z;
      if (d > best) (best = d), (impact = new Vector3(P[i], P[i + 1], P[i + 2]));
    }
  }
  const peel = { seed, count: subject.pieces, shape, thickness: subject.thickness, warp: fracture.warp, stretch: fracture.stretch, impact };
  const peeled = yieldFrame ? await peelPiecesAsync(peel, yieldFrame) : peelPieces(peel);
  const pieces = peeled.map((piece) => {
    const mesh = new Mesh(piece.geometry, material);
    mesh.userData.surf = outer;
    mesh.frustumCulled = false;
    group.add(mesh);
    const e = energy(piece.direction);
    return { mesh, centre: piece.centre, tear: piece.tear, velocity: launch(piece.direction, (2 + 2 * rand()) * e), axis: randomDirection(rand), spin: (2 + 7 * rand()) * e };
  });
  if (subject.core) {
    const core = new Mesh(offsetGeometry(shape, subject.thickness + 0.004), material);
    core.userData.surf = LIGHTEST;
    core.frustumCulled = false;
    group.add(core);
  }

  // Chips off the shell where the burst is, drops out through the tears.
  const chipShapes = [3, 4, 5].map((n, i) => chipGeometry(i + 7, n));
  const chipMeshes = chipShapes.map((g) => new InstancedMesh(g, material, Math.ceil(MAX_CHIPS / chipShapes.length)));
  const dropShape = mergeVertices(new IcosahedronGeometry(1, 2));
  dropShape.computeVertexNormals();
  const drops = new InstancedMesh(dropShape, material, MAX_DROPS);
  for (const m of chipMeshes) m.userData.surf = outer;
  drops.userData.surf = [0.0, 0.08, 0.7];
  for (const m of [...chipMeshes, drops]) {
    m.frustumCulled = false;
    group.add(m);
  }
  const p = new Vector3(), n = new Vector3();
  const chips = [];
  const chipCount = Math.round(MAX_CHIPS * amount * (subject.spray?.chips ?? 0));
  for (let i = 0; i < chipCount; i++) {
    shape.sample(rand, p, n);
    for (let k = 0; k < 8 && rand() > energy(n); k++) shape.sample(rand, p, n);
    const e = Math.max(0.15, energy(n));
    const big = rand() < 0.012;
    const size = big ? 0.12 + 0.12 * rand() : 0.012 + 0.07 * rand() ** 2.2;
    const speed = (1 + 6 * rand() ** 1.5) * e;
    if (size < MIN_CHIP) continue;
    chips.push({ start: p.clone().addScaledVector(n, -subject.thickness * 0.5), velocity: launch(n.clone(), big ? speed * 1.6 + 2 : speed), size, axis: randomDirection(rand), spin: 3 + 14 * rand(), turn: randomDirection(rand) });
  }
  const tears = pieces.flatMap((piece) => piece.tear);
  const spray = [];
  const dropCount = Math.round(MAX_DROPS * amount * (subject.spray?.drops ?? 0));
  for (let i = 0; i < dropCount && tears.length; i++) {
    const tear = tears[Math.floor(rand() * tears.length)];
    const speed = 1 + 6.5 * rand() ** 2.2;
    const dir = tear.n.clone().add(randomDirection(rand).multiplyScalar(0.08)).normalize();
    spray.push({ start: tear.p.clone().addScaledVector(tear.n, -(subject.thickness + 0.02 + 0.08 * rand())), velocity: dir.multiplyScalar(speed), size: (0.004 + 0.03 * rand() ** 4) / Math.sqrt(speed / 2) });
  }

  return {
    group,
    // The outermost a piece gets by t, for framing.
    radius: (t) => 1 + 4.5 * t,
    place(t) {
      for (const pc of pieces) {
        pc.mesh.position.copy(pc.centre).addScaledVector(pc.velocity, t);
        pc.mesh.quaternion.setFromAxisAngle(pc.axis, pc.spin * t);
      }
      chips.forEach((c, i) => {
        const mesh = chipMeshes[i % chipMeshes.length];
        const at = Math.floor(i / chipMeshes.length);
        if (t <= 0) return mesh.setMatrixAt(at, HIDE);
        // Splinters pointing along their flight, rolling about it.
        _p.copy(c.start).addScaledVector(c.velocity, t);
        _q.setFromUnitVectors(_x, _v.copy(c.velocity).normalize()).multiply(_q2.setFromAxisAngle(_x, c.spin * t));
        mesh.setMatrixAt(at, _m.compose(_p, _q, _s.set(c.size * 2.6, c.size * 0.55, c.size)));
      });
      for (const m of chipMeshes) {
        for (let k = Math.ceil(chips.length / chipMeshes.length); k < m.count; k++) m.setMatrixAt(k, HIDE);
        m.instanceMatrix.needsUpdate = true;
      }
      for (let i = 0; i < MAX_DROPS; i++) {
        const d = spray[i];
        if (!d || t <= 0) {
          drops.setMatrixAt(i, HIDE);
          continue;
        }
        _p.copy(d.start).addScaledVector(d.velocity, t);
        const speed = d.velocity.length();
        _q.setFromUnitVectors(_z, _v.copy(d.velocity).normalize());
        const stretch = 1 + speed * speed * 0.35 * Math.min(1, t * 8);
        const thin = d.size / stretch ** 0.25;
        drops.setMatrixAt(i, _m.compose(_p, _q, _s.set(thin, thin, d.size * stretch)));
      }
      drops.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      group.traverse((o) => o.geometry?.dispose());
    },
  };
}

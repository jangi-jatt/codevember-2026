// A pane of glass cracked from a point of impact: radial cracks and rings of them, the way a window breaks. The pane
// is cut into convex shards (a Voronoi diagram whose seeds crowd toward the impact), and each shard becomes a slab
// with real thickness: a front, a back and a side face along every crack.

const TAU = Math.PI * 2;

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Keeps the part of a convex polygon where a * x + b * y <= c.
function clip(poly, a, b, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c;
    const dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if (dp <= 0 !== dq <= 0) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

// The shards of a square pane (half-size `half`) cracked from `impact`: polygons, counter-clockwise.
function crackPane(seed, half, impact) {
  const rand = mulberry32(seed);
  const seeds = [[impact[0], impact[1]]];
  let r = 0.09;
  for (let k = 0; r < 5; k++) {
    const n = Math.round(7 + 1.7 * k + rand() * 2);
    const offset = rand() * TAU;
    for (let i = 0; i < n; i++) {
      const a = offset + ((i + (rand() - 0.5) * 0.6) / n) * TAU;
      const rr = r * (1 + (rand() - 0.5) * 0.32);
      const p = [impact[0] + Math.cos(a) * rr, impact[1] + Math.sin(a) * rr];
      if (Math.abs(p[0]) < half + 0.5 && Math.abs(p[1]) < half + 0.5) seeds.push(p);
    }
    r *= 1.4 + 0.12 * rand();
  }
  const shards = [];
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    let poly = [[-half, -half], [half, -half], [half, half], [-half, half]];
    for (let j = 0; j < seeds.length; j++) {
      if (j === i) continue;
      const o = seeds[j];
      const dx = o[0] - s[0];
      const dy = o[1] - s[1];
      const reach = poly.reduce((m, p) => Math.max(m, Math.hypot(p[0] - s[0], p[1] - s[1])), 0);
      if (Math.hypot(dx, dy) > 2 * reach) continue;
      poly = clip(poly, dx, dy, (o[0] * o[0] + o[1] * o[1] - s[0] * s[0] - s[1] * s[1]) / 2);
      if (poly.length < 3) break;
    }
    if (poly.length < 3) continue;
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k];
      const q = poly[(k + 1) % poly.length];
      const w = p[0] * q[1] - q[0] * p[1];
      area += w;
      cx += (p[0] + q[0]) * w;
      cy += (p[1] + q[1]) * w;
    }
    if (Math.abs(area) < 2e-4) continue;
    shards.push({ poly, centre: [cx / (3 * area), cy / (3 * area)], area: Math.abs(area) / 2 });
  }
  return shards;
}

// A slab from a convex polygon (counter-clockwise, relative to `centre`): front face (+z), back face (-z) and a side
// face per edge. `kind` per vertex: 0 front, 1 side, 2 back. uv maps the pane's x, y onto the image.
function slabArrays(poly, centre, thickness, half, gap = 0, tris = null) {
  const pos = [];
  const nor = [];
  const uv = [];
  const kind = [];
  const h = thickness / 2;
  const pts = poly.map((p) => {
    // gap > 0 pulls each shard in from its cracks (a fine dark line); gap < 0 lets neighbours overlap a hair, so the
    // whole pane reads as one unbroken sheet until the pieces move.
    const dx = p[0] - centre[0];
    const dy = p[1] - centre[1];
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, d - gap) / d;
    return [dx * k, dy * k, p[0] - dx + dx * k, p[1] - dy + dy * k];
  });
  const push = (x, y, z, nx, ny, nz, wx, wy, k) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uv.push((wx + half) / (2 * half), (wy + half) / (2 * half));
    kind.push(k);
  };
  // Drawn far to near for a view from the front (the glass is see-through): back face, sides, front face.
  // The faces are triangulated by the caller for an outline that is not convex (a fan from the first corner otherwise).
  const triangles = tris ?? Array.from({ length: pts.length - 2 }, (_, i) => [0, i + 1, i + 2]);
  for (const [a, b, c] of triangles) for (const p of [pts[a], pts[c], pts[b]]) push(p[0], p[1], -h, 0, 0, -1, p[2], p[3], 2);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const nx = dy / l;
    const ny = -dx / l;
    for (const [p, z] of [[a, h], [a, -h], [b, -h], [a, h], [b, -h], [b, h]]) push(p[0], p[1], z, nx, ny, 0, p[2], p[3], 1);
  }
  for (const [a, b, c] of triangles) for (const p of [pts[a], pts[b], pts[c]]) push(p[0], p[1], h, 0, 0, 1, p[2], p[3], 0);
  return { pos, nor, uv, kind };
}

export { crackPane, slabArrays, mulberry32, TAU };

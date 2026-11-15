import * as THREE from 'three';

const PHI = (1 + Math.sqrt(5)) * 0.5;
const TWO_PI = Math.PI * 2;

export const SHAPE_LIST = [
  { id: 'card', label: 'Trading card' },
  { id: 'glass', label: 'Glass plate' },
];

function vAdd(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vSub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vScale(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

function vDot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vLen(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

function vNorm(a) {
  const l = vLen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function signedPermutations(vec) {
  const out = [];
  for (let mask = 0; mask < 8; mask++) {
    const candidate = vec.map((x, idx) => ((mask >> idx) & 1 ? -x : x));
    if (candidate.some((x, idx) => x !== vec[idx] && vec[idx] === 0)) continue;
    if (!out.some((q) => q.every((x, idx) => x === candidate[idx]))) {
      out.push(candidate);
    }
  }
  return out;
}

function cyclicSigned(vec) {
  return [0, 1, 2].flatMap((k) =>
    signedPermutations([vec[k % 3], vec[(k + 1) % 3], vec[(k + 2) % 3]])
  );
}

function polyhedronCorners(shapeId) {
  switch (shapeId) {
    case 'diamond':
      return { verts: cyclicSigned([1, 0, 0]) };
    case 'dodecahedron':
      return {
        verts: [...signedPermutations([1, 1, 1]), ...cyclicSigned([0, 1 / PHI, PHI])],
        up: [0, 1, PHI],
      };
    case 'icosahedron':
    default:
      return {
        verts: cyclicSigned([0, 1, PHI]),
        up: [0, 1, PHI],
      };
  }
}

const topologyCache = new Map();

function getPolyhedronTopology(shapeId) {
  const cached = topologyCache.get(shapeId);
  if (cached) return cached;

  const spec = polyhedronCorners(shapeId);
  let verts = spec.verts;
  if (spec.up) {
    const upVec = new THREE.Vector3(...vNorm(spec.up));
    const quat = new THREE.Quaternion().setFromUnitVectors(upVec, new THREE.Vector3(0, 1, 0));
    verts = verts.map((p) => new THREE.Vector3(...p).applyQuaternion(quat).toArray());
  }

  const ys = verts.map((p) => p[1]);
  const midY = (Math.min(...ys) + Math.max(...ys)) * 0.5;
  verts = verts.map((p) => [p[0], p[1] - midY, p[2]]);
  const maxR = Math.max(...verts.map(vLen));
  verts = verts.map((p) => vScale(p, 1 / maxR));

  const eps = 1e-6;
  const faces = [];
  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      for (let k = j + 1; k < verts.length; k++) {
        let normal = vCross(vSub(verts[j], verts[i]), vSub(verts[k], verts[i]));
        if (vLen(normal) < eps) continue;
        normal = vNorm(normal);
        let planeDist = vDot(normal, verts[i]);
        const sideDists = verts.map((p) => vDot(normal, p) - planeDist);
        if (sideDists.every((x) => x > -eps)) {
          normal = vScale(normal, -1);
          planeDist = -planeDist;
        } else if (!sideDists.every((x) => x < eps)) {
          continue;
        }
        if (faces.some((f) => vDot(f.normal, normal) > 1 - 1e-6)) continue;

        const onFace = verts
          .map((_, idx) => idx)
          .filter((idx) => Math.abs(vDot(normal, verts[idx]) - planeDist) < eps);
        const center = vScale(
          onFace.reduce((sum, idx) => vAdd(sum, verts[idx]), [0, 0, 0]),
          1 / onFace.length
        );
        const isLevel = Math.abs(normal[1]) > 0.999;
        const axisB = vNorm(
          isLevel ? [0, 0, -Math.sign(normal[1])] : vSub([0, 1, 0], vScale(normal, normal[1]))
        );
        const axisT = vCross(axisB, normal);
        const sortedIdx = onFace
          .slice()
          .sort(
            (p, q) =>
              Math.atan2(vDot(vSub(verts[p], center), axisB), vDot(vSub(verts[p], center), axisT)) -
              Math.atan2(vDot(vSub(verts[q], center), axisB), vDot(vSub(verts[q], center), axisT))
          );
        faces.push({
          normal,
          axisT,
          axisB,
          planeDist,
          vertIdx: sortedIdx,
          center,
          apothem: 0,
          edgeDirs: [],
          phase: 0,
          neighbors: [],
        });
      }
    }
  }

  const azimuthOf = (f) => (Math.atan2(f.normal[0], f.normal[2]) + TWO_PI + 0.01) % TWO_PI;
  faces.sort((a, b) =>
    Math.abs(a.normal[1] - b.normal[1]) > 1e-4
      ? b.normal[1] - a.normal[1]
      : azimuthOf(a) - azimuthOf(b)
  );

  const edgeOwners = new Map();
  const edgeKey = (p, q) => (p < q ? `${p}:${q}` : `${q}:${p}`);
  faces.forEach((f, fi) => {
    f.vertIdx.forEach((p, idx) => {
      const q = f.vertIdx[(idx + 1) % f.vertIdx.length];
      const key = edgeKey(p, q);
      const list = edgeOwners.get(key) ?? [];
      list.push(fi);
      edgeOwners.set(key, list);
    });
  });

  faces.forEach((f, fi) => {
    const count = f.vertIdx.length;
    f.edgeDirs = f.vertIdx.map((p, idx) =>
      vNorm(vCross(vSub(verts[f.vertIdx[(idx + 1) % count]], verts[p]), f.normal))
    );
    f.apothem = Math.min(
      ...f.vertIdx.map((p, idx) => vDot(vSub(verts[p], f.center), f.edgeDirs[idx]))
    );
    f.phase = Math.atan2(vDot(f.edgeDirs[0], f.axisB), vDot(f.edgeDirs[0], f.axisT));
    f.neighbors = f.vertIdx.map((p, idx) => {
      const q = f.vertIdx[(idx + 1) % count];
      return edgeOwners.get(edgeKey(p, q)).find((other) => other !== fi);
    });
  });

  const cornerNormals = verts.map((_, vIdx) =>
    vNorm(
      faces.reduce(
        (sum, f) => (f.vertIdx.includes(vIdx) ? vAdd(sum, f.normal) : sum),
        [0, 0, 0]
      )
    )
  );

  const topo = {
    verts,
    faces,
    cornerNormals,
    refApothem: Math.max(...faces.map((f) => f.apothem)),
    minPlaneDist: Math.min(...faces.map((f) => f.planeDist)),
  };
  topologyCache.set(shapeId, topo);
  return topo;
}

/**
 * Builds a Minkowski ball-rolled smoothed polyhedron (icosahedron, diamond, dodecahedron)
 * with exact spherical corners, cylindrical bevels, and flat facets, carrying both exact
 * 3D normals (for Snell refraction into the 3D interior core) and unfolded per-face frames.
 */
export function createSmoothedSolidGeometry(shapeId, roundness = 0.28, bevelSteps = 16) {
  const topo = getPolyhedronTopology(shapeId);
  const fitRadius = shapeId === 'diamond' ? 1.28 : 1.18;
  const dMin = topo.minPlaneDist * fitRadius;

  // Map UI roundness [0.04..0.90] to physical fillet fraction up to 0.72 of inradius
  const clampedRound = THREE.MathUtils.clamp(roundness, 0.02, 0.92);
  const filletRadius = Math.min(
    Math.max(clampedRound * 0.74 * dMin, 0.004),
    dMin * 0.82
  );
  const coreScale = (1 - filletRadius / dMin) * fitRadius;
  const stepCount = Math.max(4, Math.round(bevelSteps));

  const positions = [];
  const normals = [];
  const uvs = [];
  const tangents = [];
  const faceTs = [];
  const faceBs = [];
  const facePs = [];
  const indices = [];

  const edgeMidNormals = topo.faces.map((f) =>
    f.neighbors.map((gIdx) => vNorm(vAdd(f.normal, topo.faces[gIdx].normal)))
  );
  const halfDihedrals = topo.faces.map((f) =>
    f.neighbors.map(
      (gIdx) => Math.acos(THREE.MathUtils.clamp(vDot(f.normal, topo.faces[gIdx].normal), -1, 1)) * 0.5
    )
  );
  const bevelWidths = topo.faces.map((_, fi) => {
    const avgHalf =
      halfDihedrals[fi].reduce((acc, val) => acc + val, 0) / halfDihedrals[fi].length;
    return filletRadius * Math.tan(avgHalf);
  });
  const totalApothems = topo.faces.map((f, fi) => coreScale * f.apothem + bevelWidths[fi]);
  const maxApothem = Math.max(...totalApothems);

  const layBevel = (t, halfAng) => {
    const cosH = Math.cos(halfAng);
    return (t * cosH) / (1 - t + t * cosH);
  };

  topo.faces.forEach((f, fi) => {
    const sideCount = f.vertIdx.length;
    const apothem = totalApothems[fi];
    const bWidth = bevelWidths[fi];
    const faceMeta = [sideCount, f.phase, maxApothem / apothem, bWidth / (2 * apothem)];
    const to2d = (vec) => [vDot(vec, f.axisT), vDot(vec, f.axisB)];

    const pushVert = (pos, nrm, x2d, y2d) => {
      positions.push(pos[0], pos[1], pos[2]);
      normals.push(nrm[0], nrm[1], nrm[2]);
      uvs.push(x2d / (2 * apothem) + 0.5, y2d / (2 * apothem) + 0.5);
      const tang = vNorm(vSub(f.axisT, vScale(nrm, vDot(nrm, f.axisT))));
      tangents.push(tang[0], tang[1], tang[2], 1);
      faceTs.push(f.axisT[0], f.axisT[1], f.axisT[2], fi);
      faceBs.push(f.axisB[0], f.axisB[1], f.axisB[2]);
      facePs.push(faceMeta[0], faceMeta[1], faceMeta[2], faceMeta[3]);
      return positions.length / 3 - 1;
    };

    const pushTri = (a, b, c) => {
      const pa = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
      const pb = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
      const pc = [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]];
      const na = [normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2]];
      const nb = [normals[b * 3], normals[b * 3 + 1], normals[b * 3 + 2]];
      const nc = [normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]];
      const faceCross = vCross(vSub(pb, pa), vSub(pc, pa));
      const sumN = vAdd(vAdd(na, nb), nc);
      if (vDot(faceCross, sumN) < 0) {
        indices.push(a, c, b);
      } else {
        indices.push(a, b, c);
      }
    };

    const pushQuad = (a, b, c, d) => {
      pushTri(a, b, c);
      pushTri(a, c, d);
    };

    const coreVerts = f.vertIdx.map((vIdx) => vScale(topo.verts[vIdx], coreScale));
    const core2d = coreVerts.map((p) => to2d(vSub(p, vScale(f.center, coreScale))));
    const edge2d = f.edgeDirs.map(to2d);

    // Flat inner polygon fan
    const centerIdx = pushVert(
      vAdd(vScale(f.center, coreScale), vScale(f.normal, filletRadius)),
      f.normal,
      0,
      0
    );
    const innerRing = coreVerts.map((p, idx) =>
      pushVert(vAdd(p, vScale(f.normal, filletRadius)), f.normal, core2d[idx][0], core2d[idx][1])
    );
    for (let i = 0; i < sideCount; i++) {
      pushTri(centerIdx, innerRing[i], innerRing[(i + 1) % sideCount]);
    }

    // Half-bevel cylindrical strips + spherical vertex patches
    for (let i = 0; i < sideCount; i++) {
      const nextI = (i + 1) % sideCount;
      const prevI = (i + sideCount - 1) % sideCount;
      const midN = edgeMidNormals[fi][i];
      const halfAng = halfDihedrals[fi][i];
      const stripRows = [];

      for (let k = 0; k <= stepCount; k++) {
        const t = k / stepCount;
        const g = layBevel(t, halfAng) * bWidth;
        const nv = vNorm(vAdd(vScale(f.normal, 1 - t), vScale(midN, t)));
        stripRows.push(
          [i, nextI].map((cornerIdx) =>
            pushVert(
              vAdd(coreVerts[cornerIdx], vScale(nv, filletRadius)),
              nv,
              core2d[cornerIdx][0] + edge2d[i][0] * g,
              core2d[cornerIdx][1] + edge2d[i][1] * g
            )
          )
        );
      }
      for (let k = 0; k < stepCount; k++) {
        pushQuad(
          stripRows[k][0],
          stripRows[k][1],
          stripRows[k + 1][1],
          stripRows[k + 1][0]
        );
      }

      const prevMidN = edgeMidNormals[fi][prevI];
      const prevHalfAng = halfDihedrals[fi][prevI];
      const cornerN = topo.cornerNormals[f.vertIdx[i]];
      const denom = 1 + edge2d[prevI][0] * edge2d[i][0] + edge2d[prevI][1] * edge2d[i][1];
      const invDenom = 1 / Math.max(denom, 1e-5);
      const ox =
        (edge2d[prevI][0] + edge2d[i][0]) * invDenom - edge2d[prevI][0] - edge2d[i][0];
      const oy =
        (edge2d[prevI][1] + edge2d[i][1]) * invDenom - edge2d[prevI][1] - edge2d[i][1];

      const patchGrid = [];
      for (let b = 0; b <= stepCount; b++) {
        const row = [];
        for (let a = 0; a <= stepCount; a++) {
          const u = a / stepCount;
          const v = b / stepCount;
          const ga = layBevel(u, prevHalfAng) * bWidth;
          const gb = layBevel(v, halfAng) * bWidth;
          const nv = vNorm(
            vAdd(
              vAdd(vScale(f.normal, (1 - u) * (1 - v)), vScale(prevMidN, u * (1 - v))),
              vAdd(vScale(midN, (1 - u) * v), vScale(cornerN, u * v))
            )
          );
          const safeW = Math.max(bWidth, 1e-6);
          row.push(
            pushVert(
              vAdd(coreVerts[i], vScale(nv, filletRadius)),
              nv,
              core2d[i][0] + edge2d[prevI][0] * ga + edge2d[i][0] * gb + (ox * ga * gb) / safeW,
              core2d[i][1] + edge2d[prevI][1] * ga + edge2d[i][1] * gb + (oy * ga * gb) / safeW
            )
          );
        }
        patchGrid.push(row);
      }
      for (let b = 0; b < stepCount; b++) {
        for (let a = 0; a < stepCount; a++) {
          pushQuad(
            patchGrid[b][a],
            patchGrid[b][a + 1],
            patchGrid[b + 1][a + 1],
            patchGrid[b + 1][a]
          );
        }
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('tangent', new THREE.Float32BufferAttribute(tangents, 4));
  geometry.setAttribute('faceT', new THREE.Float32BufferAttribute(faceTs, 4));
  geometry.setAttribute('faceB', new THREE.Float32BufferAttribute(faceBs, 3));
  geometry.setAttribute('faceP', new THREE.Float32BufferAttribute(facePs, 4));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  // Each flat facet as a window (object space): its centre, frame (t, b, outward n), outline and apothem.
  geometry.userData.faces = topo.faces.map((f) => ({
    center: vAdd(vScale(f.center, coreScale), vScale(f.normal, filletRadius)),
    n: f.normal,
    t: f.axisT,
    b: f.axisB,
    outline: f.vertIdx.map((vIdx) => vAdd(vScale(topo.verts[vIdx], coreScale), vScale(f.normal, filletRadius))),
    apothem: coreScale * f.apothem,
  }));
  return geometry;
}

// The cards: a trading card (thin stock, 63 x 88 mm, rounded corners) and a clean glass plate (a thick slab with
// polished, bevelled edges). Their two large faces each hold a chamber (uv in units of the card's height, faceP.x = 4);
// the cut edges are all border (faceP.x = 0).
export const CARDS = {
  card: { width: 1.5, height: 2.1, thickness: 0.016, corner: 0.09, bevel: 0.004 },
  glass: { width: 1.6, height: 2.1, thickness: 0.065, corner: 0.05, bevel: 0.02 },
};
export const CARD = CARDS.card;

export function createCardGeometry(style = 'card') {
  const { width, height, thickness, corner, bevel } = CARDS[style];
  const hw = width / 2 - bevel, hh = height / 2 - bevel, r = Math.max(corner - bevel, 0.001);
  const shape = new THREE.Shape();
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(hw, hh - r);
  shape.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw + r, hh);
  shape.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-hw, -hh + r);
  shape.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
  const depth = Math.max(thickness - 2 * bevel, 0.002);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 24 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  const pos = g.attributes.position, nor = g.attributes.normal, n = pos.count;
  const uvs = new Float32Array(n * 2), faceTs = new Float32Array(n * 4), faceBs = new Float32Array(n * 3), facePs = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), nz = nor.getZ(i);
    const face = Math.abs(nz) > 0.97;
    const front = nz > 0;
    uvs[i * 2] = (front ? x : -x) / height + 0.5;
    uvs[i * 2 + 1] = y / height + 0.5;
    faceTs.set([front ? 1 : -1, 0, 0, front ? 0 : 1], i * 4);
    faceBs.set([0, 1, 0], i * 3);
    facePs.set([face ? 4 : 0, 0, 1, 0], i * 4);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('faceT', new THREE.BufferAttribute(faceTs, 4));
  g.setAttribute('faceB', new THREE.BufferAttribute(faceBs, 3));
  g.setAttribute('faceP', new THREE.BufferAttribute(facePs, 4));
  g.userData.aspect = width / height;
  g.userData.corner = corner / height;
  g.computeBoundingSphere();
  return g;
}

export function buildSurfaceGeometry(shapeId, roundness = 0.35) {
  switch (shapeId) {
    case 'card':
    case 'glass':
      return createCardGeometry(shapeId);
    case 'icosahedron':
      return createSmoothedSolidGeometry('icosahedron', roundness, 16);
    case 'diamond':
      return createSmoothedSolidGeometry('diamond', roundness, 16);
    case 'dodecahedron':
      return createSmoothedSolidGeometry('dodecahedron', roundness, 14);
    default:
      return createSmoothedSolidGeometry('icosahedron', roundness, 16);
  }
}

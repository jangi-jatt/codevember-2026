import { Vector3, Quaternion, Matrix4 } from "three";

// Water parcels in world space around a spinning body. Surface tension holds each one at a rest height on the coat
// with a capped grip, so a fast spin flings parcels off; free ones fall back under a weak cohesion pull. Each parcel
// wobbles as an ellipsoid (stretch along an axis, volume kept) that follows its acceleration.

const _q = new Vector3(), _n = new Vector3(), _vs = new Vector3(), _rel = new Vector3(), _a = new Vector3(), _d = new Vector3();
const _inv = new Matrix4(), _rot = new Quaternion();

// Day 3's field sampler clamps to its grid; beyond it, add the distance to the grid's box.
export function bodyDistance(sdf, x, y, z) {
  const lo = sdf.min, hi = sdf.size, h = sdf.step * 0.5;
  const cx = Math.min(lo[0] + hi - h, Math.max(lo[0] + h, x));
  const cy = Math.min(lo[1] + hi - h, Math.max(lo[1] + h, y));
  const cz = Math.min(lo[2] + hi - h, Math.max(lo[2] + h, z));
  return sdf.sample(cx, cy, cz) + Math.hypot(x - cx, y - cy, z - cz);
}

export const TUNING = {
  grip: 7, // largest acceleration the coat holds a parcel with (world units / s^2)
  stiffness: 60, // normal spring towards the rest height
  normalDamping: 9,
  drag: 2.5, // tangential coupling to the moving surface: low values slosh
  release: 0.35, // beyond rest height + this many radii, the grip fades out
  cohesion: 1.2, // pull back towards the body once free
  dropCohesion: 3.5,
  dropDamping: 0.8,
  freeDamping: 0.15,
  spread: 18, // parcels push apart when they overlap
  wobbleFrequency: 2.4, // Hz
  wobbleDamping: 0.12, // damping ratio
  wobbleGain: 0.02, // rest stretch per unit of acceleration
  wobbleMax: 0.45,
};

export class Parcels {
  constructor() {
    this.list = [];
  }

  // shape: day 3's loadShape result (CPU sdf sample/grad in object space); body: Object3D with uniform scale.
  reset(shape, body, { count, size, film, free }, random = Math.random) {
    this.list = [];
    body.updateMatrixWorld();
    const c = new Vector3().fromArray(shape.center);
    const o = new Vector3(), d = new Vector3(), n = new Vector3();
    const scale = body.scale.x;
    for (let tries = 0; this.list.length < count + free && tries < 200; tries++) {
      d.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      if (d.lengthSq() > 1 || d.lengthSq() < 1e-4) continue;
      d.normalize();
      const r = size * scale * 0.5 * (0.6 + random() * 0.8);
      if (this.list.length >= count) {
        // Free blobs start floating a little way out.
        const p = d.clone().multiplyScalar(shape.radius * scale * (1.5 + random() * 0.4)).applyMatrix4(body.matrixWorld);
        this.list.push(this._make(p, r));
        continue;
      }
      o.copy(d).multiplyScalar(shape.radius * 1.2).add(c);
      const t = shape.sdf.raycast(o, d.clone().negate());
      if (t < 0) continue;
      const q = o.clone().addScaledVector(d, -t);
      shape.sdf.grad(q.x, q.y, q.z, n);
      const p = body.localToWorld(q.clone());
      p.addScaledVector(n.transformDirection(body.matrixWorld), this.restHeight(r, film));
      this.list.push(this._make(p, r));
    }
  }

  _make(p, r) {
    return { p, v: new Vector3(), r, stretch: 0, stretchV: 0, axis: new Vector3(0, 1, 0), attached: 1, drop: false, age: 0, wasFree: false };
  }

  // A drop thrown off by a tendril: it flies free, comes back and merges into the coat.
  addDrop(p, v, r) {
    const b = this._make(p.clone(), r);
    b.v.copy(v);
    b.drop = true;
    b.attached = 0;
    b.stretchV = 3;
    this.list.push(b);
    return b;
  }

  restHeight(r, film) {
    return 0.5 * film + 0.3 * r;
  }

  // omega: the body's angular velocity (world); centre: its centre (world).
  step(dt, shape, body, omega, centre, film) {
    const T = TUNING;
    const scale = body.scale.x;
    _inv.copy(body.matrixWorld).invert();
    body.getWorldQuaternion(_rot);
    const list = this.list;
    for (const b of list) {
      // Surface distance and normal from the body's field.
      _q.copy(b.p).applyMatrix4(_inv);
      const dist = bodyDistance(shape.sdf, _q.x, _q.y, _q.z) * scale;
      const lo = shape.sdf.min, size = shape.sdf.size;
      const outside = _q.x < lo[0] || _q.y < lo[1] || _q.z < lo[2] || _q.x > lo[0] + size || _q.y > lo[1] + size || _q.z > lo[2] + size;
      // Beyond the grid the sampled gradient is flat: point away from the centre instead.
      if (outside) _n.copy(b.p).sub(centre).normalize();
      else {
        shape.sdf.grad(_q.x, _q.y, _q.z, _n);
        _n.applyQuaternion(_rot);
      }
      _vs.copy(omega).cross(_d.copy(b.p).sub(centre));
      _rel.copy(b.v).sub(_vs);

      const rest = this.restHeight(b.r, film);
      const reach = rest + T.release * (b.r + film) * 3;
      const hold = 1 - smoothstep(rest + (b.r + film) * T.release, reach, dist);
      b.attached = hold;

      _a.set(0, 0, 0);
      if (hold > 0) {
        const vn = _rel.dot(_n);
        let an = -T.stiffness * (dist - rest) - T.normalDamping * vn;
        an = Math.max(-T.grip * 3, Math.min(T.grip, an));
        _a.addScaledVector(_n, an * hold);
        // Tangential coupling: the coat drags the parcel along with the surface.
        _d.copy(_rel).addScaledVector(_n, -vn);
        const drag = Math.min(T.drag * _d.length(), T.grip) / Math.max(_d.length(), 1e-6);
        _a.addScaledVector(_d, -drag * hold);
      }
      // Cohesion back to the body, and a little damping while free.
      // Thrown drops are pulled home harder and slowed more, so they come back within a few seconds.
      const pull = b.drop ? T.dropCohesion : T.cohesion;
      _a.addScaledVector(_n, -pull * (1 - hold) * Math.min(1, dist / (shape.radius * scale)));
      if (b.drop) _a.addScaledVector(_rel, -T.dropDamping * (1 - hold));
      _a.addScaledVector(_rel, -T.freeDamping * (1 - hold));
      b.a = b.a ?? new Vector3();
      b.a.copy(_a);
    }
    // Overlapping parcels push apart, so the coat stays lumpy instead of piling into one.
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        _d.copy(B.p).sub(A.p);
        const l = _d.length(), min = (A.r + B.r) * 0.9;
        if (l >= min || l < 1e-6) continue;
        _d.multiplyScalar((T.spread * (min - l)) / l);
        A.a.sub(_d);
        B.a.add(_d);
      }
    for (const b of list) {
      b.age += dt;
      if (b.attached < 0.3) b.wasFree = true;
      b.v.addScaledVector(b.a, dt);
      b.p.addScaledVector(b.v, dt);
      // Wobble: a damped spring on the stretch, whose rest stretch follows the acceleration, so a sudden pull rings.
      const accel = b.a.length();
      if (accel > 1e-3) {
        _d.copy(b.a).divideScalar(accel);
        if (_d.dot(b.axis) < 0) _d.negate();
        b.axis.lerp(_d, Math.min(1, accel * dt)).normalize();
      }
      const w = 2 * Math.PI * T.wobbleFrequency;
      const target = Math.min(T.wobbleMax, T.wobbleGain * accel);
      b.stretchV += (-w * w * (b.stretch - target) - 2 * T.wobbleDamping * w * b.stretchV) * dt;
      b.stretch = Math.max(-T.wobbleMax, Math.min(T.wobbleMax, b.stretch + b.stretchV * dt));
    }
  }

  // Pushes the parcels near a world point along dir, and sets them wobbling.
  poke(point, dir, strength, radius) {
    for (const b of this.list) {
      const l = b.p.distanceTo(point);
      const f = Math.exp(-(l * l) / (2 * radius * radius));
      if (f < 0.01) continue;
      b.v.addScaledVector(dir, strength * f);
      b.axis.copy(dir);
      b.stretchV -= 2.5 * f;
    }
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

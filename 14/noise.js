import { Data3DTexture, RedFormat, UnsignedByteType, LinearFilter, RepeatWrapping } from "three";

// Tileable smooth noise in a 3D texture, for the prints: a random lattice of PERIOD³ values, interpolated with a
// quintic at SIZE³ samples; the GPU's trilinear filtering does the rest. One lookup replaces a simplex noise in the
// shader, which matters: every inlined noise adds to the D3D compiler's time.
const PERIOD = 16;
const SIZE = 64;

export function createNoiseTexture() {
  // A fixed generator, so prints look the same on every load.
  let seed = 1234567;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lattice = new Float32Array(PERIOD ** 3);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  const at = (x, y, z) => lattice[(x % PERIOD) + PERIOD * ((y % PERIOD) + PERIOD * (z % PERIOD))];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const data = new Uint8Array(SIZE ** 3);
  const step = PERIOD / SIZE;
  for (let z = 0; z < SIZE; z++)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const px = x * step, py = y * step, pz = z * step;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = fade(px - ix), fy = fade(py - iy), fz = fade(pz - iz);
        const l = (a, b, t) => a + (b - a) * t;
        const v = l(
          l(l(at(ix, iy, iz), at(ix + 1, iy, iz), fx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), fx), fy),
          l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), fx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), fx), fy),
          fz,
        );
        data[x + SIZE * (y + SIZE * z)] = Math.round(v * 255);
      }
  const texture = new Data3DTexture(data, SIZE, SIZE, SIZE);
  texture.format = RedFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

// The texture repeats every PERIOD noise units.
export const NOISE_PERIOD = PERIOD;

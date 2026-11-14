import { fetchWithProgress } from "common";
import { Data3DTexture, RedFormat, FloatType, HalfFloatType, LinearFilter, ClampToEdgeWrapping, DataUtils } from "three";

const base = new URL("./assets/", import.meta.url);
const files = new Map();

function download(key, onProgress) {
  if (!files.has(key)) {
    const promise = fetchWithProgress(new URL(`${key}.sdf`, base), onProgress).then((res) => {
      if (!res.ok) throw new Error(`${key}.sdf: ${res.status}`);
      return res.arrayBuffer();
    });
    files.set(key, promise);
    promise.catch(() => files.delete(key));
  }
  return files.get(key);
}

export function prefetchSdf(key) {
  download(key).catch(() => {});
}

// Resolves to { texture, min, size, step } in the shape's normalised space (day 3's mesh space).
// Float texels where the GPU filters them linearly, half floats otherwise.
export async function loadSdf(renderer, key, onProgress) {
  const packed = await download(key, onProgress);
  const buffer = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  const len = new DataView(buffer).getUint32(0, true);
  const { res, min, size, scale } = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, len)));
  const count = res ** 3;
  const bytes = new Uint8Array(buffer, 4 + ((len + 3) & ~3), count * 2);
  // Undo the second differences (along y between rows, then along x), wrapping in 16 bits as the bake did.
  const dx = new Int16Array(count), q = new Int16Array(count);
  for (let z = 0; z < res; z++)
    for (let y = 0; y < res; y++)
      for (let x = 0; x < res; x++) {
        const i = x + res * (y + res * z);
        dx[i] = (bytes[i] | (bytes[count + i] << 8)) + (y ? dx[i - res] : 0);
        q[i] = dx[i] + (x ? q[i - 1] : 0);
      }
  const float = renderer.extensions.has("OES_texture_float_linear");
  const data = float ? new Float32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) data[i] = float ? q[i] / scale : DataUtils.toHalfFloat(q[i] / scale);
  const texture = new Data3DTexture(data, res, res, res);
  texture.format = RedFormat;
  texture.type = float ? FloatType : HalfFloatType;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, min, size, step: size / res };
}

import {
  WebGLRenderTarget,
  RawShaderMaterial,
  GLSL3,
  Mesh,
  Scene,
  OrthographicCamera,
  BufferGeometry,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  ClampToEdgeWrapping,
  Vector2,
  EquirectangularReflectionMapping,
} from "three";

// The cabin photo, defocused: a separable Gaussian blur into a half-float equirect, wrapping round the seam, redone
// only when the amount changes. Also a lightly blurred copy for the environment lighting, whose lights are lifted. The photo's clipped lights are lifted before blurring, so they spread into glows.

const WIDTH = 1024, HEIGHT = 512;

const vertexShader = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D source;
uniform vec2 direction; // one texel along the blur, in uv
uniform float sigma; // in texels
uniform float lift;
uniform float lodScale; // source texels per target texel, for the mip that matches the tap spacing
uniform float horizontal;
in vec2 vUv;
out vec4 outColor;
float tapLod = 0.0;
vec3 tap(vec2 uv) {
  vec3 c = textureLod(source, uv, tapLod).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * (1.0 + lift * smoothstep(0.55, 0.95, l));
}
void main() {
  // Rows near the poles are stretched by 1 / cos(latitude): the horizontal blur widens to match, so it covers the
  // same angle everywhere and a pole averages its whole ring instead of pinching.
  float s = sigma;
  if (horizontal > 0.5) s = min(sigma / max(cos((vUv.y - 0.5) * 3.14159265), 1e-3), 0.5 / direction.x);
  // Wide kernels space their taps (filtered reads between texels), so a pass stays near 40 taps.
  float spacing = max(1.0, s / 6.0);
  tapLod = max(0.0, log2(spacing * lodScale));
  int radius = int(ceil(s * 3.0 / spacing));
  vec3 sum = vec3(0.0);
  float weight = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float x = float(i) * spacing;
    float w = exp(-0.5 * x * x / (s * s));
    sum += tap(vUv + direction * x) * w;
    weight += w;
  }
  outColor = vec4(sum / weight, 1.0);
}
`;

export class Backdrop {
  constructor(renderer) {
    this.renderer = renderer;
    this.photo = null;
    const target = () =>
      new WebGLRenderTarget(WIDTH, HEIGHT, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false });
    this.temp = target();
    this.target = target();
    for (const t of [this.temp, this.target]) {
      t.texture.wrapS = RepeatWrapping;
      t.texture.wrapT = ClampToEdgeWrapping;
    }
    // The second pass reads the first through its mips.
    this.temp.texture.generateMipmaps = true;
    this.temp.texture.minFilter = LinearMipmapLinearFilter;
    this.texture = this.target.texture;
    this.material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: { source: { value: null }, direction: { value: new Vector2() }, sigma: { value: 1 }, lift: { value: 0 }, lodScale: { value: 1 }, horizontal: { value: 0 } },
      depthTest: false,
      depthWrite: false,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mesh = new Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    this.scene = new Scene().add(mesh);
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.amount = null;
  }

  setPhoto(photo) {
    this.photo = photo;
    const amount = this.amount;
    this.amount = null;
    if (amount !== null) this.setBlur(amount);
  }

  // amount: 0 (sharp) to 5 (very soft); the blur's sigma doubles with each step.
  setBlur(amount, lift = 0) {
    if (amount === this.amount) return;
    this.amount = amount;
    if (!this.photo) return;
    this.blur(Math.max(0.5, 0.0025 * WIDTH * 2 ** amount), lift, this.target);
  }

  // The photo as lighting: barely blurred, its lights lifted further so they read as light sources in the
  // environment's reflections and ambient. An equirect texture for PMREMGenerator.fromEquirectangular().
  lighting(lift = 6) {
    if (!this.envTarget) {
      this.envTarget = this.target.clone();
      this.envTarget.texture.mapping = EquirectangularReflectionMapping;
    }
    this.blur(1, lift, this.envTarget);
    return this.envTarget.texture;
  }

  // Horizontal pass (lifting the lights), then vertical, into `into`.
  blur(sigma, lift, into) {
    const u = this.material.uniforms;
    const previous = this.renderer.getRenderTarget();
    u.sigma.value = sigma;
    u.source.value = this.photo;
    u.direction.value.set(1 / WIDTH, 0);
    u.lift.value = lift;
    u.lodScale.value = this.photo.image.width / WIDTH;
    u.horizontal.value = 1;
    this.renderer.setRenderTarget(this.temp);
    this.renderer.render(this.scene, this.camera);
    u.source.value = this.temp.texture;
    u.direction.value.set(0, 1 / HEIGHT);
    u.lift.value = 0;
    u.lodScale.value = 1;
    u.horizontal.value = 0;
    this.renderer.setRenderTarget(into);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(previous);
  }
}

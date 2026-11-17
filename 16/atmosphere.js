// Air and light: a beam of the key light through the scene, and fine dust hanging in the air.
//
// The air is ray-marched at half resolution (a composite pass over the lit image): along each view ray, up to whatever
// the pixel shows, it gathers key light scattered toward the eye, from a faint haze everywhere plus a brighter shaft (a
// soft cylinder round the key's axis through the colony), shadowed by the pipeline's own shadow map. The colony's real
// shape cuts shadow volumes into the shaft, and looking toward the light through it gives god rays. A depth-aware
// upsample adds it to the full-res image.
// The dust is a few tens of thousands of specks drifting slowly in a box round the colony, drawn additively on top:
// faint everywhere, glinting where the beam (and not the colony's shadow) catches them.
import {
  WebGLRenderTarget,
  HalfFloatType,
  NearestFilter,
  RawShaderMaterial,
  GLSL3,
  BufferGeometry,
  BufferAttribute,
  Float32BufferAttribute,
  Mesh,
  Points,
  Scene,
  OrthographicCamera,
  Vector2,
  Vector3,
  Matrix4,
  Color,
  CustomBlending,
  AddEquation,
  OneFactor,
  NoBlending,
} from "three";
import { globalUniforms } from "modules/pipeline/uniforms.js";

const DUST = 30000;
const DUST_BOX = 4;
// Large out-of-focus motes in a bigger box (reaching past the camera), drawn as soft bokeh discs.
const BOKEH = 1400;
const BOKEH_BOX = 7;

const shadowGLSL = /* glsl */ `
uniform highp sampler2DShadow shadowMapCmp;
uniform mat4 shadowMatrix;
uniform float shadowEnabled;
// 1 lit, 0 in the key light's shadow. Past the map's far plane (downstream of everything) depth clamps to it, so shadow
// volumes run on to infinity; outside the map nothing casts.
float keyLight(vec3 p) {
  if (shadowEnabled < 0.5) return 1.0;
  vec4 sc = shadowMatrix * vec4(p, 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if (c.z < 0.0 || any(lessThan(c.xy, vec2(0.0))) || any(greaterThan(c.xy, vec2(1.0)))) return 1.0;
  return texture(shadowMapCmp, vec3(c.xy, min(c.z, 1.0) - 0.002));
}
`;

// The shaft: wide and soft-edged (gaussian across), brightest toward the light and fading downstream of the colony,
// with faint streaks along it (dust shafts), as in a real beam through a dusty room.
const beamGLSL = /* glsl */ `
uniform vec3 beamCentre;
float beamWeight(vec3 q, vec3 L, float radius) {
  float along = dot(q, L);
  vec3 across = q - along * L;
  float d2 = dot(across, across) / (radius * radius);
  vec3 e1 = normalize(cross(L, abs(L.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(L, e1);
  float u = dot(across, e1), v = dot(across, e2);
  float streaks = 0.75 + 0.25 * sin(u * 3.7 + 1.3) * sin(v * 2.9 + 0.4) + 0.12 * sin(u * 9.1 + v * 4.3);
  // Brighter toward the source (upstream), dimming as it travels on past the colony.
  return exp(-d2 * 1.6) * (0.08 + 0.92 * smoothstep(-3.5, 3.0, along)) * streaks;
}
`;

const marchFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 projectionInverse;
uniform mat4 cameraWorld;
uniform vec3 cameraPos;
uniform vec3 lightDir;
uniform vec3 centre;
uniform float beamRadius;
uniform float beam;
uniform float haze;
uniform int steps;
${shadowGLSL}
${beamGLSL}
in vec2 vUv;
out vec4 outColor;

vec3 worldAt(vec2 uv, float depth) {
  vec4 v = projectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return (cameraWorld * vec4(v.xyz / v.w, 1.0)).xyz;
}

void main() {
  float depth = texture(tDepth, vUv).r;
  vec3 far = worldAt(vUv, min(depth, 0.9999));
  vec3 rd = normalize(far - cameraPos);
  float sceneDist = distance(far, cameraPos);
  // Through the air round the colony: from the camera (or 9 short of the colony) to the surface, or 9 past it.
  float tc = dot(centre - cameraPos, rd);
  float t0 = max(0.0, tc - 9.0);
  float t1 = min(sceneDist, max(tc, 0.0) + 9.0);
  float dt = max(t1 - t0, 0.0) / float(steps);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 lit = vec2(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    vec3 p = cameraPos + rd * (t0 + (float(i) + jitter) * dt);
    vec3 q = p - centre;
    // Haze thins out away from the colony, so the far backdrop stays dark.
    vec2 density = vec2(beam * beamWeight(p - beamCentre, lightDir, beamRadius), haze * exp(-dot(q, q) / 30.0));
    if (density.x + density.y > 0.002) lit += density * keyLight(p);
  }
  lit *= dt;
  // Forward scattering: much brighter looking toward the light (god rays); the thin haze less so, so looking into the
  // light doesn't wash the view.
  float g = 0.75;
  float mu = dot(rd, lightDir);
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / (4.0 * 3.14159);
  outColor = vec4(lit.x * (0.08 + 0.45 * hg) + lit.y * (0.08 + 0.12 * hg), min(sceneDist, 100.0), 0.0, 1.0);
}
`;

// Adds the half-res scatter to the image, weighting the nearest half-res texels by how close their depth is to this
// pixel's, so the colony's silhouette stays sharp.
// God rays: the light's glow on the backdrop, smeared toward the light's place on screen, so every gap in the colony's
// silhouette throws a streak (half res, only while the light is in or near view).
const raysFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec2 sunUv;
uniform float aspect;
in vec2 vUv;
out vec4 outColor;
float source(vec2 uv) {
  if (texture(tDepth, uv).r < 0.9999) return 0.0;
  vec2 d = (uv - sunUv) * vec2(aspect, 1.0);
  return exp(-dot(d, d) * 3.0);
}
void main() {
  const int N = 40;
  vec2 delta = (sunUv - vUv) * 0.85 / float(N);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 uv = vUv + delta * jitter;
  float sum = 0.0, decay = 1.0;
  for (int i = 0; i < N; i++) {
    sum += source(clamp(uv, 0.0, 1.0)) * decay;
    decay *= 0.96;
    uv += delta;
  }
  outColor = vec4(sum / float(N), 0.0, 0.0, 1.0);
}
`;

const upsampleFragment = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tScatter;
uniform mat4 projectionInverse;
uniform mat4 cameraWorld;
uniform vec3 cameraPos;
uniform vec3 lightDir;
uniform vec3 beamColor;
uniform float sun;
uniform sampler2D tRays;
uniform float rays;
in vec2 vUv;
out vec4 outColor;

vec3 worldAt(vec2 uv, float depth) {
  vec4 v = projectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return (cameraWorld * vec4(v.xyz / v.w, 1.0)).xyz;
}

void main() {
  vec4 c = texture(tColor, vUv);
  float depth = texture(tDepth, vUv).r;
  vec3 far = worldAt(vUv, min(depth, 0.9999));
  float d = min(distance(far, cameraPos), 100.0);
  vec2 size = vec2(textureSize(tScatter, 0));
  vec2 st = vUv * size - 0.5;
  vec2 base = floor(vUv * size);
  float sum = 0.0, wsum = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(x, y);
      vec2 r = st - base - o;
      vec2 s = texelFetch(tScatter, ivec2(clamp(base + o, vec2(0.0), size - 1.0)), 0).rg;
      float w = exp(-dot(r, r) * 0.9) * exp(-abs(s.g - d) / (0.02 * d + 0.01));
      sum += s.r * w;
      wsum += w;
    }
  float scatter = wsum > 1e-5 ? sum / wsum : texture(tScatter, vUv).r;
  // The light itself, low in the haze, where the view reaches the backdrop near it.
  vec3 rd = normalize(far - cameraPos);
  float glow = depth >= 0.9999 ? sun * (pow(max(dot(rd, lightDir), 0.0), 80.0) * 1.2 + pow(max(dot(rd, lightDir), 0.0), 8.0) * 0.04) : 0.0;
  outColor = vec4(c.rgb + beamColor * (scatter + glow + rays * texture(tRays, vUv).r), c.a);
}
`;

const dustVertex = /* glsl */ `
precision highp float;
in vec4 seed;
uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform vec3 lightDir;
uniform vec3 centre;
uniform float beamRadius;
uniform float time;
uniform float pixelScale;
uniform float focus;
uniform float box;
// The pipeline's lens, when its depth of field is on: blur radius at infinity in pixels, and the focus distance.
uniform float lensBlur;
uniform float lensFocus;
${shadowGLSL}
${beamGLSL}
out float vGlow;
out float vSoft;
out vec4 vClip;
void main() {
  // Each speck drifts on a slow breeze and bobs a little; the box wraps round the colony.
  vec3 p = seed.xyz + vec3(0.035, 0.012, -0.02) * time;
  p += 0.12 * vec3(sin(time * 0.31 + seed.w * 6.3), sin(time * 0.23 + seed.w * 9.1), sin(time * 0.27 + seed.w * 4.7));
  p = mod(p + box, 2.0 * box) - box + centre;
  float inBeam = beamWeight(p - beamCentre, lightDir, beamRadius);
  float lit = keyLight(p);
  // Glinting: specks catch the light now and then as they turn.
  float glint = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(time * (1.5 + seed.w * 3.0) + seed.w * 40.0), 6.0);
  vGlow = (0.012 + inBeam * lit * glint) * (0.4 + 0.6 * fract(seed.w * 13.7));
  vClip = viewProjection * vec4(p, 1.0);
  gl_Position = vClip;
  float dist = distance(p, cameraPos);
  // Out of focus specks grow into soft discs and dim to keep their light.
  float coc = abs(dist - focus) / dist * 2.0;
  float lensCoc = 2.0 * lensBlur * abs(1.0 - lensFocus / dist);
#ifdef BOKEH
  // Bigger motes, well out of focus: soft discs, dimmer the bigger they spread (not fully energy-kept, so they read).
  float size = (1.5 + 2.0 * fract(seed.w * 7.1)) * pixelScale / dist + coc * pixelScale * 0.09 + lensCoc;
  gl_PointSize = clamp(size, 2.0, 140.0);
  vSoft = 1.0;
  vGlow *= 2.5 / max(1.0, size * 0.25);
#else
  float size = (0.6 + 0.8 * fract(seed.w * 7.1)) * pixelScale / dist + coc * pixelScale * 0.02 + lensCoc;
  gl_PointSize = clamp(size, 1.0, 64.0);
  vSoft = clamp(size / 3.0, 0.0, 1.0);
  vGlow /= max(1.0, size * size / 4.0);
#endif
}
`;

const dustFragment = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform vec3 beamColor;
uniform float dust;
in float vGlow;
in float vSoft;
in vec4 vClip;
out vec4 outColor;
void main() {
  // Hidden behind the colony.
  float scene = texture(tDepth, gl_FragCoord.xy / resolution).r;
  if (gl_FragCoord.z > scene) discard;
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
#ifdef BOKEH
  // A lens's out-of-focus disc: flat, a touch brighter toward a soft rim.
  float r = sqrt(r2);
  float a = (1.0 - smoothstep(0.82, 1.0, r)) * (0.75 + 0.25 * smoothstep(0.4, 0.92, r));
#else
  float a = mix(1.0 - smoothstep(0.3, 1.0, r2), 1.0 - r2, vSoft);
#endif
  outColor = vec4(beamColor * vGlow * a * dust, 0.0);
}
`;

const _sun = new Vector3();
const _forward = new Vector3();
const smoothstep = (a, b, x) => Math.min(1, Math.max(0, (x - a) / (b - a))) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (x - a) / (b - a))));

function createAtmosphere(renderer, { steps = 48 } = {}) {
  const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const half = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter });
  const raysTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  const common = {
    shadowMapCmp: globalUniforms.shadowMapCmp,
    shadowMatrix: globalUniforms.shadowMatrix,
    shadowEnabled: globalUniforms.shadowEnabled,
    lightDir: { value: new Vector3(0, 1, 0) },
    centre: { value: new Vector3() },
    beamRadius: { value: 1.4 },
    beamCentre: { value: new Vector3() },
    beamColor: { value: new Color(1, 0.9, 0.75) },
    cameraPos: { value: new Vector3() },
    tDepth: { value: null },
    projectionInverse: { value: new Matrix4() },
    cameraWorld: { value: new Matrix4() },
  };
  const quadVertex = "in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }";
  const fullScreen = { glslVersion: GLSL3, vertexShader: quadVertex, depthTest: false, depthWrite: false, blending: NoBlending };
  const marchMaterial = new RawShaderMaterial({
    ...fullScreen,
    fragmentShader: marchFragment,
    uniforms: { ...common, beam: { value: 1 }, haze: { value: 1 }, steps: { value: steps } },
  });
  const upsampleMaterial = new RawShaderMaterial({
    ...fullScreen,
    fragmentShader: upsampleFragment,
    uniforms: { ...common, tColor: { value: null }, tScatter: { value: half.texture }, sun: { value: 1 }, tRays: { value: raysTarget.texture }, rays: { value: 0 } },
  });
  const raysMaterial = new RawShaderMaterial({
    ...fullScreen,
    fragmentShader: raysFragment,
    uniforms: { tDepth: common.tDepth, sunUv: { value: new Vector2() }, aspect: { value: 1 } },
  });
  const quadGeometry = new BufferGeometry();
  quadGeometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new Mesh(quadGeometry, marchMaterial);
  quad.frustumCulled = false;
  const quadScene = new Scene();
  quadScene.add(quad);
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const pointsGeometry = (count, box) => {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = (Math.random() * 2 - 1) * box;
      seeds[i * 4 + 1] = (Math.random() * 2 - 1) * box;
      seeds[i * 4 + 2] = (Math.random() * 2 - 1) * box;
      seeds[i * 4 + 3] = Math.random();
    }
    const g = new BufferGeometry();
    g.setAttribute("seed", new BufferAttribute(seeds, 4));
    // three sizes the draw from position.
    g.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  };
  const dustGeometry = pointsGeometry(DUST, DUST_BOX);
  const dustMaterial = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: dustVertex,
    fragmentShader: dustFragment,
    uniforms: {
      ...common,
      viewProjection: { value: new Matrix4() },
      time: { value: 0 },
      pixelScale: { value: 1 },
      focus: { value: 5 },
      resolution: { value: new Float32Array(2) },
      dust: { value: 1 },
      box: { value: DUST_BOX },
      lensBlur: { value: 0 },
      lensFocus: { value: 5 },
    },
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
  const dustPoints = new Points(dustGeometry, dustMaterial);
  dustPoints.frustumCulled = false;
  const bokehMaterial = dustMaterial.clone();
  bokehMaterial.uniforms = { ...dustMaterial.uniforms, box: { value: BOKEH_BOX } };
  bokehMaterial.defines = { BOKEH: "" };
  const bokehPoints = new Points(pointsGeometry(BOKEH, BOKEH_BOX), bokehMaterial);
  bokehPoints.frustumCulled = false;
  const dustScene = new Scene();
  dustScene.add(dustPoints, bokehPoints);

  function drawDust(camera, width, height) {
    if (api.dust <= 0) return;
    const d = dustMaterial.uniforms;
    d.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    d.time.value = api.time;
    // Speck size in pixels at distance 1: a tiny fraction of the view height.
    d.pixelScale.value = (height * 0.004) / Math.tan((camera.fov * Math.PI) / 360);
    d.focus.value = camera.position.distanceTo(api.centre);
    d.resolution.value[0] = width;
    d.resolution.value[1] = height;
    d.dust.value = 2.5 * api.dust;
    d.lensBlur.value = api.dustAfterFocus ? api.lens.aperture * height : 0;
    d.lensFocus.value = api.lens.focus;
    renderer.render(dustScene, quadCamera);
  }
  const copyMaterial = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: "in vec3 position; out vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position, 1.0); }",
    fragmentShader: "precision highp float; uniform sampler2D tSource; in vec2 vUv; out vec4 outColor; void main() { outColor = texture(tSource, vUv); }",
    uniforms: { tSource: { value: null } },
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
  });
  const afterTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });

  const api = {
    beam: 1,
    haze: 1,
    dust: 1,
    time: 0,
    centre: new Vector3(),
    rays: 1.5,
    // With the pipeline's depth of field on, the dust is drawn after it (renderDust, from afterFocus), each speck
    // blurred by the same lens as its own disc, so it isn't blurred twice by whatever lies behind it.
    dustAfterFocus: false,
    lens: { aperture: 0, focus: 5 },
    // Where the shaft's axis passes, from the colony's centre.
    beamOffset: new Vector3(0, 0, 0),
    color: new Color(1, 0.9, 0.75),
    render(hdr, { depthTexture, camera, width, height }) {
      if (api.beam <= 0 && api.haze <= 0 && api.dust <= 0) return hdr;
      if (target.width !== width || target.height !== height) {
        target.setSize(width, height);
        half.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
        raysTarget.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
      }
      // The shaft follows the key light, so its shadow volumes are the colony's real shadow.
      common.lightDir.value.copy(globalUniforms.lightDirection.value).normalize();
      common.centre.value.copy(api.centre);
      common.beamCentre.value.copy(api.centre).add(api.beamOffset);
      common.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
      common.tDepth.value = depthTexture;
      common.beamColor.value.copy(api.color);
      common.projectionInverse.value.copy(camera.projectionMatrixInverse);
      common.cameraWorld.value.copy(camera.matrixWorld);
      const m = marchMaterial.uniforms;
      m.beam.value = 1.1 * api.beam;
      m.haze.value = 0.01 * api.haze;
      upsampleMaterial.uniforms.tColor.value = hdr;
      upsampleMaterial.uniforms.sun.value = api.beam;
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      quad.material = marchMaterial;
      renderer.setRenderTarget(half);
      renderer.render(quadScene, quadCamera);
      // The light's place on screen; the rays fade as it leaves the view or goes behind the camera.
      _sun.copy(common.lightDir.value).multiplyScalar(1000).add(common.cameraPos.value).project(camera);
      camera.getWorldDirection(_forward);
      const facing = _forward.dot(common.lightDir.value);
      const onScreen = Math.max(Math.abs(_sun.x), Math.abs(_sun.y));
      const rays = api.rays * api.beam * smoothstep(0.1, 0.5, facing) * (1 - smoothstep(1.5, 3, onScreen));
      upsampleMaterial.uniforms.rays.value = rays;
      if (rays > 0) {
        raysMaterial.uniforms.sunUv.value.set(_sun.x * 0.5 + 0.5, _sun.y * 0.5 + 0.5);
        raysMaterial.uniforms.aspect.value = width / height;
        quad.material = raysMaterial;
        renderer.setRenderTarget(raysTarget);
        renderer.render(quadScene, quadCamera);
      }
      quad.material = upsampleMaterial;
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCamera);
      if (!api.dustAfterFocus) drawDust(camera, width, height);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      return target.texture;
    },
    renderDust(hdr, { depthTexture, camera, width, height }) {
      if (!api.dustAfterFocus || api.dust <= 0) return hdr;
      if (afterTarget.width !== width || afterTarget.height !== height) afterTarget.setSize(width, height);
      common.tDepth.value = depthTexture;
      common.cameraPos.value.setFromMatrixPosition(camera.matrixWorld);
      const prevTarget = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(afterTarget);
      copyMaterial.uniforms.tSource.value = hdr;
      quad.material = copyMaterial;
      renderer.render(quadScene, quadCamera);
      drawDust(camera, width, height);
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
      return afterTarget.texture;
    },
  };
  return api;
}

export { createAtmosphere };

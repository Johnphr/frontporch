// Geometry helpers for the 3D hosts. Everything is laid out in the flat portraits' own coordinates
// (src/art/hosts.jsx, a 200x200 viewBox) so each bust lines up with its SVG: sx/sy map an SVG
// point to scene units (40 SVG px = 1 unit, origin at the viewBox centre, y up). A "surface" is a
// function z(x, y) for the front of a body part; decals and strokes are SVG paths laid onto one.
import * as THREE from 'three'
import { TessellateModifier } from 'three/examples/jsm/modifiers/TessellateModifier.js'

export const U = 1 / 40
export const sx = (x) => (x - 100) * U
export const sy = (y) => (100 - y) * U

/** Front of an ellipsoid (centre and radii in scene units) as z(x, y); 0 outside its outline. */
export function ellipsoid([cx, cy, cz], [a, b, c]) {
  return (x, y) => {
    const u = (x - cx) / a
    const v = (y - cy) / b
    return cz + c * Math.sqrt(Math.max(0, 1 - u * u - v * v))
  }
}

/** Front of a lathe (profile of (radius, y) points, squashed in depth by zScale) as z(x, y). */
export function latheSurface(profile, zScale) {
  const bottom = Math.min(...profile.map((p) => p.y))
  const pts = profile.filter((p) => p.y > bottom + 1e-3).sort((a, b) => a.y - b.y)
  const radiusAt = (y) => {
    if (y <= pts[0].y) return pts[0].x
    for (let i = 1; i < pts.length; i++) {
      if (y <= pts[i].y) {
        const t = (y - pts[i - 1].y) / (pts[i].y - pts[i - 1].y)
        return pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t
      }
    }
    return 0
  }
  return (x, y) => zScale * Math.sqrt(Math.max(0, radiusAt(y) ** 2 - x * x))
}

const E = 0.004

/** Outward normal of a surface at (x, y), from its slope. */
export function normalAt(z, x, y) {
  const dx = Math.max(-40, Math.min(40, (z(x + E, y) - z(x - E, y)) / (2 * E)))
  const dy = Math.max(-40, Math.min(40, (z(x, y + E) - z(x, y - E)) / (2 * E)))
  return new THREE.Vector3(-dx, -dy, 1).normalize()
}

/** Point on a surface at (x, y), raised `lift` along its normal. */
export function onSurface(z, x, y, lift = 0) {
  return new THREE.Vector3(x, y, z(x, y)).addScaledVector(normalAt(z, x, y), lift)
}

/** Rotation that turns +z to face along `n` (for things that sit flat on a surface). */
export function facing(n) {
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
}

/** Parse an SVG path (M, L, Q, Z; absolute or relative) into subpaths of SVG-unit segments. */
function parsePath(d) {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+/g)
  const subpaths = []
  let i = 0
  let cmd = 'M'
  let x = 0
  let y = 0
  let cur = null
  const num = () => parseFloat(tokens[i++])
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'Z':
        cur.closed = true
        ;[x, y] = cur.start
        break
      case 'M':
        x = ox + num()
        y = oy + num()
        cur = { start: [x, y], segs: [], closed: false }
        subpaths.push(cur)
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        x = ox + num()
        y = oy + num()
        cur.segs.push({ to: [x, y] })
        break
      case 'Q': {
        const c = [ox + num(), oy + num()]
        x = ox + num()
        y = oy + num()
        cur.segs.push({ c, to: [x, y] })
        break
      }
      default:
        throw new Error(`Unsupported path command ${cmd}`)
    }
  }
  return subpaths
}

/** SVG path -> THREE.Shapes in scene units. */
export function pathShapes(d) {
  return parsePath(d).map(({ start, segs }) => {
    const shape = new THREE.Shape()
    shape.moveTo(sx(start[0]), sy(start[1]))
    for (const s of segs) {
      if (s.c) shape.quadraticCurveTo(sx(s.c[0]), sy(s.c[1]), sx(s.to[0]), sy(s.to[1]))
      else shape.lineTo(sx(s.to[0]), sy(s.to[1]))
    }
    return shape
  })
}

/** Evenly spaced points along an (open) SVG path, in scene units. */
export function pathPoints(d, perSegment = 10) {
  const pts = []
  for (const { start, segs } of parsePath(d)) {
    let p = start
    pts.push(new THREE.Vector2(sx(p[0]), sy(p[1])))
    for (const s of segs) {
      for (let k = 1; k <= perSegment; k++) {
        const t = k / perSegment
        const c = s.c || [(p[0] + s.to[0]) / 2, (p[1] + s.to[1]) / 2]
        const px = (1 - t) ** 2 * p[0] + 2 * (1 - t) * t * c[0] + t * t * s.to[0]
        const py = (1 - t) ** 2 * p[1] + 2 * (1 - t) * t * c[1] + t * t * s.to[1]
        pts.push(new THREE.Vector2(sx(px), sy(py)))
      }
      p = s.to
    }
  }
  return pts
}

/** A filled SVG path laid onto a surface (tessellated so it hugs the curve). */
export function decalGeometry(d, z, lift) {
  const flat = new THREE.ShapeGeometry(pathShapes(d), 12)
  const geo = new TessellateModifier(0.06, 8).modify(flat)
  flat.dispose()
  const pos = geo.attributes.position
  const nor = geo.attributes.normal
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const y = pos.getY(i)
    const n = normalAt(z, x, y)
    const p = new THREE.Vector3(x, y, z(x, y)).addScaledVector(n, lift)
    pos.setXYZ(i, p.x, p.y, p.z)
    nor.setXYZ(i, n.x, n.y, n.z)
  }
  return geo
}

/** A stroked SVG path laid onto a surface as a round tube. */
export function strokeGeometry(d, z, lift, radius) {
  const pts = pathPoints(d).map((p) => onSurface(z, p.x, p.y, lift))
  const curve = new THREE.CatmullRomCurve3(pts)
  return { geo: new THREE.TubeGeometry(curve, pts.length * 2, radius, 8, false), ends: [pts[0], pts.at(-1)] }
}

/** A filled SVG path pushed back into a soft slab (Diana's long hair). */
export function slabGeometry(d, depth, bevel) {
  return new THREE.ExtrudeGeometry(pathShapes(d), {
    depth,
    curveSegments: 16,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 5,
  })
}

const cache = new Map()

/** Build a geometry once per key (busts swap often; this keeps GPU buffers from piling up). */
export function cached(key, build) {
  if (!cache.has(key)) cache.set(key, build())
  return cache.get(key)
}

const mats = new Map()

/** Shared matte material per colour. */
export function mat(color, { rough = 0.82, metal = 0 } = {}) {
  const key = `${color}|${rough}|${metal}`
  if (!mats.has(key)) {
    mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, side: THREE.DoubleSide }))
  }
  return mats.get(key)
}

/** Blend two colours (like an SVG fill drawn at partial opacity over another). */
export function mix(over, under, opacity) {
  return `#${new THREE.Color(under).lerp(new THREE.Color(over), opacity).getHexString()}`
}

// The 3D host canvas (lazy-loaded by HostStage): soft studio lights, a faint contact shadow, and
// the bust for host `id`. Transparent background; the panel behind it supplies the colour.
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import Daniel from './Daniel'
import Diana from './Diana'
import Oscar from './Oscar'
import Victoria from './Victoria'

const LOOKS = { daniel: Daniel, oscar: Oscar, victoria: Victoria, diana: Diana }

// Soft round shadow under the base (a radial gradient, no shadow maps).
const shadowTexture = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(58,42,46,0.55)')
  grad.addColorStop(1, 'rgba(58,42,46,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
})()

function GroundShadow() {
  return (
    <mesh position={[0, -2.57, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[4.6, 1.9, 1]}>
      <planeGeometry />
      <meshBasicMaterial map={shadowTexture} transparent depthWrite={false} opacity={0.55} />
    </mesh>
  )
}

export default function Scene({ id, still }) {
  const Look = LOOKS[id] || Daniel
  return (
    <Canvas
      flat
      dpr={[1, 2]}
      frameloop={still ? 'demand' : 'always'}
      camera={{ position: [0, 0.7, 12], fov: 26 }}
      gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      onCreated={({ camera }) => camera.lookAt(0, -0.35, 0)}
    >
      <ambientLight intensity={0.9} />
      <hemisphereLight args={['#ffffff', '#d9cfc9', 0.9]} />
      <directionalLight position={[-3, 4, 6]} intensity={1.6} />
      <directionalLight position={[4, 1.5, 3]} intensity={0.45} />
      <Look />
      <GroundShadow />
    </Canvas>
  )
}

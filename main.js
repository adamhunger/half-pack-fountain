import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.webgpu.js';
const {
  Fn, If, uniform, float, vec2, vec3, hash, mix, smoothstep, shapeCircle,
  instancedArray, instanceIndex, packHalf2x16, unpackHalf2x16
} = THREE.TSL;
window.__booted = true;

const $ = ( id ) => document.getElementById( id );
const stage = $( 'stage' );

const state = { mode: 'packed', forceWebGL: false, count: 200000, inspect: 0 };

// Shared uniforms
const dt = uniform( 0.016 );
const gravity = uniform( 9.8 );
const seed = uniform( 0 );
const pointer = uniform( new THREE.Vector2( 99, 99 ) );
const push = uniform( 0 );
const probeIndex = uniform( 0, 'uint' );

const HALF_H = 5.6;
let renderer, camera, scene, sim, generation = 0;

// ---- simulation -----------------------------------------------------------

function spawnVelocity( s ) {
  const a = hash( instanceIndex.toFloat().mul( 1.37 ).add( s ) ).sub( 0.5 ).mul( 0.7 );
  const sp = hash( instanceIndex.toFloat().mul( 2.11 ).add( s ).add( 17.0 ) ).mul( 3.0 ).add( 8.0 );
  return vec2( a.sin(), a.cos() ).mul( sp );
}

function buildSim( count ) {
  const positions = instancedArray( count, 'vec3' );
  const velPacked = instancedArray( count, 'uint' );
  const velF32 = instancedArray( count, 'vec2' );

  const readPacked = () => unpackHalf2x16( velPacked.element( instanceIndex ) );
  const readF32 = () => velF32.element( instanceIndex );

  const init = Fn( () => {
    const v = spawnVelocity( float( 3.0 ) );
    // stagger start heights so the fountain doesn't open as one burst
    const t = hash( instanceIndex.toFloat().mul( 0.731 ) ).mul( 1.4 );
    const p = vec2( 0, -4.6 ).add( v.mul( t ) ).add( vec2( 0, gravity.mul( t ).mul( t ).mul( -0.5 ) ) );
    const vNow = v.sub( vec2( 0, gravity.mul( t ) ) );
    positions.element( instanceIndex ).assign( vec3( p, 0 ) );
    velPacked.element( instanceIndex ).assign( packHalf2x16( vNow ) );
    velF32.element( instanceIndex ).assign( vNow );
  } )().compute( count );

  const makeUpdate = ( read, write ) => Fn( () => {
    const pos = positions.element( instanceIndex );
    const vel = read().toVar();

    vel.assign( vel.add( vec2( 0, gravity.negate().mul( dt ) ) ) );

    const d = pos.xy.sub( pointer );
    const r2 = d.dot( d ).add( 0.08 );
    vel.assign( vel.add( d.div( r2 ).mul( push.mul( dt ) ) ) );
    vel.assign( vel.mul( float( 1 ).sub( dt.mul( 0.25 ) ) ) );

    const next = pos.xy.add( vel.mul( dt ) );
    pos.assign( vec3( next, 0 ) );

    If( next.y.lessThan( -HALF_H - 0.3 ).or( next.x.abs().greaterThan( 12 ) ), () => {
      pos.assign( vec3( hash( instanceIndex.toFloat().add( seed ) ).sub( 0.5 ).mul( 0.25 ), -4.6, 0 ) );
      vel.assign( spawnVelocity( seed ) );
    } );

    write( vel );
  } )().compute( count );

  const updatePacked = makeUpdate( readPacked, ( v ) => velPacked.element( instanceIndex ).assign( packHalf2x16( v ) ) );
  const updateF32 = makeUpdate( readF32, ( v ) => velF32.element( instanceIndex ).assign( v ) );

  const makeMaterial = ( read ) => {
    const m = new THREE.SpriteNodeMaterial();
    const speed = read().length();
    m.positionNode = positions.toAttribute();
    m.colorNode = mix( vec3( 0.25, 0.45, 1.0 ), vec3( 1.0, 0.62, 0.2 ), smoothstep( 3.0, 10.5, speed ) );
    m.opacityNode = shapeCircle().mul( 0.5 * Math.min( 1, Math.sqrt( 60000 / count ) ) );
    m.scaleNode = float( count > 400000 ? 0.035 : 0.05 );
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    return m;
  };

  // Readback copies one particle into a tiny buffer, so the CPU never pulls the whole array.
  const probePacked = instancedArray( 1, 'uint' );
  const probeF32 = instancedArray( 1, 'vec2' );
  const probe = Fn( () => {
    probePacked.element( 0 ).assign( velPacked.element( probeIndex ) );
    probeF32.element( 0 ).assign( velF32.element( probeIndex ) );
  } )().compute( 1 );

  const sprite = new THREE.Sprite( makeMaterial( readPacked ) );
  sprite.count = count;
  sprite.frustumCulled = false;

  return {
    count, init, updatePacked, updateF32, sprite, probe, probePacked, probeF32,
    materials: { packed: sprite.material, f32: makeMaterial( readF32 ) },
    // keep both velocity buffers in step when switching modes
    syncToF32: Fn( () => { velF32.element( instanceIndex ).assign( readPacked() ); } )().compute( count ),
    syncToPacked: Fn( () => { velPacked.element( instanceIndex ).assign( packHalf2x16( readF32() ) ); } )().compute( count ),
  };
}

// ---- renderer lifecycle ---------------------------------------------------

async function start() {
  const gen = ++ generation;
  if ( renderer ) {
    renderer.setAnimationLoop( null );
    renderer.domElement.remove();
    renderer.dispose();
    renderer = null;
  }
  stage.querySelector( '.fail' )?.remove();
  $( 'hudBackend' ).textContent = 'starting…';

  try {
    const r = new THREE.WebGPURenderer( { antialias: false, alpha: true, forceWebGL: state.forceWebGL } );
    r.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
    r.setClearColor( 0x000000, 0 );
    await r.init();
    if ( gen !== generation ) { r.dispose(); return; }
    renderer = r;
  } catch ( err ) {
    console.error( err );
    showFail( 'This browser could not start WebGPU or WebGL 2. (' + ( err?.message || err ) + ')' );
    return;
  }

  stage.prepend( renderer.domElement );
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera( -1, 1, HALF_H, -HALF_H, 0.1, 10 );
  camera.position.z = 5;
  resize();

  const isGPU = renderer.backend.isWebGPUBackend === true;
  let f16 = false;
  try { f16 = isGPU && renderer.hasFeature( 'shader-f16' ); } catch {}
  $( 'hudBackend' ).textContent = isGPU ? 'WebGPU backend' : 'WebGL 2 backend';
  $( 'dBackend' ).textContent = isGPU ? 'WebGPU' : 'WebGL 2 (fallback)';
  $( 'dF16' ).innerHTML = isGPU
    ? ( f16 ? '<span class="pill ok">Available</span>' : '<span class="pill warn">Missing</span>' )
    : '<span class="pill muted">n/a on WebGL</span>';

  buildScene();
  renderer.setAnimationLoop( frame );
}

function buildScene() {
  if ( sim ) {
    scene.remove( sim.sprite );
    sim.materials.packed.dispose();
    sim.materials.f32.dispose();
  }
  sim = buildSim( state.count );
  sim.sprite.material = sim.materials[ state.mode ];
  scene.add( sim.sprite );
  renderer.compute( sim.init );
  state.inspect = Math.min( state.inspect, state.count - 1 );
  updateMemory();
}

function showFail( msg ) {
  const d = document.createElement( 'div' );
  d.className = 'fail';
  d.textContent = msg;
  stage.appendChild( d );
  $( 'hudBackend' ).textContent = 'no GPU backend';
}

function resize() {
  if ( ! renderer ) return;
  const { width, height } = stage.getBoundingClientRect();
  renderer.setSize( width, height, false );
  const aspect = width / Math.max( height, 1 );
  camera.left = -HALF_H * aspect; camera.right = HALF_H * aspect;
  camera.updateProjectionMatrix();
}
new ResizeObserver( resize ).observe( stage );

// ---- frame loop -----------------------------------------------------------

let last = performance.now(), fpsAcc = 0, fpsN = 0, fpsT = 0, readPending = false, readT = 0;

function frame() {
  const now = performance.now();
  const real = ( now - last ) / 1000;
  const step = Math.min( real, 1 / 30 );
  last = now;
  dt.value = step;
  seed.value = ( seed.value + 0.6180339 ) % 1000;
  push.value += ( ( pointerActive ? 22 : 0 ) - push.value ) * 0.2;

  renderer.compute( state.mode === 'packed' ? sim.updatePacked : sim.updateF32 );
  renderer.render( scene, camera );

  fpsAcc += real; fpsN ++;
  if ( now - fpsT > 500 ) {
    $( 'hudFps' ).textContent = ( fpsN / Math.max( fpsAcc, 1e-6 ) ).toFixed( 0 ) + ' fps · ' + state.count.toLocaleString() + ' particles';
    fpsAcc = 0; fpsN = 0; fpsT = now;
  }
  if ( ! readPending && now - readT > 300 ) { readT = now; readBack(); }
}

// ---- GPU readback and bit display ----------------------------------------

async function readBack() {
  readPending = true;
  const gen = generation, mySim = sim, mode = state.mode, idx = state.inspect;
  try {
    probeIndex.value = idx;
    renderer.compute( mySim.probe );
    if ( mode === 'packed' ) {
      const buf = await renderer.getArrayBufferAsync( mySim.probePacked.value );
      if ( gen !== generation || mySim !== sim ) return;
      renderBits( new Uint32Array( buf )[ 0 ], idx );
    } else {
      const buf = await renderer.getArrayBufferAsync( mySim.probeF32.value );
      if ( gen !== generation || mySim !== sim ) return;
      const f = new Float32Array( buf );
      renderF32( f[ 0 ], f[ 1 ], idx );
    }
  } catch ( err ) {
    $( 'bits' ).innerHTML = '<span class="note">Readback is not available on this backend.</span>';
  } finally {
    readPending = false;
  }
}

function halfToFloat( h ) {
  const s = ( h & 0x8000 ) ? -1 : 1, e = ( h >> 10 ) & 0x1f, m = h & 0x3ff;
  if ( e === 0 ) return s * Math.pow( 2, -14 ) * ( m / 1024 );
  if ( e === 31 ) return m ? NaN : s * Infinity;
  return s * Math.pow( 2, e - 15 ) * ( 1 + m / 1024 );
}
function halfStep( h ) {
  const e = ( h >> 10 ) & 0x1f;
  return Math.pow( 2, Math.max( e, 1 ) - 25 );
}
function bitSpans( h ) {
  const b = h.toString( 2 ).padStart( 16, '0' );
  return `<span class="b-s">${ b[ 0 ] }</span><span class="gap"></span><span class="b-e">${ b.slice( 1, 6 ) }</span><span class="gap"></span><span class="b-m">${ b.slice( 6 ) }</span>`;
}
const fmt = ( v ) => ( v >= 0 ? '+' : '' ) + v.toFixed( 4 );

function renderBits( u, idx ) {
  const lo = u & 0xffff, hi = ( u >>> 16 ) & 0xffff;
  $( 'pIdx' ).textContent = '#' + idx.toLocaleString();
  $( 'bits' ).innerHTML = `
    <div><span class="note">u32</span> 0x${ ( u >>> 0 ).toString( 16 ).padStart( 8, '0' ).toUpperCase() }</div>
    <div class="word" title="high 16 bits = .y">${ bitSpans( hi ) }</div>
    <div class="word" title="low 16 bits = .x">${ bitSpans( lo ) }</div>
    <dl class="half">
      <dt>.y (high bits)</dt><dd>${ fmt( halfToFloat( hi ) ) } <span class="note">± ${ halfStep( hi ).toPrecision( 2 ) }</span></dd>
      <dt>.x (low bits)</dt><dd>${ fmt( halfToFloat( lo ) ) } <span class="note">± ${ halfStep( lo ).toPrecision( 2 ) }</span></dd>
    </dl>
    <p class="note">± is the gap between neighbouring halves at this value. Each repack rounds by at most half of it.</p>`;
}

function renderF32( x, y, idx ) {
  $( 'pIdx' ).textContent = '#' + idx.toLocaleString();
  $( 'bits' ).innerHTML = `
    <div><span class="note">vec2&lt;f32&gt;, 8 bytes, no packing</span></div>
    <dl class="half">
      <dt>.x</dt><dd>${ fmt( x ) }</dd>
      <dt>.y</dt><dd>${ fmt( y ) }</dd>
    </dl>
    <p class="note">Switch to packed halves to see the 16-bit layout.</p>`;
}

function updateMemory() {
  const kb = ( b ) => b >= 1048576 ? ( b / 1048576 ).toFixed( 2 ) + ' MB' : ( b / 1024 ).toFixed( 0 ) + ' KB';
  $( 'memPacked' ).textContent = kb( state.count * 4 );
  $( 'memF32' ).textContent = kb( state.count * 8 );
}

// ---- input ----------------------------------------------------------------

let pointerActive = false;
function toWorld( e ) {
  const r = stage.getBoundingClientRect();
  const nx = ( e.clientX - r.left ) / r.width * 2 - 1;
  const ny = -( ( e.clientY - r.top ) / r.height * 2 - 1 );
  pointer.value.set( nx * HALF_H * ( r.width / r.height ), ny * HALF_H );
}
stage.addEventListener( 'pointermove', ( e ) => { pointerActive = true; toWorld( e ); } );
stage.addEventListener( 'pointerdown', ( e ) => { pointerActive = true; toWorld( e ); } );
stage.addEventListener( 'pointerleave', () => { pointerActive = false; } );
stage.addEventListener( 'pointerup', ( e ) => { if ( e.pointerType !== 'mouse' ) pointerActive = false; } );

function setPressed( a, b, aOn ) { a.setAttribute( 'aria-pressed', aOn ); b.setAttribute( 'aria-pressed', ! aOn ); }

function setMode( mode ) {
  if ( mode === state.mode || ! sim ) return;
  renderer.compute( mode === 'f32' ? sim.syncToF32 : sim.syncToPacked );
  state.mode = mode;
  sim.sprite.material = sim.materials[ mode ];
  setPressed( $( 'modePacked' ), $( 'modeF32' ), mode === 'packed' );
}
$( 'modePacked' ).onclick = () => setMode( 'packed' );
$( 'modeF32' ).onclick = () => setMode( 'f32' );

$( 'beAuto' ).onclick = () => { if ( ! state.forceWebGL ) return; state.forceWebGL = false; setPressed( $( 'beAuto' ), $( 'beGL' ), true ); sim = null; start(); };
$( 'beGL' ).onclick = () => { if ( state.forceWebGL ) return; state.forceWebGL = true; setPressed( $( 'beAuto' ), $( 'beGL' ), false ); sim = null; start(); };

$( 'count' ).onchange = ( e ) => { state.count = +e.target.value; if ( renderer ) buildScene(); };
$( 'nextP' ).onclick = () => { state.inspect = Math.floor( Math.random() * state.count ); readT = 0; };

if ( Math.min( screen.width, screen.height ) < 600 ) { state.count = 50000; $( 'count' ).value = '50000'; }
updateMemory();
start();

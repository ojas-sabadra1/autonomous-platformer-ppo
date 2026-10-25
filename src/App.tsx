/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Download,
  Upload,
  Trash2,
  Volume2,
  VolumeX,
  Activity,
  Award,
  Zap,
  HelpCircle,
  BarChart3,
  Brain,
  Sliders,
  CheckCircle2,
  Layers,
  Sparkles,
  Compass,
  Cpu,
  User,
  ShieldCheck,
  TrendingUp
} from 'lucide-react';

// ===========================================================================
// CONSTANTS & 4-STAGE CURRICULUM DEFINITION
// ===========================================================================
const TILE = 28;
const MAP_ROWS = 17;
const SECTOR_COLS = 34;
const NUM_ACTIONS = 6;
const NUM_FEATURES = 16;
const RL_STORAGE_KEY = 'shipius_mppi_ppo_hybrid_v6';

// Forward actions
const ACTION_DEFS = [
  { id: 0, name: 'Cruise +R', desc: 'Forward Advance' },
  { id: 1, name: 'Sprint +R', desc: 'Full Speed Forward' },
  { id: 2, name: 'Hop +R', desc: 'Low Obstacle Hop' },
  { id: 3, name: 'Power Leap +R', desc: 'Full Forward Gap Clearance' },
  { id: 4, name: 'Climb +R', desc: 'Ladder Ascend & Forward' },
  { id: 5, name: 'Blast +R', desc: 'Spell Strike while Advancing' },
];

const CURRICULUM_STAGES = [
  {
    id: 1,
    name: 'Lava Pits & Gap Clearance',
    shortName: 'Lava Pits',
    range: '0 – 1,000m',
    color: '#ff6622',
    accentBg: 'rgba(255, 102, 34, 0.15)',
    border: '#ff6622',
    desc: 'Learns forward sprint and takeoff timing over bubbling lava pits.',
  },
  {
    id: 2,
    name: 'Floor Spikes & Precision Strides',
    shortName: 'Floor Spikes',
    range: '1,000 – 2,000m',
    color: '#ff5263',
    accentBg: 'rgba(255, 82, 99, 0.15)',
    border: '#ff5263',
    desc: 'Timing bounding strides over razor floor spike clusters.',
  },
  {
    id: 3,
    name: 'Ladders & Elevated Platforms',
    shortName: 'Ladders & Platforms',
    range: '2,000 – 3,000m',
    color: '#4eed84',
    accentBg: 'rgba(78, 237, 132, 0.15)',
    border: '#4eed84',
    desc: 'Climbing vertical ladders, platform hopping, and loot chest collection.',
  },
  {
    id: 4,
    name: 'Wraith Combat & Combined Mastery',
    shortName: 'Combat & Combined',
    range: '3,000m+',
    color: '#00ffea',
    accentBg: 'rgba(0, 255, 234, 0.15)',
    border: '#00ffea',
    desc: 'Full multi-hazard terrain mastery with active magical defense against wraiths.',
  },
];

// ===========================================================================
// MPPI (MODEL PREDICTIVE PATH INTEGRAL) TRAJECTORY PREDICTOR
// ===========================================================================
interface ProjectedTrajectory {
  points: { x: number; y: number }[];
  isSafe: boolean;
  score: number;
  actionId: number;
  lethalHazard: string | null;
}

interface SimulatedPlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  speed: number;
  jumpPower: number;
  onGround: boolean;
  onLadder: boolean;
  coyote: number;
  jumpBuf: number;
  w: number;
  h: number;
}

// Lightweight forward simulator for MPPI
function runKinematicRollout(
  initState: SimulatedPlayerState,
  actionSequence: number[],
  grid: string[][],
  worldCols: number,
  ghosts: { x: number; y: number; hp: number }[]
): ProjectedTrajectory {
  const pts: { x: number; y: number }[] = [{ x: initState.x, y: initState.y }];
  const s: SimulatedPlayerState = { ...initState };
  let isSafe = true;
  let lethalHazard: string | null = null;
  let score = 0;

  const horizon = actionSequence.length;

  for (let t = 0; t < horizon; t++) {
    const act = actionSequence[t];
    let inLeft = false;
    let inRight = false;
    let inUp = false;
    let inDown = false;
    let inJump = false;

    switch (act) {
      case 0:
        inRight = true;
        break;
      case 1:
        inRight = true;
        break;
      case 2:
        inRight = true;
        inJump = true;
        break;
      case 3:
        inRight = true;
        inJump = true;
        break;
      case 4:
        inRight = true;
        inUp = true;
        break;
      case 5:
        inRight = true;
        break;
    }

    const centerC = Math.floor((s.x + s.w / 2) / TILE);
    const bodyR = Math.floor((s.y + s.h / 2) / TILE);
    const feetR = Math.floor((s.y + s.h - 1) / TILE);
    const belowFeetR = Math.floor((s.y + s.h + 4) / TILE);

    const getTile = (c: number, r: number) => {
      if (r < 0 || r >= MAP_ROWS || c < 0) return '1';
      if (c >= worldCols || !grid[r]) return '.';
      return grid[r][c] || '.';
    };

    const isSolid = (c: number, r: number) => {
      const tile = getTile(c, r);
      return tile === '1' || tile === '2';
    };

    const isTopOfLadder = (c: number, r: number) => {
      return getTile(c, r) === '3' && getTile(c, r - 1) !== '3';
    };

    const inLad = getTile(centerC, bodyR) === '3' || getTile(centerC, feetR) === '3';
    const onLadTop = isTopOfLadder(centerC, belowFeetR);

    if (inLad && (inUp || inDown)) {
      s.onLadder = true;
      s.x += (centerC * TILE + (TILE - s.w) / 2 - s.x) * 0.25;
    } else if (onLadTop && inDown) {
      s.onLadder = true;
      s.onGround = false;
      s.y += 5;
    }
    if (!inLad && !onLadTop) s.onLadder = false;

    let mx = 0;
    if (inLeft) mx -= 1;
    if (inRight) mx += 1;
    s.vx = mx * s.speed;

    if (s.onGround) s.coyote = 8;
    else if (s.coyote > 0) s.coyote--;

    if (inJump && !s.onLadder) s.jumpBuf = 6;
    else if (s.jumpBuf > 0) s.jumpBuf--;

    if (s.onLadder) {
      s.vy = 0;
      if (inUp) s.vy = -s.speed * 0.95;
      if (inDown) s.vy = s.speed * 0.95;
      const topCheckR = Math.floor((s.y + s.h - 2) / TILE);
      if (inUp && getTile(centerC, topCheckR) !== '3' && isTopOfLadder(centerC, topCheckR + 1)) {
        s.y = (topCheckR + 1) * TILE - s.h;
        s.vy = 0;
        s.onLadder = false;
        s.onGround = true;
      }
    } else {
      s.vy += 0.36;
      if (s.vy > 8.8) s.vy = 8.8;
      if (s.jumpBuf > 0 && s.coyote > 0) {
        s.vy = -s.jumpPower;
        s.onGround = false;
        s.coyote = 0;
        s.jumpBuf = 0;
      }
    }

    s.x += s.vx;
    let lC = Math.floor(s.x / TILE);
    let rC = Math.floor((s.x + s.w - 0.01) / TILE);
    let tR = Math.floor((s.y + 2) / TILE);
    let bR = Math.floor((s.y + s.h - 2) / TILE);

    if (s.vx > 0 && (isSolid(rC, tR) || isSolid(rC, bR))) {
      s.x = rC * TILE - s.w - 0.05;
      s.vx = 0;
    } else if (s.vx < 0 && (isSolid(lC, tR) || isSolid(lC, bR))) {
      s.x = (lC + 1) * TILE + 0.05;
      s.vx = 0;
    }

    const prevBottom = s.y + s.h;
    s.y += s.vy;
    lC = Math.floor((s.x + 2) / TILE);
    rC = Math.floor((s.x + s.w - 2) / TILE);
    tR = Math.floor(s.y / TILE);
    bR = Math.floor((s.y + s.h) / TILE);

    s.onGround = false;
    if (s.vy >= 0 && !s.onLadder) {
      const solidFl = isSolid(lC, bR) || isSolid(rC, bR);
      const ladFl = !inDown && (isTopOfLadder(lC, bR) || isTopOfLadder(rC, bR)) && prevBottom <= bR * TILE + 6;
      if (solidFl || ladFl) {
        s.y = bR * TILE - s.h;
        s.vy = 0;
        s.onGround = true;
      }
    } else if (s.vy < 0 && !s.onLadder) {
      if (isSolid(lC, tR) || isSolid(rC, tR)) {
        s.y = (tR + 1) * TILE;
        s.vy = 0;
      }
    }

    pts.push({ x: s.x, y: s.y });

    // Check lethal hazards
    const fC1 = Math.floor((s.x + 4) / TILE);
    const fC2 = Math.floor((s.x + s.w - 4) / TILE);
    const fR = Math.floor((s.y + s.h - 2) / TILE);
    const hz1 = getTile(fC1, fR);
    const hz2 = getTile(fC2, fR);

    if (hz1 === 'L' || hz2 === 'L') {
      isSafe = false;
      lethalHazard = 'Lava Pit';
      score -= 50000;
      break;
    }
    if (hz1 === '4' || hz2 === '4') {
      isSafe = false;
      lethalHazard = 'Floor Spikes';
      score -= 40000;
      break;
    }

    // Check ghost collisions
    for (const gh of ghosts) {
      if (gh.hp <= 0) continue;
      const d = Math.hypot(s.x + 9 - (gh.x + 14), s.y + 12 - (gh.y + 14));
      if (d < 18) {
        isSafe = false;
        lethalHazard = 'Wraith Contact';
        score -= 30000;
        break;
      }
    }

    if (!isSafe) break;

    // Reward forward progress
    score += s.vx * 15;
    if (s.onGround) score += 5;
    if (s.onLadder) score += 10;
  }

  // End distance gain
  score += (s.x - initState.x) * 20;

  return {
    points: pts,
    isSafe,
    score,
    actionId: actionSequence[0],
    lethalHazard,
  };
}

// Generate candidate MPPI action sequences (defaults to 36 steps - 2x lookahead)
function generateMPPICandidates(horizon = 36): number[][] {
  const candidates: number[][] = [];

  // Profile 0: Pure Sprint Forward (Continuous high-speed stride)
  candidates.push(new Array(horizon).fill(1));

  // Profile 1: Forward Cruise (Steady advance)
  candidates.push(new Array(horizon).fill(0));

  // Profile 2: Immediate Power Leap Forward
  candidates.push(new Array(horizon).fill(3));

  // Profile 3: Immediate Hop Forward
  candidates.push(new Array(horizon).fill(2));

  // Profile 4: Jump high initial burst (takeoff frames), then sprint forward
  const highJumpEarly = new Array(horizon).fill(1);
  for (let i = 0; i < Math.min(horizon, 6); i++) highJumpEarly[i] = 3;
  candidates.push(highJumpEarly);

  // Profile 5: Sprint then Leap across the extended horizon
  // With twice the steps (36), delays span the whole approach distance:
  const delays = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32];
  for (const delay of delays) {
    if (delay < horizon) {
      const seq = new Array(horizon).fill(1);
      const jumpDur = Math.min(10, horizon - delay);
      for (let i = delay; i < delay + jumpDur; i++) seq[i] = 3;
      candidates.push(seq);
    }
  }

  // Profile 6: Delayed Hops for low obstacles and floor spikes
  const hopDelays = [3, 6, 10, 15, 20, 26, 32];
  for (const delay of hopDelays) {
    if (delay < horizon) {
      const seq = new Array(horizon).fill(1);
      const hopDur = Math.min(6, horizon - delay);
      for (let i = delay; i < delay + hopDur; i++) seq[i] = 2;
      candidates.push(seq);
    }
  }

  // Profile 7: Double leap (leap over 1st gap, land/sprint, leap over 2nd gap in extended horizon)
  if (horizon >= 28) {
    const doubleLeap = new Array(horizon).fill(1);
    for (let i = 0; i < 6; i++) doubleLeap[i] = 3;
    const secondJump = Math.floor(horizon * 0.55);
    for (let i = secondJump; i < Math.min(horizon, secondJump + 8); i++) doubleLeap[i] = 3;
    candidates.push(doubleLeap);
  }

  // Profile 8: Ladder Climb & Ascend
  candidates.push(new Array(horizon).fill(4));

  // Profile 9: Delayed ladder grab across the extended horizon
  for (const delay of [4, 8, 14, 22]) {
    if (delay < horizon) {
      const seq = new Array(horizon).fill(1);
      for (let i = delay; i < horizon; i++) seq[i] = 4;
      candidates.push(seq);
    }
  }

  // Profile 10: Ranged Spell Strike while sprinting
  candidates.push(new Array(horizon).fill(5));
  for (const delay of [3, 6, 12, 18, 24, 30]) {
    if (delay < horizon) {
      const seq = new Array(horizon).fill(1);
      const blastDur = Math.min(5, horizon - delay);
      for (let i = delay; i < delay + blastDur; i++) seq[i] = 5;
      candidates.push(seq);
    }
  }

  return candidates;
}

// ===========================================================================
// DEEP NEURAL NETWORK (ACTOR-CRITIC)
// ===========================================================================
interface Layer {
  weights: number[][];
  biases: number[];
  mW: number[][];
  vW: number[][];
  mB: number[];
  vB: number[];
}

function createLayer(inSize: number, outSize: number): Layer {
  const scale = Math.sqrt(2.0 / inSize);
  const weights: number[][] = [];
  const mW: number[][] = [];
  const vW: number[][] = [];
  for (let i = 0; i < inSize; i++) {
    const row: number[] = [];
    const mRow: number[] = [];
    const vRow: number[] = [];
    for (let j = 0; j < outSize; j++) {
      row.push((Math.random() * 2 - 1) * scale);
      mRow.push(0);
      vRow.push(0);
    }
    weights.push(row);
    mW.push(mRow);
    vW.push(vRow);
  }
  return {
    weights,
    biases: new Array(outSize).fill(0.01),
    mW,
    vW,
    mB: new Array(outSize).fill(0),
    vB: new Array(outSize).fill(0),
  };
}

class DeepActorCritic {
  actorL1: Layer;
  actorL2: Layer;
  actorOut: Layer;
  criticL1: Layer;
  criticL2: Layer;
  criticOut: Layer;
  adamT = 0;

  constructor() {
    this.actorL1 = createLayer(NUM_FEATURES, 32);
    this.actorL2 = createLayer(32, 24);
    this.actorOut = createLayer(24, NUM_ACTIONS);
    this.criticL1 = createLayer(NUM_FEATURES, 32);
    this.criticL2 = createLayer(32, 24);
    this.criticOut = createLayer(24, 1);
  }

  forward(state: number[]) {
    const aH1 = this.denseRelu(state, this.actorL1);
    const aH2 = this.denseRelu(aH1, this.actorL2);
    const logits = this.denseLinear(aH2, this.actorOut);
    const probs = this.softmax(logits);

    const cH1 = this.denseRelu(state, this.criticL1);
    const cH2 = this.denseRelu(cH1, this.criticL2);
    const vOut = this.denseLinear(cH2, this.criticOut);
    return { probs, logits, value: vOut[0], aH1, aH2 };
  }

  denseRelu(x: number[], layer: Layer): number[] {
    const out = new Array(layer.biases.length);
    for (let j = 0; j < layer.biases.length; j++) {
      let sum = layer.biases[j];
      for (let i = 0; i < x.length; i++) sum += x[i] * layer.weights[i][j];
      out[j] = sum > 0 ? sum : 0.01 * sum;
    }
    return out;
  }

  denseLinear(x: number[], layer: Layer): number[] {
    const out = new Array(layer.biases.length);
    for (let j = 0; j < layer.biases.length; j++) {
      let sum = layer.biases[j];
      for (let i = 0; i < x.length; i++) sum += x[i] * layer.weights[i][j];
      out[j] = sum;
    }
    return out;
  }

  softmax(logits: number[]): number[] {
    let max = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    const exps = logits.map((l) => Math.exp(Math.max(-20, Math.min(20, l - max))));
    const sum = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => (sum > 0 ? e / sum : 1 / logits.length));
  }
}

// ===========================================================================
// MAIN REACT COMPONENT
// ===========================================================================
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nnCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Top level mode: 'mppi' (Superhuman Trajectory Planner), 'hybrid' (Neural + MPPI Safety), 'ppo' (Pure Neural), 'teleop'
  const [controlMode, setControlMode] = useState<'mppi' | 'hybrid' | 'ppo' | 'teleop'>('mppi');
  const [mppiHorizon, setMppiHorizon] = useState<number>(36); // 36 steps = 2x lookahead horizon
  const [isPaused, setIsPaused] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1);
  const [sfxMuted, setSfxMuted] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [stageLock, setStageLock] = useState(0); // 0 = Auto Curriculum, 1..4 = Locked stage

  // Reward sliders
  const [rewardCfg, setRewardCfg] = useState({
    xDistPerMeter: 1500,
    backPenaltyPerMeter: 2000,
    heartLostPenalty: 25000,
    deathPenalty: 75000,
    evadeReward: 8000,
    sectorClear: 35000,
    ghostKill: 4000,
    bulletCost: 500,
  });

  // Decoupled UI state (updated only via throttled timer)
  const [uiState, setUiState] = useState({
    engineText: 'MPPI (36 STEPS / 2× FORESIGHT): SUPERHUMAN (28 CONES)',
    isErr: false,
    attempt: 1,
    stageId: 1,
    stageName: 'Stage 1: Lava Pits & Gap Clearance',
    stageColor: '#ff6622',
    contextText: 'TRAJECTORY HORIZON: 36 STEPS (2× LOOKAHEAD)',
    criticVal: 0,
    maxDistMeters: 0,
    currentDistMeters: 0,
    maxSector: 1,
    bestReward: 0,
    sps: 60,
    mppiSafePaths: 18,
    mppiTotalCandidates: 28,
    mppiHorizon: 36,
    distReward: 0,
    evadeReward: 0,
    hazardsCleared: 0,
    sectorReward: 0,
    sectorsCleared: 0,
    ghostReward: 0,
    ghostKills: 0,
    heartsBonus: 5000,
    playerHp: 5,
    netReturn: 0,
    currentAction: 1,
    probs: [0.167, 0.167, 0.167, 0.167, 0.167, 0.167],
    historyList: [] as any[],
  });

  // Mutable game simulation engine ref
  const engineRef = useRef({
    network: new DeepActorCritic(),
    controlMode: 'mppi' as 'mppi' | 'hybrid' | 'ppo' | 'teleop',
    grid: [] as string[][],
    worldCols: 0,
    generatedSectors: 0,
    player: {
      x: 3 * TILE,
      y: 12 * TILE,
      w: 18,
      h: 24,
      vx: 0,
      vy: 0,
      speed: 4.0,
      jumpPower: 8.9,
      onGround: false,
      onLadder: false,
      coyote: 0,
      jumpBuf: 0,
      facing: 1,
      aimAngle: 0,
      maxHp: 5,
      hp: 5,
      maxMana: 100,
      mana: 100,
      invuln: 0,
      castCd: 0,
      weapon: 'apprentice',
      sector: 1,
    },
    ghosts: [] as any[],
    chests: [] as any[],
    coins: [] as any[],
    portals: [] as any[],
    spells: [] as any[],
    breadcrumbs: {} as Record<string, number>,
    ep: {
      ghostKills: 0,
      ghostReward: 0,
      sectorsCleared: 0,
      sectorReward: 0,
      hazardsCleared: 0,
      evadeReward: 0,
      lastClearedCol: -1,
      heartsKeptBonus: 0,
      heartsLost: 0,
      damagePenalty: 0,
      startX: 3 * TILE,
      maxPxReached: 3 * TILE,
      distReward: 0,
      bulletsFired: 0,
      bulletPenalty: 0,
      loopPenalty: 0,
      framesAlive: 0,
      stagnantFrames: 0,
      deathPenalty: 0,
      aimAngle: 0,
      currentAction: 1,
      mppiTrajectories: [] as ProjectedTrajectory[],
      chosenTrajectory: null as ProjectedTrajectory | null,
    },
    rlMeta: {
      attempt: 1,
      bestReward: null as number | null,
      maxDistMeters: 0,
      maxSector: 1,
      fullHistory: [] as any[],
    },
    latestTelemetry: {
      criticVal: 0,
      contextText: 'TRAJECTORY HORIZON: 20 FRAMES',
      probs: [0.167, 0.167, 0.167, 0.167, 0.167, 0.167],
      currentAction: 1,
      safePaths: 12,
      totalPaths: 16,
      activations: {
        inputs: new Array(16).fill(0),
        h1: new Array(12).fill(0),
        h2: new Array(8).fill(0),
      },
    },
    mouse: { x: 340, y: 240, worldX: 340, worldY: 240, down: false },
    keys: {} as Record<string, boolean>,
    actualStepsThisSec: 0,
    displayedSPS: 60,
    lastSpsTime: Date.now(),
    frameCounter: 0,
    audioCtx: null as AudioContext | null,
    isPaused: false,
    simSpeed: 1,
    sfxMuted: false,
    stageLock: 0,
    mppiHorizon: 36,
    rewardCfg: { ...rewardCfg },
    isConcluding: false,
  });

  useEffect(() => {
    engineRef.current.controlMode = controlMode;
  }, [controlMode]);

  useEffect(() => {
    engineRef.current.mppiHorizon = mppiHorizon;
  }, [mppiHorizon]);

  useEffect(() => {
    engineRef.current.isPaused = isPaused;
  }, [isPaused]);

  useEffect(() => {
    engineRef.current.simSpeed = simSpeed;
  }, [simSpeed]);

  useEffect(() => {
    engineRef.current.sfxMuted = sfxMuted;
  }, [sfxMuted]);

  useEffect(() => {
    engineRef.current.stageLock = stageLock;
  }, [stageLock]);

  useEffect(() => {
    engineRef.current.rewardCfg = { ...rewardCfg };
  }, [rewardCfg]);

  const playTone = (freq: number, type: OscillatorType, dur: number, endFreq?: number, vol = 0.05) => {
    const engine = engineRef.current;
    if (engine.isPaused || engine.sfxMuted || engine.simSpeed > 10) return;
    try {
      if (!engine.audioCtx) {
        const AudioClass = window.AudioContext || (window as any).webkitAudioContext;
        engine.audioCtx = new AudioClass();
      }
      if (engine.audioCtx.state === 'suspended') {
        engine.audioCtx.resume();
      }
      const osc = engine.audioCtx.createOscillator();
      const gain = engine.audioCtx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, engine.audioCtx.currentTime);
      if (endFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), engine.audioCtx.currentTime + dur);
      }
      gain.gain.setValueAtTime(vol || 0.05, engine.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, engine.audioCtx.currentTime + dur);
      osc.connect(gain);
      gain.connect(engine.audioCtx.destination);
      osc.start();
      osc.stop(engine.audioCtx.currentTime + dur);
    } catch {
      // Audio autoplay policy
    }
  };

  const getStageForMeters = (meters: number) => {
    const lock = engineRef.current.stageLock;
    if (lock >= 1 && lock <= 4) return CURRICULUM_STAGES[lock - 1];
    if (meters < 1000) return CURRICULUM_STAGES[0];
    if (meters < 2000) return CURRICULUM_STAGES[1];
    if (meters < 3000) return CURRICULUM_STAGES[2];
    return CURRICULUM_STAGES[3];
  };

  const getDistanceMeters = () => {
    const engine = engineRef.current;
    if (!engine.player || !engine.ep) return 0;
    return Math.max(0, Number(((engine.ep.maxPxReached - engine.ep.startX) / 12).toFixed(1)));
  };

  const getNetReward = () => {
    const engine = engineRef.current;
    if (!engine.player || !engine.ep) return 0;
    return Math.round(
      engine.ep.distReward +
        engine.ep.sectorReward +
        engine.ep.ghostReward +
        engine.ep.evadeReward +
        engine.ep.heartsKeptBonus +
        engine.player.hp * 1000 -
        engine.ep.bulletPenalty -
        engine.ep.damagePenalty -
        engine.ep.loopPenalty -
        engine.ep.deathPenalty
    );
  };

  const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

  const getTile = (c: number, r: number) => {
    const engine = engineRef.current;
    if (r < 0 || r >= MAP_ROWS || c < 0) return '1';
    if (c >= engine.worldCols || !engine.grid[r]) return '.';
    return engine.grid[r][c] || '.';
  };

  const isSolidWall = (c: number, r: number) => {
    const t = getTile(c, r);
    return t === '1' || t === '2';
  };

  const isTopOfLadder = (c: number, r: number) => {
    return getTile(c, r) === '3' && getTile(c, r - 1) !== '3';
  };

  const appendCurriculumSector = () => {
    const engine = engineRef.current;
    engine.generatedSectors++;
    const sIdx = engine.generatedSectors;
    const startC = engine.worldCols;
    const endC = startC + SECTOR_COLS;

    const sectorStartMeters = Math.max(0, (startC * TILE - 3 * TILE) / 12);
    const stage = getStageForMeters(sectorStartMeters);
    const stageId = stage.id;

    for (let r = 0; r < MAP_ROWS; r++) {
      if (!engine.grid[r]) engine.grid[r] = [];
      for (let c = startC; c < endC; c++) {
        if (r === 0 || r >= 14) engine.grid[r][c] = '1';
        else if (r === 13) engine.grid[r][c] = '2';
        else engine.grid[r][c] = '.';
      }
    }
    if (sIdx === 1) {
      for (let r0 = 0; r0 < MAP_ROWS; r0++) engine.grid[r0][0] = '1';
    }

    let curC = startC + (sIdx === 1 ? 8 : 5);
    const safeEndC = startC + 29;

    while (curC < safeEndC - 3) {
      let obstacleType = 'lava';

      if (stageId === 1) {
        obstacleType = 'lava';
      } else if (stageId === 2) {
        obstacleType = 'spike';
      } else if (stageId === 3) {
        obstacleType = Math.random() < 0.75 ? 'ladder' : 'lava';
      } else {
        const roll = Math.random();
        if (roll < 0.35) obstacleType = 'ghost_flat';
        else if (roll < 0.6) obstacleType = 'spike';
        else if (roll < 0.8) obstacleType = 'lava';
        else obstacleType = 'ladder';
      }

      if (obstacleType === 'lava') {
        const pitWidth = randInt(1, 2);
        if (curC + pitWidth < safeEndC) {
          for (let p = 0; p < pitWidth; p++) {
            engine.grid[13][curC + p] = '.';
            engine.grid[14][curC + p] = 'L';
          }
          engine.coins.push({
            x: (curC + pitWidth * 0.5) * TILE,
            y: 10 * TILE,
            collected: false,
            kind: 'gem',
          });
          curC += pitWidth + randInt(6, 8);
        } else {
          curC += 4;
        }
      } else if (obstacleType === 'spike') {
        engine.grid[12][curC] = '4';
        engine.coins.push({
          x: curC * TILE + 6,
          y: 9 * TILE + 10,
          collected: false,
          kind: 'gem',
        });
        curC += 1 + randInt(6, 8);
      } else if (obstacleType === 'ladder') {
        const platLen = randInt(5, 7);
        if (curC + platLen < safeEndC) {
          for (let rl = 9; rl <= 12; rl++) engine.grid[rl][curC] = '3';
          for (let cl = curC + 1; cl <= curC + platLen; cl++) engine.grid[9][cl] = '2';

          engine.chests.push({
            x: (curC + 2) * TILE,
            y: 8 * TILE,
            opened: false,
            item: 'crimson',
          });
          engine.coins.push({
            x: (curC + 4) * TILE + 6,
            y: 8 * TILE,
            collected: false,
            kind: 'gem',
          });
          curC += platLen + randInt(5, 7);
        } else {
          curC += 4;
        }
      } else if (obstacleType === 'ghost_flat') {
        const patrolLen = randInt(6, 8);
        if (curC + patrolLen < safeEndC) {
          const minPx = curC * TILE;
          const maxPx = (curC + patrolLen) * TILE;
          engine.ghosts.push({
            x: minPx + Math.random() * (maxPx - minPx),
            y: 11 * TILE,
            minX: minPx,
            maxX: maxPx,
            vx: 1.1 + Math.random() * 0.2,
            dir: Math.random() < 0.5 ? 1 : -1,
            hp: 2,
            maxHp: 2,
            bob: Math.random() * 6.28,
          });
          curC += patrolLen + randInt(5, 7);
        } else {
          curC += 4;
        }
      }
    }

    engine.grid[11][startC + 32] = '5';
    engine.grid[12][startC + 32] = '5';
    engine.portals.push({
      c: startC + 32,
      sector: sIdx,
      passed: false,
      gemTaken: false,
      gemX: (startC + 30) * TILE,
      gemY: 11 * TILE,
    });

    engine.worldCols = endC;
    const safeX = engine.player.x - 1200;
    engine.ghosts = engine.ghosts.filter((g) => g.x > safeX || g.hp > 0);
    engine.chests = engine.chests.filter((c) => c.x > safeX);
    engine.coins = engine.coins.filter((c) => c.x > safeX && !c.collected);
    engine.portals = engine.portals.filter((p) => p.c * TILE > safeX);
  };

  const initWorld = () => {
    const engine = engineRef.current;
    engine.grid = [];
    for (let r = 0; r < MAP_ROWS; r++) engine.grid[r] = [];
    engine.worldCols = 0;
    engine.generatedSectors = 0;
    engine.ghosts = [];
    engine.chests = [];
    engine.coins = [];
    engine.portals = [];
    engine.spells = [];
    engine.breadcrumbs = {};
    appendCurriculumSector();
    appendCurriculumSector();
    appendCurriculumSector();
  };

  const startNewAttempt = () => {
    const engine = engineRef.current;
    engine.isConcluding = false;
    initWorld();

    engine.player = {
      x: 3 * TILE,
      y: 12 * TILE,
      w: 18,
      h: 24,
      vx: 0,
      vy: 0,
      speed: 4.0,
      jumpPower: 8.9,
      onGround: false,
      onLadder: false,
      coyote: 0,
      jumpBuf: 0,
      facing: 1,
      aimAngle: 0,
      maxHp: 5,
      hp: 5,
      maxMana: 100,
      mana: 100,
      invuln: 0,
      castCd: 0,
      weapon: 'apprentice',
      sector: 1,
    };

    engine.ep = {
      ghostKills: 0,
      ghostReward: 0,
      sectorsCleared: 0,
      sectorReward: 0,
      hazardsCleared: 0,
      evadeReward: 0,
      lastClearedCol: -1,
      heartsKeptBonus: 0,
      heartsLost: 0,
      damagePenalty: 0,
      startX: engine.player.x,
      maxPxReached: engine.player.x,
      distReward: 0,
      bulletsFired: 0,
      bulletPenalty: 0,
      loopPenalty: 0,
      framesAlive: 0,
      stagnantFrames: 0,
      deathPenalty: 0,
      aimAngle: 0,
      currentAction: 1,
      mppiTrajectories: [],
      chosenTrajectory: null,
    };
  };

  // Continuous Feature Extraction
  const extractContinuousFeatures = () => {
    const engine = engineRef.current;
    const player = engine.player;
    const pCx = player.x + player.w / 2;
    const pCy = player.y + player.h / 2;
    const pCol = Math.floor(pCx / TILE);
    const pRow = Math.floor((player.y + player.h - 2) / TILE);

    const normVx = Math.max(-1, Math.min(1, player.vx / player.speed));
    const normVy = Math.max(-1, Math.min(1, player.vy / 10));

    const onGround = player.onGround ? 1.0 : 0.0;
    const onLadder = player.onLadder ? 1.0 : 0.0;

    let distToFloorEdge = 1.0;
    let gapWidth = 0.0;
    for (let c = pCol + 1; c <= pCol + 5; c++) {
      const floorT = getTile(c, pRow + 1);
      if (floorT === '.' || floorT === 'L') {
        distToFloorEdge = Math.max(0, (c * TILE - player.x) / (5 * TILE));
        let w = 1;
        while (c + w <= pCol + 5 && (getTile(c + w, pRow + 1) === '.' || getTile(c + w, pRow + 1) === 'L')) w++;
        gapWidth = Math.min(1.0, w / 3.0);
        break;
      }
    }

    let distToSpike = 1.0;
    for (let c = pCol + 1; c <= pCol + 5; c++) {
      if (getTile(c, pRow) === '4') {
        distToSpike = Math.max(0, (c * TILE - player.x) / (5 * TILE));
        break;
      }
    }

    let distToLadder = 1.0;
    let ladderTopDistY = 0.0;
    for (let c = pCol; c <= pCol + 4; c++) {
      if (getTile(c, pRow) === '3' || getTile(c, pRow + 1) === '3') {
        distToLadder = Math.max(0, (c * TILE - player.x) / (4 * TILE));
        let topR = pRow;
        while (topR > 0 && getTile(c, topR) === '3') topR--;
        ladderTopDistY = Math.max(-1, Math.min(1, (topR * TILE - player.y) / 150));
        break;
      }
    }

    let enemyDx = 1.0;
    let enemyDy = 0.0;
    let enemyDist = 1.0;
    let nearestGhost: any = null;
    let nearestD = 999;
    for (const gh of engine.ghosts) {
      if (gh.hp <= 0) continue;
      const d = Math.hypot(gh.x + 14 - pCx, gh.y + 14 - pCy);
      if (d < 220 && d < nearestD) {
        nearestD = d;
        nearestGhost = gh;
        enemyDx = Math.max(-1, Math.min(1, (gh.x + 14 - pCx) / 200));
        enemyDy = Math.max(-1, Math.min(1, (gh.y + 14 - pCy) / 150));
        enemyDist = Math.max(0, Math.min(1, d / 200));
        engine.ep.aimAngle = Math.atan2(gh.y + 12 - pCy, gh.x + 14 - pCx);
      }
    }
    if (!nearestGhost) engine.ep.aimAngle = 0;

    let forwardLidar1 = 1.0;
    let forwardLidar2 = 1.0;
    for (let i = 1; i <= 4; i++) {
      if (isSolidWall(pCol + i, pRow - 1)) {
        forwardLidar1 = i / 4.0;
        break;
      }
      if (isSolidWall(pCol + i, pRow)) {
        forwardLidar2 = i / 4.0;
        break;
      }
    }

    const curFloor = getTile(pCol, pRow + 1);
    const floorLidar = curFloor === '.' || curFloor === 'L' ? 0.0 : 1.0;
    const visits = engine.breadcrumbs[`${pCol},${pRow}`] || 0;
    const stuckMeter = Math.min(1.0, visits / 4.0);

    return {
      features: [
        normVx,
        normVy,
        onGround,
        onLadder,
        distToFloorEdge,
        gapWidth,
        distToSpike,
        distToLadder,
        ladderTopDistY,
        enemyDx,
        enemyDy,
        enemyDist,
        forwardLidar1,
        forwardLidar2,
        floorLidar,
        stuckMeter,
      ],
      pCol,
      pRow,
      enemyNear: enemyDist < 0.6 && enemyDx > 0,
      ladderNear: distToLadder < 0.25,
    };
  };

  // Controller Decision
  const stepAgentDecision = () => {
    const engine = engineRef.current;
    const perc = extractContinuousFeatures();
    const state = perc.features;

    const bKey = `${perc.pCol},${perc.pRow}`;
    if (engine.ep.framesAlive % 5 === 0) {
      engine.breadcrumbs[bKey] = (engine.breadcrumbs[bKey] || 0) + 1;
    }

    // 1. TELEOP
    if (engine.controlMode === 'teleop') {
      const hLeft = Boolean(engine.keys['KeyA'] || engine.keys['ArrowLeft']);
      const hRight = Boolean(engine.keys['KeyD'] || engine.keys['ArrowRight']);
      const hUp = Boolean(engine.keys['KeyW'] || engine.keys['ArrowUp']);
      const hDown = Boolean(engine.keys['KeyS'] || engine.keys['ArrowDown']);
      const hJump = Boolean(engine.keys['Space'] || (hUp && !engine.player.onLadder));
      const hInteract = Boolean(engine.keys['KeyE']);
      const hShoot = Boolean(engine.mouse.down || engine.keys['KeyJ'] || engine.keys['KeyZ']);
      return { left: hLeft, right: hRight, up: hUp, down: hDown, jump: hJump, interact: hInteract, shoot: hShoot };
    }

    // 2. MPPI (MODEL PREDICTIVE PATH INTEGRAL) / TRAJECTORY ROLLOUTS
    const horizonSteps = engine.mppiHorizon || 36;
    const candidates = generateMPPICandidates(horizonSteps);
    const simPlayer: SimulatedPlayerState = {
      x: engine.player.x,
      y: engine.player.y,
      vx: engine.player.vx,
      vy: engine.player.vy,
      speed: engine.player.speed,
      jumpPower: engine.player.jumpPower,
      onGround: engine.player.onGround,
      onLadder: engine.player.onLadder,
      coyote: engine.player.coyote,
      jumpBuf: engine.player.jumpBuf,
      w: engine.player.w,
      h: engine.player.h,
    };

    const evaluatedTrajectories: ProjectedTrajectory[] = [];
    let bestTrajectory: ProjectedTrajectory | null = null;
    let bestScore = -Infinity;
    let safeCount = 0;

    for (const seq of candidates) {
      const traj = runKinematicRollout(simPlayer, seq, engine.grid, engine.worldCols, engine.ghosts);
      evaluatedTrajectories.push(traj);
      if (traj.isSafe) safeCount++;
      if (traj.score > bestScore) {
        bestScore = traj.score;
        bestTrajectory = traj;
      }
    }

    engine.ep.mppiTrajectories = evaluatedTrajectories;
    engine.ep.chosenTrajectory = bestTrajectory;

    // Cache telemetry
    engine.latestTelemetry.safePaths = safeCount;
    engine.latestTelemetry.totalPaths = candidates.length;

    let chosenAct = 1; // Default sprint

    if (engine.controlMode === 'mppi') {
      // Pure MPPI Superhuman Trajectory Selection
      if (bestTrajectory && bestTrajectory.isSafe) {
        chosenAct = bestTrajectory.actionId;
      } else {
        // Emergency power leap forward over hazard
        chosenAct = 3;
      }
      engine.latestTelemetry.contextText = `MPPI (${horizonSteps}s - 2×): ${safeCount}/${candidates.length} SAFE | OPT: ACT #${chosenAct}`;
    } else if (engine.controlMode === 'hybrid') {
      // Hybrid: Neural Net proposes, MPPI checks safety
      const fwd = engine.network.forward(state);
      const nnAct = fwd.probs.indexOf(Math.max(...fwd.probs));

      // Check if neural proposed action is safe via MPPI
      const nnSafe = evaluatedTrajectories.some((t) => t.actionId === nnAct && t.isSafe);
      if (nnSafe) {
        chosenAct = nnAct;
        engine.latestTelemetry.contextText = `HYBRID (${horizonSteps}s): NN ACT #${chosenAct} SAFE`;
      } else if (bestTrajectory && bestTrajectory.isSafe) {
        chosenAct = bestTrajectory.actionId;
        engine.latestTelemetry.contextText = `HYBRID (${horizonSteps}s): MPPI OVERRULED -> ACT #${chosenAct}`;
      } else {
        chosenAct = 3;
      }
    } else {
      // Pure PPO Neural
      const fwd = engine.network.forward(state);
      chosenAct = fwd.probs.indexOf(Math.max(...fwd.probs));
      engine.latestTelemetry.contextText = `PURE NEURAL: ACT #${chosenAct} (${(fwd.probs[chosenAct] * 100).toFixed(1)}%)`;
    }

    // Auto ghost targeting
    if (perc.enemyNear && Math.random() < 0.6) {
      chosenAct = 5; // Blast spell
    }

    engine.ep.currentAction = chosenAct;
    engine.latestTelemetry.currentAction = chosenAct;

    // Update action probabilities for UI bar visualization
    const actProbs = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    actProbs[chosenAct] = 0.75;
    engine.latestTelemetry.probs = actProbs;

    const act = {
      left: false,
      right: false,
      up: false,
      down: false,
      jump: false,
      interact: false,
      shoot: false,
    };

    switch (chosenAct) {
      case 0:
        act.right = true;
        break;
      case 1:
        act.right = true;
        break;
      case 2:
        act.right = true;
        act.jump = true;
        break;
      case 3:
        act.right = true;
        act.jump = true;
        break;
      case 4:
        act.up = true;
        act.right = true;
        act.interact = true;
        break;
      case 5:
        act.right = true;
        act.shoot = true;
        break;
    }

    return act;
  };

  const fireSpell = (targetX: number, targetY: number) => {
    const engine = engineRef.current;
    const player = engine.player;
    if (player.castCd > 0 || player.mana < 5) return;
    player.mana -= 5;
    player.castCd = 14;

    const cfg = engine.rewardCfg;
    engine.ep.bulletsFired++;
    engine.ep.bulletPenalty += cfg.bulletCost;
    playTone(540, 'triangle', 0.1, 180, 0.05);

    const ox = player.x + player.w / 2;
    const oy = player.y + player.h / 2 - 2;
    const ang = Math.atan2(targetY - oy, targetX - ox);
    player.aimAngle = ang;
    player.facing = 1;

    const spd = player.weapon === 'crimson' ? 9.5 : 8.5;
    engine.spells.push({
      x: ox + Math.cos(ang) * 10,
      y: oy + Math.sin(ang) * 10,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      dmg: player.weapon === 'crimson' ? 2 : 1,
      type: player.weapon === 'crimson' ? 'flame' : 'arcane',
      life: 55,
    });
  };

  const applyHeavyHeartLoss = (heartsLostCount: number) => {
    const engine = engineRef.current;
    engine.player.hp -= heartsLostCount;
    engine.ep.heartsLost += heartsLostCount;
    const pen = heartsLostCount * engine.rewardCfg.heartLostPenalty;
    engine.ep.damagePenalty += pen;
    playTone(120, 'sawtooth', 0.18, 40, 0.12);
  };

  const finishRollout = (cause: string, died: boolean) => {
    const engine = engineRef.current;
    if (engine.isConcluding) return;
    engine.isConcluding = true;

    const distM = getDistanceMeters();
    const cfg = engine.rewardCfg;
    if (died) engine.ep.deathPenalty = cfg.deathPenalty;

    const finalScore = getNetReward();
    if (distM > engine.rlMeta.maxDistMeters) engine.rlMeta.maxDistMeters = distM;
    if (engine.rlMeta.bestReward === null || finalScore > engine.rlMeta.bestReward) {
      engine.rlMeta.bestReward = finalScore;
    }
    if (engine.player.sector > engine.rlMeta.maxSector) {
      engine.rlMeta.maxSector = engine.player.sector;
    }

    const stageInfo = getStageForMeters(distM);

    const histItem = {
      attempt: engine.rlMeta.attempt,
      dist: distM,
      recordDist: engine.rlMeta.maxDistMeters,
      reward: finalScore,
      stage: stageInfo.shortName,
      sectors: engine.ep.sectorsCleared,
      evades: engine.ep.hazardsCleared,
      ghosts: engine.ep.ghostKills,
      cause: cause || 'Ended',
    };

    engine.rlMeta.fullHistory.push(histItem);
    engine.rlMeta.attempt++;

    startNewAttempt();
  };

  const stepPhysics = () => {
    const engine = engineRef.current;
    if (engine.isConcluding) return;
    engine.ep.framesAlive++;
    engine.actualStepsThisSec++;

    const player = engine.player;
    const cfg = engine.rewardCfg;

    if (player.x + 1400 > engine.worldCols * TILE) appendCurriculumSector();
    if (player.mana < player.maxMana) player.mana = Math.min(player.maxMana, player.mana + 0.35);
    if (player.invuln > 0) player.invuln--;
    if (player.castCd > 0) player.castCd--;

    const prevX = player.x;
    const aiAct = stepAgentDecision();

    if (aiAct.shoot) {
      const pCx = player.x + player.w / 2,
        pCy = player.y + player.h / 2;
      const aimX = engine.controlMode !== 'teleop' ? pCx + Math.cos(engine.ep.aimAngle) * 120 : engine.mouse.worldX;
      const aimY = engine.controlMode !== 'teleop' ? pCy + Math.sin(engine.ep.aimAngle) * 120 : engine.mouse.worldY;
      fireSpell(aimX, aimY);
    }

    const centerC = Math.floor((player.x + player.w / 2) / TILE);
    const bodyR = Math.floor((player.y + player.h / 2) / TILE);
    const feetR = Math.floor((player.y + player.h - 1) / TILE);
    const belowFeetR = Math.floor((player.y + player.h + 4) / TILE);

    const inLad = getTile(centerC, bodyR) === '3' || getTile(centerC, feetR) === '3';
    const onLadTop = isTopOfLadder(centerC, belowFeetR);

    if (inLad && (aiAct.up || aiAct.down)) {
      player.onLadder = true;
      player.x += (centerC * TILE + (TILE - player.w) / 2 - player.x) * 0.25;
    } else if (onLadTop && aiAct.down) {
      player.onLadder = true;
      player.onGround = false;
      player.y += 5;
    }
    if (!inLad && !onLadTop) player.onLadder = false;

    let mx = 0;
    if (aiAct.left) mx -= 1;
    if (aiAct.right) mx += 1;
    player.vx = mx * player.speed;

    if (player.onGround) player.coyote = 8;
    else if (player.coyote > 0) player.coyote--;

    if (aiAct.jump && !player.onLadder) player.jumpBuf = 6;
    else if (player.jumpBuf > 0) player.jumpBuf--;

    if (player.onLadder) {
      player.vy = 0;
      if (aiAct.up) player.vy = -player.speed * 0.95;
      if (aiAct.down) player.vy = player.speed * 0.95;
      const topCheckR = Math.floor((player.y + player.h - 2) / TILE);
      if (aiAct.up && getTile(centerC, topCheckR) !== '3' && isTopOfLadder(centerC, topCheckR + 1)) {
        player.y = (topCheckR + 1) * TILE - player.h;
        player.vy = 0;
        player.onLadder = false;
        player.onGround = true;
      }
    } else {
      player.vy += 0.36;
      if (player.vy > 8.8) player.vy = 8.8;
      if (player.jumpBuf > 0 && player.coyote > 0) {
        player.vy = -player.jumpPower;
        player.onGround = false;
        player.coyote = 0;
        player.jumpBuf = 0;
      }
    }

    player.x += player.vx;
    let lC = Math.floor(player.x / TILE);
    let rC = Math.floor((player.x + player.w - 0.01) / TILE);
    let tR = Math.floor((player.y + 2) / TILE);
    let bR = Math.floor((player.y + player.h - 2) / TILE);

    if (player.vx > 0 && (isSolidWall(rC, tR) || isSolidWall(rC, bR))) {
      player.x = rC * TILE - player.w - 0.05;
      player.vx = 0;
    } else if (player.vx < 0 && (isSolidWall(lC, tR) || isSolidWall(lC, bR))) {
      player.x = (lC + 1) * TILE + 0.05;
      player.vx = 0;
    }

    const prevBottom = player.y + player.h;
    player.y += player.vy;
    lC = Math.floor((player.x + 2) / TILE);
    rC = Math.floor((player.x + player.w - 2) / TILE);
    tR = Math.floor(player.y / TILE);
    bR = Math.floor((player.y + player.h) / TILE);

    player.onGround = false;
    if (player.vy >= 0 && !player.onLadder) {
      const solidFl = isSolidWall(lC, bR) || isSolidWall(rC, bR);
      const ladFl = !aiAct.down && (isTopOfLadder(lC, bR) || isTopOfLadder(rC, bR)) && prevBottom <= bR * TILE + 6;
      if (solidFl || ladFl) {
        player.y = bR * TILE - player.h;
        player.vy = 0;
        player.onGround = true;

        const tB1 = getTile(centerC - 1, bR - 1),
          tBU1 = getTile(centerC - 1, bR);
        const tB2 = getTile(centerC - 2, bR - 1),
          tBU2 = getTile(centerC - 2, bR);
        const clearedHazard =
          tB1 === '4' || tBU1 === 'L' || tBU1 === '.' || tB2 === '4' || tBU2 === 'L' || tBU2 === '.';
        if (clearedHazard && centerC > engine.ep.lastClearedCol) {
          engine.ep.lastClearedCol = centerC;
          engine.ep.hazardsCleared++;
          engine.ep.evadeReward += cfg.evadeReward;
          engine.ep.stagnantFrames = 0;
          playTone(880, 'triangle', 0.12, 1320, 0.06);
        }
      }
    } else if (player.vy < 0 && !player.onLadder) {
      if (isSolidWall(lC, tR) || isSolidWall(rC, tR)) {
        player.y = (tR + 1) * TILE;
        player.vy = 0;
      }
    }

    // Forward reward
    if (player.x > engine.ep.maxPxReached) {
      const deltaMeters = (player.x - engine.ep.maxPxReached) / 12;
      engine.ep.maxPxReached = player.x;
      const fwdGain = deltaMeters * cfg.xDistPerMeter * (1 + getDistanceMeters() * 0.02);
      engine.ep.distReward += fwdGain;
      engine.ep.stagnantFrames = 0;
      if (getDistanceMeters() > engine.rlMeta.maxDistMeters) {
        engine.rlMeta.maxDistMeters = getDistanceMeters();
      }
    } else if (player.x < prevX - 0.1) {
      const backMeters = (prevX - player.x) / 12;
      engine.ep.distReward -= backMeters * cfg.backPenaltyPerMeter;
    } else if (engine.controlMode !== 'teleop') {
      engine.ep.stagnantFrames++;
      if (engine.ep.stagnantFrames > 350) {
        finishRollout('Stall / Stagnation', true);
        return;
      }
    }

    const fC1 = Math.floor((player.x + 4) / TILE),
      fC2 = Math.floor((player.x + player.w - 4) / TILE),
      fR = Math.floor((player.y + player.h - 2) / TILE);
    const hz1 = getTile(fC1, fR),
      hz2 = getTile(fC2, fR);
    if (hz1 === '4' || hz2 === '4') {
      if (player.invuln === 0) {
        applyHeavyHeartLoss(1);
        player.invuln = 35;
        player.vy = -5.8;
        if (player.hp <= 0) {
          finishRollout('Floor Spikes', true);
          return;
        }
      }
    } else if (hz1 === 'L' || hz2 === 'L') {
      if (player.invuln === 0) {
        applyHeavyHeartLoss(2);
        player.invuln = 35;
        player.vy = -6.8;
        if (player.hp <= 0) {
          finishRollout('Lava Pit', true);
          return;
        }
      }
    }

    // Spells
    for (let i = engine.spells.length - 1; i >= 0; i--) {
      const s = engine.spells[i];
      s.x += s.vx;
      s.y += s.vy;
      s.life--;
      const sc = Math.floor(s.x / TILE),
        sr = Math.floor(s.y / TILE);
      if (isSolidWall(sc, sr)) {
        engine.spells.splice(i, 1);
        continue;
      }
      for (let g = 0; g < engine.ghosts.length; g++) {
        const gh = engine.ghosts[g];
        if (gh.hp > 0 && Math.hypot(s.x - (gh.x + 14), s.y - (gh.y + 14)) < 19) {
          gh.hp -= s.dmg;
          engine.ep.bulletPenalty = Math.max(0, engine.ep.bulletPenalty - cfg.bulletCost);
          engine.ep.stagnantFrames = 0;
          s.life = 0;
          if (gh.hp <= 0) {
            engine.ep.ghostKills++;
            engine.ep.ghostReward += cfg.ghostKill;
            playTone(680, 'sine', 0.12, 1100, 0.06);
          }
          break;
        }
      }
      if (s.life <= 0) engine.spells.splice(i, 1);
    }

    // Ghosts
    for (let gi = 0; gi < engine.ghosts.length; gi++) {
      const ghObj = engine.ghosts[gi];
      if (ghObj.hp <= 0) continue;
      ghObj.bob += 0.06;
      const dist = Math.hypot(player.x + 9 - (ghObj.x + 14), player.y + 12 - (ghObj.y + 14));
      if (dist < 135) {
        const ang = Math.atan2(player.y + 12 - (ghObj.y + 14), player.x + 9 - (ghObj.x + 14));
        ghObj.x += Math.cos(ang) * 1.15;
        ghObj.y += Math.sin(ang) * 0.6;
        ghObj.dir = Math.cos(ang) >= 0 ? 1 : -1;
      } else {
        ghObj.x += ghObj.vx * ghObj.dir;
        if (ghObj.x > ghObj.maxX) ghObj.dir = -1;
        if (ghObj.x < ghObj.minX) ghObj.dir = 1;
      }
      if (dist < 16 && player.invuln === 0) {
        applyHeavyHeartLoss(1);
        player.invuln = 40;
        player.vy = -4.8;
        if (player.hp <= 0) {
          finishRollout('Wraith Contact', true);
          return;
        }
      }
    }

    // Chests & Portals
    if (aiAct.interact) {
      engine.keys['KeyE'] = false;
      for (let ci = 0; ci < engine.chests.length; ci++) {
        const ch = engine.chests[ci];
        if (!ch.opened && Math.hypot(player.x + 9 - (ch.x + 14), player.y + 12 - (ch.y + 14)) < 32) {
          ch.opened = true;
          engine.ep.stagnantFrames = 0;
          if (ch.item === 'crimson') player.weapon = 'crimson';
        }
      }
    }

    for (let cIdx = 0; cIdx < engine.coins.length; cIdx++) {
      const cObj = engine.coins[cIdx];
      if (!cObj.collected && Math.hypot(player.x + 9 - (cObj.x + 8), player.y + 12 - (cObj.y + 8)) < 20) {
        cObj.collected = true;
        engine.ep.stagnantFrames = 0;
        playTone(820, 'sine', 0.06, 1200, 0.05);
      }
    }

    for (let pi = 0; pi < engine.portals.length; pi++) {
      const pt = engine.portals[pi];
      if (!pt.passed && centerC >= pt.c) {
        pt.passed = true;
        engine.ep.sectorsCleared++;
        player.sector = pt.sector + 1;
        if (player.sector > engine.rlMeta.maxSector) {
          engine.rlMeta.maxSector = player.sector;
        }
        engine.ep.sectorReward += cfg.sectorClear;
        engine.ep.heartsKeptBonus += player.hp * 1000;
        engine.ep.stagnantFrames = 0;
      }
    }
  };

  // Canvas Render with MPPI Trajectory Cones
  const renderWorld = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const engine = engineRef.current;
    const player = engine.player;
    if (!player) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const camX = Math.max(0, player.x + player.w / 2 - canvas.width * 0.32);
    if (engine.controlMode === 'teleop') {
      engine.mouse.worldX = engine.mouse.x + camX;
      engine.mouse.worldY = engine.mouse.y;
    }

    ctx.save();
    ctx.translate(-Math.floor(camX), 0);
    const startCol = Math.max(0, Math.floor(camX / TILE) - 1);
    const endCol = Math.min(engine.worldCols - 1, Math.ceil((camX + canvas.width) / TILE) + 1);

    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = startCol; c <= endCol; c++) {
        ctx.fillStyle = (c + r) % 2 === 0 ? '#10121f' : '#141726';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);

        const t = getTile(c, r);
        const dx = c * TILE,
          dy = r * TILE;
        if (t === '1') {
          ctx.fillStyle = '#282538';
          ctx.fillRect(dx, dy, TILE, TILE);
          ctx.strokeStyle = '#181524';
          ctx.strokeRect(dx + 0.5, dy + 0.5, TILE - 1, TILE - 1);
        } else if (t === '2') {
          ctx.fillStyle = '#3e332e';
          ctx.fillRect(dx, dy, TILE, TILE);
          ctx.fillStyle = '#1d7855';
          ctx.fillRect(dx, dy, TILE, 7);
        } else if (t === '3') {
          if (isTopOfLadder(c, r)) {
            ctx.fillStyle = '#266347';
            ctx.fillRect(dx, dy, TILE, 5);
          }
          ctx.fillStyle = '#704826';
          ctx.fillRect(dx + 5, dy, 3, TILE);
          ctx.fillRect(dx + TILE - 8, dy, 3, TILE);
          ctx.fillStyle = '#ad7645';
          for (let y = 4; y < TILE; y += 7) {
            ctx.fillRect(dx + 5, dy + y, TILE - 10, 3);
          }
        } else if (t === '4') {
          for (let s = 0; s < 3; s++) {
            const sx = dx + 2 + s * 8;
            ctx.fillStyle = '#e63946';
            ctx.beginPath();
            ctx.moveTo(sx, dy + TILE);
            ctx.lineTo(sx + 4, dy + 10);
            ctx.lineTo(sx + 8, dy + TILE);
            ctx.fill();
          }
        } else if (t === 'L') {
          const wave = Math.sin(Date.now() * 0.005 + c) * 2.5;
          ctx.fillStyle = '#e63900';
          ctx.fillRect(dx, dy + 5 + wave, TILE, TILE - 5 - wave);
          ctx.fillStyle = '#ffcc00';
          ctx.fillRect(dx, dy + 3 + wave, TILE, 4);
        } else if (t === '5') {
          ctx.fillStyle = '#132242';
          ctx.fillRect(dx, dy, TILE, TILE);
          ctx.strokeStyle = '#00e5ff';
          ctx.lineWidth = 2;
          ctx.strokeRect(dx + 3, dy + 3, TILE - 6, TILE - 6);
        }
      }
    }

    // Chests
    for (let i = 0; i < engine.chests.length; i++) {
      const ch = engine.chests[i];
      ctx.fillStyle = ch.opened ? '#5e4327' : '#9c6631';
      ctx.fillRect(ch.x + 4, ch.y + 10, 20, 18);
      ctx.strokeStyle = '#ffd700';
      ctx.strokeRect(ch.x + 4, ch.y + 10, 20, 18);
    }

    // Coins & Gems
    const bob = Math.sin(Date.now() * 0.005) * 2.5;
    for (let ci = 0; ci < engine.coins.length; ci++) {
      const cObj = engine.coins[ci];
      if (!cObj.collected) {
        if (cObj.kind === 'coin') {
          ctx.fillStyle = '#ffd700';
          ctx.beginPath();
          ctx.arc(cObj.x + 8, cObj.y + 8 + bob, 6.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#2bf56b';
          ctx.beginPath();
          ctx.moveTo(cObj.x + 8, cObj.y + bob);
          ctx.lineTo(cObj.x + 15, cObj.y + 8 + bob);
          ctx.lineTo(cObj.x + 8, cObj.y + 16 + bob);
          ctx.lineTo(cObj.x + 1, cObj.y + 8 + bob);
          ctx.fill();
        }
      }
    }

    // Portals
    for (let pi = 0; pi < engine.portals.length; pi++) {
      const pt = engine.portals[pi];
      if (!pt.gemTaken) {
        ctx.fillStyle = '#00ffea';
        ctx.beginPath();
        ctx.moveTo(pt.gemX + 10, pt.gemY + bob);
        ctx.lineTo(pt.gemX + 20, pt.gemY + 11 + bob);
        ctx.lineTo(pt.gemX + 10, pt.gemY + 22 + bob);
        ctx.lineTo(pt.gemX, pt.gemY + 11 + bob);
        ctx.fill();
      }
    }

    // Ghosts
    for (let gi = 0; gi < engine.ghosts.length; gi++) {
      const ghObj = engine.ghosts[gi];
      if (ghObj.hp <= 0) continue;
      const gy = ghObj.y + Math.sin(ghObj.bob) * 4;
      ctx.save();
      ctx.translate(ghObj.x + 14, gy + 14);
      ctx.scale(ghObj.dir, 1);
      ctx.fillStyle = 'rgba(110, 235, 255, 0.88)';
      ctx.beginPath();
      ctx.arc(0, -3, 11, Math.PI, 0, false);
      ctx.lineTo(11, 11);
      ctx.lineTo(5, 7);
      ctx.lineTo(0, 11);
      ctx.lineTo(-5, 7);
      ctx.lineTo(-11, 11);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffea00';
      ctx.fillRect(2, -5, 3, 3);
      ctx.fillRect(-5, -5, 3, 3);
      ctx.restore();
    }

    // =========================================================================
    // RENDER MPPI PREDICTED TRAJECTORY CONES (The Agent's "Imagination"!)
    // =========================================================================
    if (engine.controlMode !== 'teleop' && engine.ep.mppiTrajectories.length > 0) {
      ctx.save();
      for (const traj of engine.ep.mppiTrajectories) {
        if (traj.points.length < 2) continue;
        const isOptimal = traj === engine.ep.chosenTrajectory;

        ctx.lineWidth = isOptimal ? 2.5 : 1.0;
        ctx.setLineDash(isOptimal ? [] : [3, 4]);
        ctx.strokeStyle = isOptimal
          ? '#ffd700'
          : traj.isSafe
          ? 'rgba(0, 255, 234, 0.45)'
          : 'rgba(255, 82, 99, 0.35)';

        ctx.beginPath();
        ctx.moveTo(traj.points[0].x + 9, traj.points[0].y + 12);
        for (let p = 1; p < traj.points.length; p++) {
          ctx.lineTo(traj.points[p].x + 9, traj.points[p].y + 12);
        }
        ctx.stroke();

        // Mark rejected death points
        if (!traj.isSafe && traj.points.length > 0) {
          const lastPt = traj.points[traj.points.length - 1];
          ctx.fillStyle = '#ff5263';
          ctx.beginPath();
          ctx.arc(lastPt.x + 9, lastPt.y + 12, 3, 0, Math.PI * 2);
          ctx.fill();
        } else if (isOptimal && traj.points.length > 0) {
          const lastPt = traj.points[traj.points.length - 1];
          ctx.fillStyle = '#ffd700';
          ctx.beginPath();
          ctx.arc(lastPt.x + 9, lastPt.y + 12, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Milestone record line
    if (engine.rlMeta.maxDistMeters > 0) {
      const recordPx = engine.ep.startX + engine.rlMeta.maxDistMeters * 12;
      ctx.save();
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(recordPx, 28);
      ctx.lineTo(recordPx, 13 * TILE);
      ctx.stroke();
      ctx.fillStyle = '#ffd700';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`RECORD: ${engine.rlMeta.maxDistMeters}m`, recordPx - 45, 42);
      ctx.restore();
    }

    const pOx = player.x + player.w / 2;
    const pOy = player.y + player.h / 2 - 2;

    // Player
    const aimAngle = engine.controlMode !== 'teleop'
      ? engine.ep.aimAngle
      : Math.atan2(engine.mouse.worldY - pOy, engine.mouse.worldX - pOx);
    ctx.save();
    ctx.translate(pOx, player.y + player.h / 2);
    ctx.scale(1, 1);
    ctx.fillStyle = player.weapon === 'crimson' ? '#7a2336' : '#28427a';
    ctx.fillRect(-7, -3, 14, 15);
    ctx.fillStyle = player.weapon === 'crimson' ? '#ab324b' : '#3b5fa8';
    ctx.fillRect(-6, -12, 12, 10);
    ctx.fillStyle = '#55f2ff';
    ctx.fillRect(2, -8, 2, 2);
    ctx.restore();

    ctx.save();
    ctx.translate(pOx, pOy);
    ctx.rotate(aimAngle);
    ctx.fillStyle = '#8b5a2b';
    ctx.fillRect(2, -1.5, 16, 3);
    ctx.fillStyle = '#3df7ff';
    ctx.beginPath();
    ctx.arc(19, 0, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Spells
    for (let si = 0; si < engine.spells.length; si++) {
      const sp = engine.spells[si];
      ctx.fillStyle = sp.type === 'flame' ? '#ff6622' : '#3df7ff';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // In-game HUD
    const curM = getDistanceMeters();
    const stg = getStageForMeters(curM);

    ctx.fillStyle = 'rgba(10, 12, 20, 0.94)';
    ctx.fillRect(10, 10, 450, 80);
    ctx.strokeStyle = '#2d3552';
    ctx.strokeRect(10, 10, 450, 80);

    ctx.fillStyle = '#00ffea';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`EP #${engine.rlMeta.attempt} | DIST: ${curM}m (RECORD: ${engine.rlMeta.maxDistMeters}m)`, 16, 25);

    ctx.fillStyle = stg.color;
    ctx.fillText(`STAGE ${stg.id}: ${stg.name.toUpperCase()}`, 16, 40);

    ctx.fillStyle = '#ffd700';
    ctx.font = '10px monospace';
    const hzLabel = (engine.mppiHorizon || 36) === 36 ? '36 STEPS (2× TWICE HORIZON)' : `${engine.mppiHorizon || 36} STEPS`;
    ctx.fillText(`MPPI FORESIGHT: ${hzLabel} | CONES: ${engine.latestTelemetry.totalPaths}`, 16, 55);

    for (let hi = 0; hi < player.maxHp; hi++) {
      const ox = 16 + hi * 18,
        oy = 64;
      ctx.fillStyle = hi < player.hp ? '#e62e49' : '#2e222b';
      ctx.beginPath();
      ctx.arc(ox + 5, oy + 5, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#4eed84';
    ctx.font = '10px monospace';
    ctx.fillText(`CLEARS: ${engine.ep.hazardsCleared} | WRAITHS: ${engine.ep.ghostKills}`, 115, 71);
  };

  const drawCanvasesDirectly = () => {
    const engine = engineRef.current;

    // 1. Distance Chart
    const chart = chartCanvasRef.current;
    if (chart) {
      const cctx = chart.getContext('2d');
      if (cctx) {
        cctx.clearRect(0, 0, chart.width, chart.height);
        const histArr = engine.rlMeta.fullHistory;
        if (histArr.length > 1) {
          let maxD = 25;
          for (let mi = 0; mi < histArr.length; mi++) {
            const dVal = histArr[mi].recordDist || histArr[mi].dist || 0;
            if (dVal > maxD) maxD = dVal;
          }
          const padL = 26,
            padR = 6,
            padT = 6,
            padB = 14;
          const gw = chart.width - padL - padR,
            gh = chart.height - padT - padB;

          cctx.fillStyle = '#7a88a8';
          cctx.font = '8px monospace';
          cctx.fillText(Math.round(maxD) + 'm', 2, padT + 6);
          cctx.fillText('0m', 4, padT + gh);
          cctx.fillText('#1', padL, chart.height - 2);
          cctx.fillText('#' + histArr[histArr.length - 1].attempt, chart.width - 24, chart.height - 2);

          // Raw episode distance
          cctx.strokeStyle = 'rgba(0, 255, 234, 0.55)';
          cctx.lineWidth = 1.2;
          cctx.beginPath();
          for (let i1 = 0; i1 < histArr.length; i1++) {
            const cx1 = padL + (i1 / (histArr.length - 1)) * gw;
            const cy1 = padT + gh - (histArr[i1].dist / maxD) * gh;
            if (i1 === 0) cctx.moveTo(cx1, cy1);
            else cctx.lineTo(cx1, cy1);
          }
          cctx.stroke();

          // Rolling 10-episode average
          cctx.strokeStyle = '#4eed84';
          cctx.lineWidth = 1.6;
          cctx.beginPath();
          let sumWin = 0;
          const winSize = 10;
          for (let i2 = 0; i2 < histArr.length; i2++) {
            sumWin += histArr[i2].dist;
            if (i2 >= winSize) sumWin -= histArr[i2 - winSize].dist;
            const avgX = sumWin / Math.min(i2 + 1, winSize);
            const cx2 = padL + (i2 / (histArr.length - 1)) * gw;
            const cy2 = padT + gh - (avgX / maxD) * gh;
            if (i2 === 0) cctx.moveTo(cx2, cy2);
            else cctx.lineTo(cx2, cy2);
          }
          cctx.stroke();

          // All-time record
          cctx.strokeStyle = '#ffd700';
          cctx.lineWidth = 1.8;
          cctx.beginPath();
          let rMax = 0;
          for (let i3 = 0; i3 < histArr.length; i3++) {
            if (histArr[i3].dist > rMax) rMax = histArr[i3].dist;
            const cx3 = padL + (i3 / (histArr.length - 1)) * gw;
            const cy3 = padT + gh - (rMax / maxD) * gh;
            if (i3 === 0) cctx.moveTo(cx3, cy3);
            else cctx.lineTo(cx3, cy3);
          }
          cctx.stroke();
        }
      }
    }

    // 2. MPPI Trajectory / Neural Distribution Canvas
    const nnc = nnCanvasRef.current;
    if (nnc) {
      const nctx = nnc.getContext('2d');
      if (nctx) {
        nctx.clearRect(0, 0, nnc.width, nnc.height);

        // Draw active MPPI candidate trajectory score distribution
        const trajectories = engine.ep.mppiTrajectories;
        if (trajectories.length > 0) {
          const barW = (nnc.width - 20) / trajectories.length;
          for (let i = 0; i < trajectories.length; i++) {
            const tr = trajectories[i];
            const isOpt = tr === engine.ep.chosenTrajectory;
            const bx = 10 + i * barW;
            const normScore = Math.max(0.1, Math.min(1.0, (tr.score + 20000) / 40000));
            const bh = normScore * (nnc.height - 20);
            const by = nnc.height - 10 - bh;

            nctx.fillStyle = isOpt
              ? '#ffd700'
              : tr.isSafe
              ? 'rgba(0, 255, 234, 0.65)'
              : 'rgba(255, 82, 99, 0.4)';
            nctx.fillRect(bx, by, barW - 2, bh);
          }

          nctx.fillStyle = '#8c97b2';
          nctx.font = '8px monospace';
          nctx.fillText(`CANDIDATE TRAJECTORIES (${engine.latestTelemetry.safePaths}/${trajectories.length} SURVIVORS)`, 10, 10);
        }
      }
    }
  };

  // Main lifecycle loop (single mount, decoupled from React state)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RL_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          const engine = engineRef.current;
          engine.rlMeta.attempt = Math.max(1, Math.floor(Number(obj.attempt) || 1));
          engine.rlMeta.maxDistMeters = Math.max(0, Number(obj.maxDistMeters) || 0);
          engine.rlMeta.bestReward = obj.bestReward !== null && obj.bestReward !== undefined ? Number(obj.bestReward) || 0 : null;
          if (Array.isArray(obj.history)) engine.rlMeta.fullHistory = obj.history;
        }
      }
    } catch {
      // storage error
    }

    startNewAttempt();

    let animId: number;
    let uiSyncTimer = 0;

    const mainLoop = () => {
      const engine = engineRef.current;
      try {
        const now = Date.now();
        if (now - engine.lastSpsTime >= 1000) {
          engine.displayedSPS = engine.actualStepsThisSec;
          engine.actualStepsThisSec = 0;
          engine.lastSpsTime = now;
        }

        if (!engine.isPaused) {
          engine.frameCounter++;
          const spd = engine.simSpeed;
          if (spd <= 20) {
            for (let s = 0; s < spd; s++) stepPhysics();
          } else {
            const deadline = Date.now() + 12;
            let stepsRun = 0;
            while (stepsRun < spd && Date.now() < deadline) {
              for (let b = 0; b < 60 && stepsRun < spd; b++, stepsRun++) {
                stepPhysics();
              }
            }
          }
        }

        renderWorld();

        uiSyncTimer++;
        if (uiSyncTimer >= 8) {
          uiSyncTimer = 0;
          drawCanvasesDirectly();

          const curM = getDistanceMeters();
          const stg = getStageForMeters(curM);
          const curHz = engine.mppiHorizon || 36;

          let engineBadgeText = `MPPI (${curHz} STEPS / 2× FORESIGHT): ${engine.latestTelemetry.safePaths}/${engine.latestTelemetry.totalPaths} CONES`;
          if (engine.controlMode === 'hybrid') engineBadgeText = `HYBRID: NEURAL + MPPI (${curHz} STEPS)`;
          else if (engine.controlMode === 'ppo') engineBadgeText = `DEEP PPO NEURAL POLICY`;
          else if (engine.controlMode === 'teleop') engineBadgeText = `MANUAL HUMAN TELEOPERATION`;

          setUiState({
            engineText: `${engineBadgeText} (${engine.displayedSPS.toLocaleString()} SPS)`,
            isErr: false,
            attempt: engine.rlMeta.attempt,
            stageId: stg.id,
            stageName: stg.name,
            stageColor: stg.color,
            contextText: engine.latestTelemetry.contextText,
            criticVal: engine.latestTelemetry.criticVal,
            maxDistMeters: engine.rlMeta.maxDistMeters,
            currentDistMeters: curM,
            maxSector: engine.rlMeta.maxSector,
            bestReward: engine.rlMeta.bestReward !== null ? engine.rlMeta.bestReward : 0,
            sps: engine.displayedSPS,
            mppiSafePaths: engine.latestTelemetry.safePaths,
            mppiTotalCandidates: engine.latestTelemetry.totalPaths,
            mppiHorizon: curHz,
            distReward: Math.round(engine.ep.distReward),
            evadeReward: engine.ep.evadeReward,
            hazardsCleared: engine.ep.hazardsCleared,
            sectorReward: engine.ep.sectorReward,
            sectorsCleared: engine.ep.sectorsCleared,
            ghostReward: engine.ep.ghostReward,
            ghostKills: engine.ep.ghostKills,
            heartsBonus: engine.player.hp * 1000 + engine.ep.heartsKeptBonus,
            playerHp: engine.player.hp,
            netReturn: getNetReward(),
            currentAction: engine.latestTelemetry.currentAction,
            probs: [...engine.latestTelemetry.probs],
            historyList: engine.rlMeta.fullHistory.slice(-15).reverse(),
          });
        }
      } catch (err: any) {
        setUiState((prev) => ({
          ...prev,
          engineText: `RECOVERED: ${err.message}`,
          isErr: true,
        }));
        startNewAttempt();
      }
      animId = window.requestAnimationFrame(mainLoop);
    };

    animId = window.requestAnimationFrame(mainLoop);
    return () => window.cancelAnimationFrame(animId);
  }, []);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      engineRef.current.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) !== -1) {
        e.preventDefault();
      }
      if (e.code === 'KeyP') setIsPaused((prev) => !prev);
      if (e.code === 'KeyR') finishRollout('Manual Reset', false);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      engineRef.current.keys[e.code] = false;
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) engineRef.current.mouse.down = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    engineRef.current.mouse.x = (e.clientX - rect.left) * (canvas.width / rect.width);
    engineRef.current.mouse.y = (e.clientY - rect.top) * (canvas.height / rect.height);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) engineRef.current.mouse.down = true;
  };

  const handleWipeBrain = () => {
    try {
      window.localStorage.removeItem(RL_STORAGE_KEY);
    } catch {
      // storage error
    }
    const engine = engineRef.current;
    engine.rlMeta = {
      attempt: 1,
      bestReward: null,
      maxDistMeters: 0,
      maxSector: 1,
      fullHistory: [],
    };
    startNewAttempt();
  };

  const triggerDownload = (url: string, filename: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDownloadPNG = () => {
    const expCanvas = document.createElement('canvas');
    expCanvas.width = 1280;
    expCanvas.height = 700;
    const ectx = expCanvas.getContext('2d');
    if (!ectx) return;

    const meta = engineRef.current.rlMeta;
    ectx.fillStyle = '#070910';
    ectx.fillRect(0, 0, 1280, 700);
    ectx.fillStyle = '#ffd700';
    ectx.font = 'bold 22px monospace';
    ectx.fillText('SHIPIUS MAGOS: MPPI SUPERHUMAN TRAJECTORY PLANNER LOG', 50, 42);
    ectx.fillStyle = '#00ffea';
    ectx.font = '15px monospace';
    ectx.fillText(
      `Episodes: ${meta.fullHistory.length} | Max Record X: ${meta.maxDistMeters}m | Best Score: ${meta.bestReward || 0}`,
      50,
      72
    );

    const px = 90,
      py = 125,
      pw = 1130,
      ph = 500;
    ectx.strokeStyle = '#252c44';
    ectx.lineWidth = 2;
    ectx.strokeRect(px, py, pw, ph);

    const hist = meta.fullHistory;
    if (hist.length >= 2) {
      let maxD = 30;
      for (let m = 0; m < hist.length; m++) if (hist[m].dist > maxD) maxD = hist[m].dist;
      ectx.font = '12px monospace';
      for (let i = 0; i <= 5; i++) {
        const gy = py + (ph * i) / 5;
        ectx.strokeStyle = '#141929';
        ectx.beginPath();
        ectx.moveTo(px, gy);
        ectx.lineTo(px + pw, gy);
        ectx.stroke();
        ectx.fillStyle = '#8c97b2';
        ectx.fillText(((maxD * (5 - i)) / 5).toFixed(1) + 'm', 20, gy + 4);
      }
      ectx.strokeStyle = 'rgba(0, 255, 234, 0.55)';
      ectx.lineWidth = 1.8;
      ectx.beginPath();
      for (let j = 0; j < hist.length; j++) {
        const cx = px + (j / (hist.length - 1)) * pw;
        const cy = py + ph - (hist[j].dist / maxD) * ph;
        if (j === 0) ectx.moveTo(cx, cy);
        else ectx.lineTo(cx, cy);
      }
      ectx.stroke();
      ectx.strokeStyle = '#ffd700';
      ectx.lineWidth = 3;
      ectx.beginPath();
      let bestSoFar = 0;
      for (let k = 0; k < hist.length; k++) {
        if (hist[k].dist > bestSoFar) bestSoFar = hist[k].dist;
        const cxk = px + (k / (hist.length - 1)) * pw;
        const cyk = py + ph - (bestSoFar / maxD) * ph;
        if (k === 0) ectx.moveTo(cxk, cyk);
        else ectx.lineTo(cxk, cyk);
      }
      ectx.stroke();
    }
    triggerDownload(expCanvas.toDataURL('image/png'), `shipius_mppi_log_ep${meta.attempt}.png`);
  };

  const handleDownloadCSV = () => {
    const hist = engineRef.current.rlMeta.fullHistory;
    const headers = ['Episode,Stage,MaxX_Meters,RecordMaxX_Meters,FinalScore,Sectors,Evades,Ghosts,Cause'];
    const rows = hist.map((h) =>
      [h.attempt, h.stage, h.dist, h.recordDist || h.dist, h.reward, h.sectors, h.evades, h.ghosts, h.cause].join(',')
    );
    triggerDownload(
      URL.createObjectURL(new Blob([headers.concat(rows).join('\n')], { type: 'text/csv;charset=utf-8;' })),
      `shipius_mppi_log_ep${engineRef.current.rlMeta.attempt}.csv`
    );
  };

  const handleDownloadJSON = () => {
    const engine = engineRef.current;
    const serial = {
      attempt: engine.rlMeta.attempt,
      maxDistMeters: engine.rlMeta.maxDistMeters,
      bestReward: engine.rlMeta.bestReward,
      history: engine.rlMeta.fullHistory,
    };
    triggerDownload(
      URL.createObjectURL(new Blob([JSON.stringify(serial, null, 2)], { type: 'application/json' })),
      `shipius_mppi_log_ep${engine.rlMeta.attempt}.json`
    );
  };

  const handleUploadJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const obj = JSON.parse(evt.target?.result as string);
        if (obj && typeof obj === 'object') {
          const engine = engineRef.current;
          engine.rlMeta.attempt = Math.max(1, Math.floor(Number(obj.attempt) || 1));
          engine.rlMeta.maxDistMeters = Math.max(0, Number(obj.maxDistMeters) || 0);
          engine.rlMeta.bestReward = obj.bestReward !== null && obj.bestReward !== undefined ? Number(obj.bestReward) || 0 : null;
          if (Array.isArray(obj.history)) engine.rlMeta.fullHistory = obj.history;
          startNewAttempt();
        }
      } catch {
        // Parse error
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-[#05060a] text-[#e0e6ed] font-mono flex flex-col items-center justify-start p-2 select-none">
      {/* Top Header & Simulation Controls */}
      <header className="flex flex-wrap gap-2 mb-2 items-center justify-between w-full max-w-[1340px] bg-[#0d101b] px-3 py-2 border-2 border-[#252c44] rounded-lg shadow-xl">
        <div className="flex items-center gap-2 flex-wrap">
          <div
            className={`text-xs font-bold px-2.5 py-1 rounded border min-w-[250px] text-center tracking-wider transition-colors flex items-center justify-center gap-1.5 ${
              uiState.isErr
                ? 'bg-[#5a121b] text-[#ff7b89] border-[#8a2430]'
                : 'bg-[#0e2918] text-[#4eed84] border-[#28663e]'
            }`}
          >
            <Compass className="w-3.5 h-3.5 text-[#00ffea]" />
            <span>{uiState.engineText}</span>
          </div>

          {/* Brain Mode Switcher */}
          <div className="flex items-center gap-1 bg-[#080a12] p-1 rounded border border-[#252c44]">
            <button
              onClick={() => setControlMode('mppi')}
              className={`px-2.5 py-1 text-xs font-bold rounded flex items-center gap-1 cursor-pointer transition-colors ${
                controlMode === 'mppi'
                  ? 'bg-[#0e2918] text-[#4eed84] border border-[#28663e]'
                  : 'text-[#a4b0cc] hover:text-white'
              }`}
              title="Model Predictive Control (Superhuman physics rollouts)"
            >
              <Cpu className="w-3.5 h-3.5 text-[#4eed84]" />
              <span>MPPI (Superhuman)</span>
            </button>

            <button
              onClick={() => setControlMode('hybrid')}
              className={`px-2.5 py-1 text-xs font-bold rounded flex items-center gap-1 cursor-pointer transition-colors ${
                controlMode === 'hybrid'
                  ? 'bg-[#1a2d42] text-[#00ffea] border border-[#1a5c66]'
                  : 'text-[#a4b0cc] hover:text-white'
              }`}
              title="Neural policy with MPPI safety filter"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-[#00ffea]" />
              <span>Hybrid Shield</span>
            </button>

            <button
              onClick={() => setControlMode('ppo')}
              className={`px-2.5 py-1 text-xs font-bold rounded flex items-center gap-1 cursor-pointer transition-colors ${
                controlMode === 'ppo'
                  ? 'bg-[#4d3d10] text-[#ffd700] border border-[#ffd700]'
                  : 'text-[#a4b0cc] hover:text-white'
              }`}
              title="Pure Deep Neural Network policy"
            >
              <Brain className="w-3.5 h-3.5 text-[#ffd700]" />
              <span>Pure Neural</span>
            </button>

            <button
              onClick={() => setControlMode('teleop')}
              className={`px-2 py-1 text-xs font-bold rounded flex items-center gap-1 cursor-pointer transition-colors ${
                controlMode === 'teleop'
                  ? 'bg-[#2a1b38] text-[#e0aaff] border border-[#7b2cbf]'
                  : 'text-[#a4b0cc] hover:text-white'
              }`}
              title="Manual Teleoperation"
            >
              <User className="w-3.5 h-3.5" />
              <span>Teleop</span>
            </button>
          </div>

          <button
            onClick={() => setIsPaused(!isPaused)}
            className={`px-3 py-1 text-xs font-bold rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
              isPaused
                ? 'bg-[#1c422a] text-white border-[#4eed84]'
                : 'bg-[#141826] text-[#4eed84] border-[#2e3856] hover:bg-[#222942] hover:border-[#4eed84]'
            }`}
            title="Press P to pause/resume"
          >
            {isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isPaused ? 'RESUME' : 'PAUSE'}</span>
          </button>

          <button
            onClick={() => finishRollout('Manual Reset', false)}
            className="px-2.5 py-1 text-xs font-bold rounded border border-[#2e3856] bg-[#141826] text-[#9cb0d9] hover:bg-[#222942] hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
            title="Conclude current rollout"
          >
            <RotateCcw className="w-3 h-3" />
            <span>RESET</span>
          </button>
        </div>

        {/* Speed Controls */}
        <div className="flex items-center gap-1.5 bg-[#080a12] px-2.5 py-1 rounded border border-[#252c44]">
          <span className="text-[11px] text-[#00ffea] font-bold flex items-center gap-1">
            <Zap className="w-3 h-3 text-[#00ffea]" /> SPEED:
          </span>
          {[1, 10, 100, 1000, 10000, 100000].map((spd) => (
            <button
              key={spd}
              onClick={() => setSimSpeed(spd)}
              className={`px-2 py-0.5 text-[11px] font-bold rounded border transition-colors cursor-pointer ${
                simSpeed === spd
                  ? 'bg-[#1c422a] text-white border-[#4eed84]'
                  : 'bg-[#141826] text-[#a4b0cc] border-[#2e3856] hover:bg-[#222942] hover:text-[#4eed84]'
              }`}
            >
              {spd >= 1000 ? `${spd / 1000}k` : `${spd}x`}
            </button>
          ))}
          <span className="text-[11px] text-[#ffd700] min-w-[55px] text-right font-bold ml-1">
            {simSpeed.toLocaleString()}x
          </span>
        </div>

        {/* Export and Wipe Buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setSfxMuted(!sfxMuted)}
            className={`p-1.5 rounded border border-[#2e3856] text-xs transition-colors cursor-pointer ${
              sfxMuted ? 'bg-[#3d151d] text-[#ff7b89]' : 'bg-[#141826] text-[#4eed84] hover:bg-[#222942]'
            }`}
            title={sfxMuted ? 'Unmute SFX' : 'Mute SFX'}
          >
            {sfxMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={handleDownloadPNG}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#1a5c66] bg-[#0e2229] text-[#00ffea] hover:bg-[#163842] hover:border-[#00ffea] transition-colors flex items-center gap-1 cursor-pointer"
            title="Download visual progress graph as PNG"
          >
            <Download className="w-3 h-3" />
            <span>.PNG</span>
          </button>

          <button
            onClick={handleDownloadCSV}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#1a5c66] bg-[#0e2229] text-[#00ffea] hover:bg-[#163842] hover:border-[#00ffea] transition-colors flex items-center gap-1 cursor-pointer"
            title="Download rollout metrics table as CSV"
          >
            <Download className="w-3 h-3" />
            <span>.CSV</span>
          </button>

          <button
            onClick={handleDownloadJSON}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#1a5c66] bg-[#0e2229] text-[#00ffea] hover:bg-[#163842] hover:border-[#00ffea] transition-colors flex items-center gap-1 cursor-pointer"
            title="Export model log"
          >
            <Download className="w-3 h-3" />
            <span>Save</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#1a5c66] bg-[#0e2229] text-[#00ffea] hover:bg-[#163842] hover:border-[#00ffea] transition-colors flex items-center gap-1 cursor-pointer"
            title="Upload saved model log"
          >
            <Upload className="w-3 h-3" />
            <span>Load</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleUploadJSON}
            style={{ display: 'none' }}
          />

          <button
            onClick={handleWipeBrain}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#5c2630] text-[#ff5c6c] bg-[#141826] hover:bg-[#3d151d] hover:border-[#ff5c6c] transition-colors flex items-center gap-1 cursor-pointer"
            title="Reset simulation statistics"
          >
            <Trash2 className="w-3 h-3" />
            <span>Wipe</span>
          </button>

          <button
            onClick={() => setShowHelpModal(true)}
            className="p-1.5 rounded border border-[#2e3856] text-[#ffd700] bg-[#141826] hover:bg-[#222942] transition-colors cursor-pointer"
            title="Curriculum & MPPI Architecture Info"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* 4-STAGE CURRICULUM SELECTOR & TIMELINE */}
      <div className="w-full max-w-[1340px] mb-2 bg-[#0d101b] border-2 border-[#252c44] rounded-lg px-3 py-2 flex flex-col gap-1.5 shadow-md">
        <div className="flex justify-between items-center text-xs flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[#a4b0cc] font-semibold flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-[#00ffea]" /> 4-STAGE CURRICULUM:
            </span>
            <span
              className="font-bold px-2 py-0.5 rounded text-[11px]"
              style={{
                backgroundColor: CURRICULUM_STAGES[uiState.stageId - 1]?.accentBg,
                color: CURRICULUM_STAGES[uiState.stageId - 1]?.color,
                border: `1px solid ${CURRICULUM_STAGES[uiState.stageId - 1]?.border}`,
              }}
            >
              STAGE {uiState.stageId}: {CURRICULUM_STAGES[uiState.stageId - 1]?.name.toUpperCase()} (
              {CURRICULUM_STAGES[uiState.stageId - 1]?.range})
            </span>
          </div>

          {/* Curriculum Mode Switcher */}
          <div className="flex items-center gap-1 bg-[#080a12] p-1 rounded border border-[#1b2133] text-[10px]">
            <span className="text-[#8c97b2] mr-1 font-semibold">Curriculum:</span>
            <button
              onClick={() => {
                setStageLock(0);
                startNewAttempt();
              }}
              className={`px-2 py-0.5 rounded font-bold cursor-pointer transition-colors ${
                stageLock === 0
                  ? 'bg-[#1c422a] text-white border border-[#4eed84]'
                  : 'text-[#a4b0cc] hover:text-white'
              }`}
            >
              Auto Progressive (1-4)
            </button>
            {CURRICULUM_STAGES.map((st) => (
              <button
                key={st.id}
                onClick={() => {
                  setStageLock(st.id);
                  startNewAttempt();
                }}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer transition-colors ${
                  stageLock === st.id ? 'text-white border' : 'text-[#a4b0cc] hover:text-white'
                }`}
                style={{
                  backgroundColor: stageLock === st.id ? st.accentBg : 'transparent',
                  borderColor: stageLock === st.id ? st.color : 'transparent',
                  color: stageLock === st.id ? st.color : undefined,
                }}
              >
                Stage {st.id} ({st.shortName})
              </button>
            ))}
          </div>
        </div>

        {/* 4-Stage visual track cards */}
        <div className="grid grid-cols-4 gap-2 w-full bg-[#080a12] p-1.5 rounded border border-[#1d2336]">
          {CURRICULUM_STAGES.map((st) => {
            const isCompleted = uiState.currentDistMeters >= st.id * 1000;
            const isCurrent = uiState.stageId === st.id;
            return (
              <div
                key={st.id}
                className={`relative rounded p-2 transition-all border ${
                  isCurrent
                    ? 'border-[#00ffea] bg-[#0e2229] shadow-md'
                    : isCompleted
                    ? 'border-[#28663e] bg-[#0e2918]/60 opacity-85'
                    : 'border-[#1b2133] bg-[#0d101b]/50 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between text-[11px] mb-0.5">
                  <span className="font-bold flex items-center gap-1" style={{ color: st.color }}>
                    {isCompleted ? <CheckCircle2 className="w-3 h-3 text-[#4eed84]" /> : null}
                    Stage {st.id}: {st.shortName}
                  </span>
                  <span className="text-[10px] text-[#8c97b2]">{st.range}</span>
                </div>
                <div className="text-[9.5px] text-[#a4b0cc] truncate">{st.desc}</div>
                {isCurrent && (
                  <div className="w-full bg-[#141826] h-1.5 rounded-full mt-1.5 overflow-hidden border border-[#1b2133]">
                    <div
                      className="h-full bg-gradient-to-r from-[#00ffea] to-[#4eed84] transition-all duration-150"
                      style={{
                        width: `${Math.min(100, Math.max(5, ((uiState.currentDistMeters % 1000) / 1000) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main 3-Column Interface */}
      <main className="flex gap-2 items-start max-w-[1340px] w-full justify-center">
        {/* LEFT COLUMN: MPPI TRAJECTORY OPTIMIZER / CANDIDATES */}
        <section className="w-[320px] min-h-[520px] bg-[#0d101b] border-2 border-[#252c44] rounded-lg p-2.5 flex flex-col justify-between text-[11px] shrink-0 shadow-lg">
          <div>
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1 text-center flex items-center justify-center gap-1.5">
              <Compass className="w-3.5 h-3.5 text-[#00ffea]" />
              MPPI PREDICTIVE TRAJECTORY CONES
            </div>

            {/* Candidate Trajectory Score Canvas */}
            <canvas
              ref={nnCanvasRef}
              width={296}
              height={58}
              className="bg-[#080a10] border border-[#1d2336] rounded mb-1 block w-full"
            />

            {/* Prediction Horizon Selector (Twice steps / 2x lookahead) */}
            <div className="bg-[#080a12] p-1.5 rounded border border-[#1d2336] mb-1.5">
              <div className="flex justify-between items-center text-[10px] mb-1">
                <span className="text-[#ffd700] font-bold flex items-center gap-1">
                  <TrendingUp className="w-3 h-3 text-[#00ffea]" /> PREDICTION HORIZON:
                </span>
                <span className="font-bold px-1.5 py-0.5 rounded text-[9px] bg-[#1c422a] text-[#4eed84] border border-[#28663e]">
                  {mppiHorizon} Steps ({mppiHorizon === 36 ? '2× TWICE STEPS' : mppiHorizon >= 36 ? `${(mppiHorizon / 18).toFixed(1)}× Foresight` : '1× Base'})
                </span>
              </div>

              <div className="grid grid-cols-4 gap-1 mb-1">
                {[
                  { steps: 18, label: '18 (1×)' },
                  { steps: 36, label: '36 (2×)' },
                  { steps: 54, label: '54 (3×)' },
                  { steps: 72, label: '72 (4×)' },
                ].map((preset) => (
                  <button
                    key={preset.steps}
                    onClick={() => setMppiHorizon(preset.steps)}
                    className={`py-0.5 text-[9px] font-bold rounded border transition-colors cursor-pointer text-center ${
                      mppiHorizon === preset.steps
                        ? 'bg-[#00ffea] text-[#05060a] border-[#00ffea] shadow'
                        : 'bg-[#141826] text-[#a4b0cc] border-[#252c44] hover:bg-[#222942] hover:text-[#00ffea]'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-[#8c97b2]">Foresight:</span>
                <input
                  type="range"
                  min="12"
                  max="72"
                  step="2"
                  value={mppiHorizon}
                  onChange={(e) => setMppiHorizon(Number(e.target.value))}
                  className="flex-1 h-1 accent-[#00ffea] cursor-pointer"
                />
                <span className="text-[9px] font-mono text-[#00ffea] min-w-[26px] text-right font-bold">
                  {mppiHorizon}s
                </span>
              </div>
            </div>

            <div className="flex justify-between text-[9px] px-1 mb-1.5 font-mono">
              <span className="text-[#00ffea] flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#00ffea]" /> Safe: {uiState.mppiSafePaths}
              </span>
              <span className="text-[#ff5263] flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#ff5263]" /> Rejected: {uiState.mppiTotalCandidates - uiState.mppiSafePaths}
              </span>
              <span className="text-[#ffd700] font-bold">H: {uiState.mppiHorizon}s ({uiState.mppiHorizon === 36 ? '2×' : `${(uiState.mppiHorizon / 18).toFixed(1)}×`})</span>
            </div>

            {/* Controller Action Selection */}
            <div className="text-[#ffd700] text-[10.5px] font-bold border-b border-[#252c44] pb-0.5 mb-1 flex items-center justify-between">
              <span>EXECUTED CONTROL ACTION</span>
              <span className="text-[#4eed84] text-[10px]">Optimal: Act #{uiState.currentAction}</span>
            </div>

            <div className="space-y-1 mb-2">
              {ACTION_DEFS.map((act) => {
                const isActive = uiState.currentAction === act.id;
                return (
                  <div
                    key={act.id}
                    className={`flex justify-between items-center px-2 py-1 rounded transition-colors text-[9.5px] ${
                      isActive
                        ? 'bg-[#1c422a] border border-[#4eed84] text-white shadow'
                        : 'bg-[#080a12] border border-transparent text-[#a4b0cc]'
                    }`}
                  >
                    <span className="font-semibold flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          isActive ? 'bg-[#ffd700] animate-pulse' : 'bg-gray-600'
                        }`}
                      />
                      #{act.id} {act.name}
                    </span>
                    <span className={isActive ? 'font-bold text-[#4eed84]' : 'text-gray-400'}>
                      {act.desc}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Reward Function Sliders */}
          <div className="border-t border-[#252c44] pt-1">
            <div className="text-[#ffd700] text-[10.5px] font-bold border-b border-[#252c44] pb-0.5 mb-1 text-center flex items-center justify-center gap-1">
              <Sliders className="w-3 h-3 text-[#ffd700]" />
              PHYSICS & REWARD WEIGHTS
            </div>

            <div className="space-y-1 max-h-[125px] overflow-y-auto pr-1">
              <div className="bg-[#080a12] p-1 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[9.5px]">
                  <span className="text-[#00ffea]">+Vx Forward Tracking:</span>
                  <span className="font-bold text-[#00ffea]">+{rewardCfg.xDistPerMeter}</span>
                </div>
                <input
                  type="range"
                  min="500"
                  max="3500"
                  step="50"
                  value={rewardCfg.xDistPerMeter}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, xDistPerMeter: Number(e.target.value) }))
                  }
                  className="w-full h-1 accent-[#00ffea] cursor-pointer"
                />
              </div>

              <div className="bg-[#080a12] p-1 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[9.5px]">
                  <span className="text-[#4eed84]">Gap / Hazard Evade:</span>
                  <span className="font-bold text-[#4eed84]">+{rewardCfg.evadeReward}</span>
                </div>
                <input
                  type="range"
                  min="1000"
                  max="15000"
                  step="250"
                  value={rewardCfg.evadeReward}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, evadeReward: Number(e.target.value) }))
                  }
                  className="w-full h-1 accent-[#4eed84] cursor-pointer"
                />
              </div>

              <div className="bg-[#080a12] p-1 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[9.5px]">
                  <span className="text-[#ff5263]">Lethal Collision Penalty:</span>
                  <span className="font-bold text-[#ff5263]">-{rewardCfg.deathPenalty}</span>
                </div>
                <input
                  type="range"
                  min="20000"
                  max="150000"
                  step="5000"
                  value={rewardCfg.deathPenalty}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, deathPenalty: Number(e.target.value) }))
                  }
                  className="w-full h-1 accent-[#ff5263] cursor-pointer"
                />
              </div>
            </div>
          </div>
        </section>

        {/* CENTER COLUMN: CANVAS SIMULATION */}
        <div className="flex flex-col items-center">
          <div
            id="game-frame"
            className="relative shadow-2xl border-2 border-[#252c44] rounded-lg bg-[#0a0c14] overflow-hidden cursor-crosshair shrink-0"
          >
            <canvas
              ref={canvasRef}
              width={660}
              height={476}
              onMouseMove={handleCanvasMouseMove}
              onMouseDown={handleCanvasMouseDown}
              className="block image-pixelated"
            />
          </div>

          <div className="mt-1.5 text-[11px] text-[#98a3bd] text-center max-w-[660px] bg-[#0d101b] px-3 py-1 rounded border border-[#252c44] flex items-center justify-between">
            <span className="text-[#00ffea] font-bold flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-[#ffd700]" /> MPPI Foresight ({mppiHorizon} Steps / {mppiHorizon === 36 ? '2× Double' : `${(mppiHorizon / 18).toFixed(1)}×`}):
            </span>
            <span className="text-[#e0e6ed]">
              <span className="text-[#ffd700] font-bold">Gold</span> = Selected Path | <span className="text-[#00ffea]">Cyan</span> = Safe | <span className="text-[#ff5263]">Red</span> = Lethal
            </span>
          </div>
        </div>

        {/* RIGHT COLUMN: TELEMETRY & LIVE GRAPH */}
        <section className="w-[320px] h-[520px] bg-[#0d101b] border-2 border-[#252c44] rounded-lg p-2.5 flex flex-col justify-between text-[11px] shrink-0 shadow-lg">
          <div>
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1.5 text-center flex items-center justify-center gap-1">
              <Activity className="w-3.5 h-3.5 text-[#ffd700]" />
              TELEMETRY & TRAJECTORY STATUS
            </div>

            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Episode (Rollout #):</span>
                <span className="font-bold text-[#ffd700]">#{uiState.attempt}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Current Stage:</span>
                <span className="font-bold text-[#00ffea]">{uiState.stageName}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Planner Context:</span>
                <span className="font-bold text-[#4eed84]">{uiState.contextText}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Active Safety Ratio:</span>
                <span className="font-mono text-[#00ffea]">
                  {((uiState.mppiSafePaths / Math.max(1, uiState.mppiTotalCandidates)) * 100).toFixed(0)}% Clear
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>MAX RECORD X:</span>
                <span className="font-bold text-[#ffd700] text-xs">
                  {uiState.maxDistMeters}m (Sec {uiState.maxSector})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Physics Throughput:</span>
                <span className="font-bold text-[#00ffea]">{uiState.sps.toLocaleString()} SPS</span>
              </div>
            </div>
          </div>

          {/* Current Rollout Breakdown */}
          <div className="border-t border-[#252c44] pt-1.5">
            <div className="text-[#ffd700] text-[10.5px] font-bold border-b border-[#252c44] pb-0.5 mb-1 text-center flex items-center justify-center gap-1">
              <Award className="w-3 h-3 text-[#ffd700]" />
              LIVE ROLLOUT REWARDS
            </div>
            <div className="space-y-0.5 text-[9.5px]">
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Velocity Forward (+X):</span>
                <span className="font-bold text-[#00ffea]">+{uiState.distReward.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Hazards Cleared:</span>
                <span className="font-bold text-[#4eed84]">
                  +{uiState.evadeReward.toLocaleString()} ({uiState.hazardsCleared})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Portals Reached:</span>
                <span className="font-bold text-[#ffd700]">
                  +{uiState.sectorReward.toLocaleString()} ({uiState.sectorsCleared})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Wraiths Neutralized:</span>
                <span className="font-bold text-[#4eed84]">
                  +{uiState.ghostReward.toLocaleString()} ({uiState.ghostKills})
                </span>
              </div>
              <div className="flex justify-between text-white font-bold border-t border-[#252c44] pt-1 mt-1">
                <span>NET EPISODE RETURN:</span>
                <span className="text-[#00ffea] text-xs font-mono">{uiState.netReturn.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Training Graph & History */}
          <div className="border-t border-[#252c44] pt-1">
            <div className="text-[#ffd700] text-[10.5px] font-bold border-b border-[#252c44] pb-0.5 mb-1 text-center flex items-center justify-center gap-1">
              <BarChart3 className="w-3 h-3 text-[#ffd700]" />
              MAX X (m) VS EPISODES GRAPH
            </div>
            <canvas
              ref={chartCanvasRef}
              width={296}
              height={58}
              className="bg-[#080a10] border border-[#1d2336] rounded mb-1 w-full block"
            />
            <div className="h-[62px] overflow-y-auto bg-[#080a10] border border-[#1d2336] rounded p-1 text-[9px] leading-tight space-y-0.5 font-mono">
              {uiState.historyList.length === 0 ? (
                <div className="text-gray-500 italic text-center py-2">No rollouts completed yet</div>
              ) : (
                uiState.historyList.map((h, i) => (
                  <div key={i} className="text-[#a4b0cc]">
                    <span className="text-[#ffd700] font-bold">#{h.attempt}</span> [{h.stage}]: X:
                    <span className="text-[#00ffea] font-semibold">{h.dist}m</span> (Max:
                    {h.recordDist || h.dist}m) | <span className="text-[#ff5263]">{h.cause}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Guide & Architecture Modal */}
      {showHelpModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0d101b] border-2 border-[#252c44] rounded-xl max-w-2xl w-full p-5 text-xs text-[#a4b0cc] shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-[#252c44] pb-2">
              <h2 className="text-base font-bold text-[#ffd700] flex items-center gap-2">
                <Compass className="w-4 h-4 text-[#00ffea]" />
                MPPI Model Predictive Control & Hybrid Architecture
              </h2>
              <button
                onClick={() => setShowHelpModal(false)}
                className="text-gray-400 hover:text-white text-base px-2 py-0.5 font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-2">
              <div>
                <h3 className="text-[#00ffea] font-bold mb-1">How MPPI Trajectory Planning Works (2× Foresight Window)</h3>
                <p className="leading-relaxed">
                  <b>Model Predictive Path Integral (MPPI) Control</b> predicts forward in time (default <b>36 steps / 2× horizon</b>, configurable from 18 to 72 steps) using the game's actual kinematic physics engine. Any candidate path that intersects lava, spikes, or wraiths is instantly rejected (marked with red collision dots). The path reaching furthest forward without hazard intersection is selected and highlighted in gold.
                </p>
              </div>

              <div>
                <h3 className="text-[#4eed84] font-bold mb-1">Available Brain Modes</h3>
                <ul className="list-disc pl-5 mt-1 space-y-1 text-[#e0e6ed]">
                  <li>
                    <b className="text-[#4eed84]">MPPI (Superhuman):</b> Pure Model Predictive Control. Flawless obstacle clearance from Episode #1 with zero training delay.
                  </li>
                  <li>
                    <b className="text-[#00ffea]">Hybrid Shield:</b> Neural Network proposes high-level choices; MPPI trajectory planner verifies safety and overrules any suicide action.
                  </li>
                  <li>
                    <b className="text-[#ffd700]">Pure Neural:</b> Deep Actor-Critic MLP policy trained with trial-and-error.
                  </li>
                  <li>
                    <b className="text-[#e0aaff]">Teleop:</b> Manual human keyboard controls.
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-white font-bold mb-1">Curriculum Stages</h3>
                <ul className="list-disc pl-5 mt-1 space-y-1 text-[#e0e6ed]">
                  {CURRICULUM_STAGES.map((s) => (
                    <li key={s.id}>
                      <b style={{ color: s.color }}>Stage {s.id}: {s.name} ({s.range}):</b> {s.desc}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="pt-2 border-t border-[#252c44] flex justify-end">
              <button
                onClick={() => setShowHelpModal(false)}
                className="px-4 py-1.5 bg-[#1c422a] hover:bg-[#28663e] text-white font-bold rounded border border-[#4eed84] cursor-pointer"
              >
                Close & Resume Simulation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

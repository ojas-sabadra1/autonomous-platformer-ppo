/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Bot,
  User,
  RotateCcw,
  Download,
  Upload,
  Trash2,
  Volume2,
  VolumeX,
  Activity,
  Award,
  Zap,
  Target,
  Shield,
  HelpCircle,
  BarChart3,
  Flame,
  ChevronRight,
  Sparkles
} from 'lucide-react';

// ===========================================================================
// CONSTANTS & TYPES
// ===========================================================================
const TILE = 28;
const MAP_ROWS = 17;
const SECTOR_COLS = 34;
const NUM_ACTIONS = 6;
const NUM_FEATURES = 8;
const RL_STORAGE_KEY = 'shipius_curriculum_ppo_v38';

interface RewardConfig {
  xDistPerMeter: number;
  backPenaltyPerMeter: number;
  heartLostPenalty: number;
  deathPenalty: number;
  evadeReward: number;
  sectorClear: number;
  ghostKill: number;
  bulletCost: number;
  coinReward: number;
}

interface EpisodeHistoryItem {
  attempt: number;
  dist: number;
  recordDist: number;
  reward: number;
  peakScore: number;
  sectors: number;
  evades: number;
  ghosts: number;
  coins: number;
  bullets: number;
  hpLost: number;
  frames: number;
  cause: string;
}

interface RLBrainState {
  attempt: number;
  bestReward: number | null;
  maxDistMeters: number;
  maxSector: number;
  actorWeights: number[][];
  eliteActorWeights: number[][];
  criticWeights: number[];
  latentActorLogits: Record<string, number[]>;
  latentCriticV: Record<string, number>;
  latentActionAdv: Record<string, number[]>;
  latentCounts: Record<string, number[]>;
  lastProbs: number[];
  lastAdv: number[];
  lastCriticVal: number;
  activeContextText: string;
  activeStageText: string;
  currentSeedStr: string;
  fullHistory: EpisodeHistoryItem[];
}

function createZeroMatrix(): number[][] {
  const mat: number[][] = [];
  for (let a = 0; a < NUM_ACTIONS; a++) {
    mat.push([0, 0, 0, 0, 0, 0, 0, 0]);
  }
  return mat;
}

function cloneMatrix(mat: number[][]): number[][] {
  const out: number[][] = [];
  for (let a = 0; a < NUM_ACTIONS; a++) {
    const row: number[] = [];
    for (let f = 0; f < NUM_FEATURES; f++) {
      row.push(mat && mat[a] ? (Number(mat[a][f]) || 0) : 0);
    }
    out.push(row);
  }
  return out;
}

const ACTION_LABELS = [
  { id: 0, name: 'Act #0 (Left)', desc: 'Move Backward' },
  { id: 1, name: 'Act #1 (Right)', desc: 'Advance Forward' },
  { id: 2, name: 'Act #2 (Jump)', desc: 'Vertical Leap' },
  { id: 3, name: 'Act #3 (Leap+R)', desc: 'Forward Gap Clearance' },
  { id: 4, name: 'Act #4 (Climb/E)', desc: 'Ladder Climb / Interact' },
  { id: 5, name: 'Act #5 (Fire+R)', desc: 'Offensive Threat Blast' },
];

const CURRICULUM_STAGES = [
  { id: 1, name: 'Lava Pits', range: '0 – 1,000m', color: '#ff6622', desc: 'Isolate precision gap clearance over bubbling lava chasms.' },
  { id: 2, name: 'Floor Spikes', range: '1,000 – 2,000m', color: '#ff5263', desc: 'Timing precise bounding strides over razor spike clusters.' },
  { id: 3, name: 'Ladders & Platforms', range: '2,000 – 3,000m', color: '#4eed84', desc: 'Vertical navigation, chest loot recovery, and platform traversal.' },
  { id: 4, name: 'Dynamic Threats', range: '3,000 – 4,000m', color: '#00ffea', desc: 'Ranged spell targeting and evasion of patrolling wraiths.' },
  { id: 5, name: 'Combined Mastery', range: '4,000m+', color: '#ffd700', desc: 'Simultaneous multi-hazard terrain mastery at peak velocity.' },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Simulation Controls State
  const [aiEnabled, setAiEnabled] = useState<boolean>(true);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [simSpeed, setSimSpeed] = useState<number>(1);
  const [sfxMuted, setSfxMuted] = useState<boolean>(false);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);

  // Sliders State
  const [rewardCfg, setRewardCfg] = useState<RewardConfig>({
    xDistPerMeter: 1000,
    backPenaltyPerMeter: 1500,
    heartLostPenalty: 20000,
    deathPenalty: 65000,
    evadeReward: 6000,
    sectorClear: 25000,
    ghostKill: 2500,
    bulletCost: 800,
    coinReward: 1000,
  });

  // Telemetry state displayed in UI
  const [engineStatus, setEngineStatus] = useState<{ text: string; isErr: boolean }>({
    text: 'CURRICULUM PPO-GAE: READY',
    isErr: false,
  });
  const [telemetry, setTelemetry] = useState({
    attempt: 1,
    stageText: '1: LAVA ONLY (0-1km)',
    stageId: 1,
    contextText: 'FLAT RUNWAY',
    criticVal: 0,
    maxDistMeters: 0,
    currentDistMeters: 0,
    maxSector: 1,
    bestReward: 0,
    sps: 60,
    distReward: 0,
    evadeReward: 0,
    hazardsCleared: 0,
    sectorReward: 0,
    sectorsCleared: 0,
    ghostReward: 0,
    ghostKills: 0,
    coinReward: 0,
    coinsCollected: 0,
    heartsBonus: 5000,
    playerHp: 5,
    bulletPenalty: 0,
    bulletsFired: 0,
    damagePenalty: 0,
    heartsLost: 0,
    netReturn: 0,
    currentAction: 1,
    probs: [0.167, 0.167, 0.167, 0.167, 0.167, 0.167],
    adv: [0, 0, 0, 0, 0, 0],
  });

  const [historyList, setHistoryList] = useState<EpisodeHistoryItem[]>([]);

  // Simulation engine mutable refs
  const engineRef = useRef({
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
      speed: 3.6,
      jumpPower: 8.5,
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
      coinsCollected: 0,
      coinReward: 0,
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
      macroAction: null as number | null,
      macroTimer: 0,
      lastDecisionFeatures: null as number[] | null,
      lastDecisionKey: null as string | null,
      lastDecisionAction: null as number | null,
      lastDecisionProb: 0.167,
      lastDecisionX: 3 * TILE,
      stepRewardAccumulator: 0,
      rolloutBuffer: [] as any[],
      lidarRays: [] as { x2: number; y2: number; hazard: boolean }[],
      peakNetScoreThisRun: 0,
    },
    isConcluding: false,
    rlBrain: {
      attempt: 1,
      bestReward: null as number | null,
      maxDistMeters: 0,
      maxSector: 1,
      actorWeights: createZeroMatrix(),
      eliteActorWeights: createZeroMatrix(),
      criticWeights: [0, 0, 0, 0, 0, 0, 0, 0],
      latentActorLogits: {} as Record<string, number[]>,
      latentCriticV: {} as Record<string, number>,
      latentActionAdv: {} as Record<string, number[]>,
      latentCounts: {} as Record<string, number[]>,
      lastProbs: [0.167, 0.167, 0.167, 0.167, 0.167, 0.167],
      lastAdv: [0, 0, 0, 0, 0, 0],
      lastCriticVal: 0,
      activeContextText: 'FLAT RUNWAY',
      activeStageText: '1: LAVA ONLY (0-1km)',
      currentSeedStr: 'CUR-1',
      fullHistory: [] as EpisodeHistoryItem[],
    } as RLBrainState,
    mouse: { x: 340, y: 240, worldX: 340, worldY: 240, down: false },
    keys: {} as Record<string, boolean>,
    actualStepsThisSec: 0,
    displayedSPS: 60,
    lastSpsTime: Date.now(),
    frameCounter: 0,
    audioCtx: null as AudioContext | null,
    aiEnabled: true,
    isPaused: false,
    targetSimSpeed: 1,
    sfxMuted: false,
    rewardCfg: { ...rewardCfg },
  });

  // Sync state into ref
  useEffect(() => {
    engineRef.current.aiEnabled = aiEnabled;
  }, [aiEnabled]);

  useEffect(() => {
    engineRef.current.isPaused = isPaused;
  }, [isPaused]);

  useEffect(() => {
    engineRef.current.targetSimSpeed = simSpeed;
  }, [simSpeed]);

  useEffect(() => {
    engineRef.current.sfxMuted = sfxMuted;
  }, [sfxMuted]);

  useEffect(() => {
    engineRef.current.rewardCfg = { ...rewardCfg };
  }, [rewardCfg]);

  // Audio synthesizer helper
  const playTone = useCallback((freq: number, type: OscillatorType, dur: number, endFreq?: number, vol = 0.05) => {
    const engine = engineRef.current;
    if (engine.isPaused || engine.sfxMuted || engine.targetSimSpeed > 10) return;
    try {
      if (!engine.audioCtx) {
        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        engine.audioCtx = new AudioCtxClass();
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
      // Audio autoplay policy fallback
    }
  }, []);

  // Level & Curriculum Generation
  const getCurriculumStageForMeters = (meters: number) => {
    if (meters < 1000) return { id: 1, label: '1: LAVA ONLY (0-1km)' };
    if (meters < 2000) return { id: 2, label: '2: SPIKES ONLY (1-2km)' };
    if (meters < 3000) return { id: 3, label: '3: LADDERS (2-3km)' };
    if (meters < 4000) return { id: 4, label: '4: GHOSTS ONLY (3-4km)' };
    return { id: 5, label: '5: COMBINED MASTERY (4km+)' };
  };

  const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

  const pruneEntities = useCallback(() => {
    const engine = engineRef.current;
    if (!engine.player) return;
    const safeX = engine.player.x - 1200;
    engine.ghosts = engine.ghosts.filter((g) => g.x > safeX || g.hp > 0);
    engine.chests = engine.chests.filter((c) => c.x > safeX);
    engine.coins = engine.coins.filter((c) => c.x > safeX && !c.collected);
    engine.portals = engine.portals.filter((p) => p.c * TILE > safeX);
  }, []);

  const spawnRandomGhost = useCallback((minC: number, maxC: number, rowY: number) => {
    if (maxC <= minC + 1) return;
    const minPx = minC * TILE;
    const maxPx = maxC * TILE;
    const randStartPx = minPx + Math.random() * (maxPx - minPx);
    engineRef.current.ghosts.push({
      x: randStartPx,
      y: rowY * TILE,
      minX: minPx,
      maxX: maxPx,
      vx: 1.05 + Math.random() * 0.2,
      dir: Math.random() < 0.5 ? 1 : -1,
      hp: 2,
      maxHp: 2,
      bob: Math.random() * 6.28,
    });
  }, []);

  const appendCurriculumSector = useCallback(() => {
    const engine = engineRef.current;
    engine.generatedSectors++;
    const sIdx = engine.generatedSectors;
    const startC = engine.worldCols;
    const endC = startC + SECTOR_COLS;

    const sectorStartMeters = Math.max(0, (startC * TILE - 3 * TILE) / 12);
    const stageInfo = getCurriculumStageForMeters(sectorStartMeters);
    const stageId = stageInfo.id;

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
        obstacleType = Math.random() < 0.7 ? 'ladder' : 'lava';
      } else if (stageId === 4) {
        obstacleType = 'ghost_flat';
      } else {
        const roll = Math.random();
        if (roll < 0.3) obstacleType = 'lava';
        else if (roll < 0.58) obstacleType = 'spike';
        else if (roll < 0.8) obstacleType = 'ladder';
        else obstacleType = 'ghost_flat';
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
          curC += pitWidth + randInt(5, 7);
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
        curC += 1 + randInt(5, 7);
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
          curC += platLen + randInt(4, 6);
        } else {
          curC += 4;
        }
      } else if (obstacleType === 'ghost_flat') {
        const patrolLen = randInt(5, 7);
        if (curC + patrolLen < safeEndC) {
          spawnRandomGhost(curC, curC + patrolLen, 11);
          engine.coins.push({
            x: (curC + 2) * TILE + 6,
            y: 12 * TILE,
            collected: false,
            kind: 'coin',
          });
          curC += patrolLen + randInt(4, 6);
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
    pruneEntities();
  }, [pruneEntities, spawnRandomGhost]);

  const initWorld = useCallback(() => {
    const engine = engineRef.current;
    engine.grid = [];
    for (let r = 0; r < MAP_ROWS; r++) {
      engine.grid[r] = [];
    }
    engine.worldCols = 0;
    engine.generatedSectors = 0;
    engine.ghosts = [];
    engine.chests = [];
    engine.coins = [];
    engine.portals = [];
    engine.spells = [];
    engine.breadcrumbs = {};
    engine.rlBrain.currentSeedStr = 'CUR-' + randInt(100, 999);
    appendCurriculumSector();
    appendCurriculumSector();
    appendCurriculumSector();
  }, [appendCurriculumSector]);

  const startNewAttempt = useCallback(() => {
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
      speed: 3.6,
      jumpPower: 8.5,
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
      coinsCollected: 0,
      coinReward: 0,
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
      macroAction: null,
      macroTimer: 0,
      lastDecisionFeatures: null,
      lastDecisionKey: null,
      lastDecisionAction: null,
      lastDecisionProb: 0.167,
      lastDecisionX: engine.player.x,
      stepRewardAccumulator: 0,
      rolloutBuffer: [],
      lidarRays: [],
      peakNetScoreThisRun: 0,
    };
  }, [initWorld]);

  const getDistanceMeters = useCallback(() => {
    const engine = engineRef.current;
    if (!engine.player || !engine.ep) return 0;
    return Math.max(0, Number(((engine.ep.maxPxReached - engine.ep.startX) / 12).toFixed(1)));
  }, []);

  const getNetReward = useCallback(() => {
    const engine = engineRef.current;
    if (!engine.player || !engine.ep) return 0;
    return Math.round(
      engine.ep.distReward +
        engine.ep.sectorReward +
        engine.ep.ghostReward +
        engine.ep.evadeReward +
        engine.ep.coinReward +
        engine.ep.heartsKeptBonus +
        engine.player.hp * 1000 -
        engine.ep.bulletPenalty -
        engine.ep.damagePenalty -
        engine.ep.loopPenalty -
        engine.ep.deathPenalty
    );
  }, []);

  const ensureLatentCluster = useCallback((zKey: string) => {
    const brain = engineRef.current.rlBrain;
    if (!brain.latentActorLogits[zKey] || brain.latentActorLogits[zKey].length !== NUM_ACTIONS) {
      brain.latentActorLogits[zKey] = [0, 0, 0, 0, 0, 0];
    }
    if (typeof brain.latentCriticV[zKey] !== 'number' || !isFinite(brain.latentCriticV[zKey])) {
      brain.latentCriticV[zKey] = 0;
    }
    if (!brain.latentActionAdv[zKey] || brain.latentActionAdv[zKey].length !== NUM_ACTIONS) {
      brain.latentActionAdv[zKey] = [0, 0, 0, 0, 0, 0];
    }
    if (!brain.latentCounts[zKey] || brain.latentCounts[zKey].length !== NUM_ACTIONS) {
      brain.latentCounts[zKey] = [0, 0, 0, 0, 0, 0];
    }
  }, []);

  const evaluateCriticV = useCallback((features: number[], zKey: string) => {
    const brain = engineRef.current.rlBrain;
    ensureLatentCluster(zKey);
    let v = Number(brain.latentCriticV[zKey]) || 0;
    for (let f = 0; f < NUM_FEATURES; f++) {
      v += (Number(brain.criticWeights[f]) || 0) * (Number(features[f]) || 0);
    }
    return v;
  }, [ensureLatentCluster]);

  const evaluateActorDistribution = useCallback((features: number[], zKey: string) => {
    const brain = engineRef.current.rlBrain;
    ensureLatentCluster(zKey);
    const logits: number[] = [0, 0, 0, 0, 0, 0];
    let maxL = -Infinity;
    for (let a = 0; a < NUM_ACTIONS; a++) {
      let sum =
        (Number(brain.latentActorLogits[zKey][a]) || 0) * 2.5 +
        (Number(brain.latentActionAdv[zKey][a]) || 0) * 1.8;
      for (let f = 0; f < NUM_FEATURES; f++) {
        sum += (Number(brain.actorWeights[a][f]) || 0) * (Number(features[f]) || 0) * 0.35;
      }
      logits[a] = sum;
      if (sum > maxL) maxL = sum;
    }

    const exps: number[] = [0, 0, 0, 0, 0, 0];
    let sumExp = 0;
    for (let b = 0; b < NUM_ACTIONS; b++) {
      const e = Math.exp(Math.max(-20, Math.min(20, logits[b] - maxL)));
      exps[b] = e;
      sumExp += e;
    }
    const probs: number[] = [0, 0, 0, 0, 0, 0];
    for (let c = 0; c < NUM_ACTIONS; c++) {
      probs[c] = exps[c] / (sumExp || 1);
    }
    return { probs, logits };
  }, [ensureLatentCluster]);

  const recordAndStepUpdate = useCallback(
    (
      features: number[],
      zKey: string,
      actionIdx: number,
      oldProb: number,
      rawReward: number,
      nextFeatures: number[] | null,
      nextZKey: string | null
    ) => {
      const engine = engineRef.current;
      const brain = engine.rlBrain;
      if (!features || !zKey || actionIdx === null || actionIdx === undefined) return;
      ensureLatentCluster(zKey);

      const rScaled = Math.max(-28, Math.min(28, (Number(rawReward) || 0) / 280));
      const vNow = evaluateCriticV(features, zKey);
      const vNext = nextFeatures && nextZKey ? evaluateCriticV(nextFeatures, nextZKey) : 0;

      const gamma = 0.72;
      const delta = rScaled + gamma * vNext - vNow;

      const advNow = Number(brain.latentActionAdv[zKey][actionIdx]) || 0;
      brain.latentActionAdv[zKey][actionIdx] = Math.max(-65, Math.min(65, advNow + 0.28 * (rScaled - advNow)));

      brain.latentCriticV[zKey] = Math.max(-60, Math.min(60, (Number(brain.latentCriticV[zKey]) || 0) + 0.14 * delta));
      brain.latentActorLogits[zKey][actionIdx] = Math.max(
        -60,
        Math.min(60, (Number(brain.latentActorLogits[zKey][actionIdx]) || 0) + 0.22 * delta)
      );

      for (let f = 0; f < NUM_FEATURES; f++) {
        if (features[f] !== 0) {
          brain.criticWeights[f] = Math.max(
            -45,
            Math.min(45, (Number(brain.criticWeights[f]) || 0) + 0.04 * delta * features[f])
          );
          brain.actorWeights[actionIdx][f] = Math.max(
            -55,
            Math.min(55, (Number(brain.actorWeights[actionIdx][f]) || 0) + 0.06 * delta * features[f])
          );
        }
      }

      engine.ep.rolloutBuffer.push({
        features,
        zKey,
        action: actionIdx,
        oldProb: Math.max(0.01, Number(oldProb) || 0.167),
        reward: rScaled,
        vPred: vNow,
      });
      if (engine.ep.rolloutBuffer.length > 220) engine.ep.rolloutBuffer.shift();
    },
    [ensureLatentCluster, evaluateCriticV]
  );

  const runPPOClipEpoch = useCallback(() => {
    const engine = engineRef.current;
    const buf = engine.ep.rolloutBuffer;
    const n = buf.length;
    if (n === 0) return;

    const gamma = 0.75;
    const lam = 0.65;
    const clipEps = 0.2;
    let gae = 0;

    for (let i = n - 1; i >= 0; i--) {
      const step = buf[i];
      const nextV = i + 1 < n ? buf[i + 1].vPred : 0;
      const contextChanged = i + 1 < n && buf[i + 1].zKey !== step.zKey;
      const effLam = contextChanged ? 0.0 : lam;

      const delta = step.reward + gamma * nextV - step.vPred;
      gae = delta + gamma * effLam * gae;
      const adv = Math.max(-25, Math.min(25, gae));

      const curDist = evaluateActorDistribution(step.features, step.zKey);
      const newProb = Math.max(0.01, curDist.probs[step.action]);
      const ratio = newProb / step.oldProb;
      const clippedRatio = Math.max(1.0 - clipEps, Math.min(1.0 + clipEps, ratio));

      const effStep = ratio * adv <= clippedRatio * adv ? ratio * adv : clippedRatio * adv;
      const ppoLr = 0.08;

      engine.rlBrain.latentActorLogits[step.zKey][step.action] = Math.max(
        -60,
        Math.min(60, (Number(engine.rlBrain.latentActorLogits[step.zKey][step.action]) || 0) + ppoLr * effStep)
      );
    }
  }, [evaluateActorDistribution]);

  const saveRLBrain = useCallback(() => {
    try {
      const brain = engineRef.current.rlBrain;
      const copy = {
        attempt: brain.attempt,
        bestReward: brain.bestReward,
        maxDistMeters: brain.maxDistMeters,
        maxSector: brain.maxSector,
        actorWeights: brain.actorWeights,
        eliteActorWeights: brain.eliteActorWeights,
        criticWeights: brain.criticWeights,
        latentActorLogits: brain.latentActorLogits,
        latentCriticV: brain.latentCriticV,
        latentActionAdv: brain.latentActionAdv,
        latentCounts: brain.latentCounts,
        fullHistory: brain.fullHistory.slice(-400),
      };
      window.localStorage.setItem(RL_STORAGE_KEY, JSON.stringify(copy));
    } catch {
      // Storage quota or sandboxing
    }
  }, []);

  const concludeAttempt = useCallback(
    (cause: string, died: boolean) => {
      const engine = engineRef.current;
      if (engine.isConcluding) return;
      engine.isConcluding = true;

      const distM = getDistanceMeters();
      const cfg = engine.rewardCfg;

      if (died) {
        engine.ep.deathPenalty = cfg.deathPenalty;
        if (
          engine.ep.lastDecisionFeatures !== null &&
          engine.ep.lastDecisionKey !== null &&
          engine.ep.lastDecisionAction !== null
        ) {
          recordAndStepUpdate(
            engine.ep.lastDecisionFeatures,
            engine.ep.lastDecisionKey,
            engine.ep.lastDecisionAction,
            engine.ep.lastDecisionProb,
            -cfg.deathPenalty * 0.55,
            null,
            null
          );
        }
      }

      runPPOClipEpoch();

      const finalScore = getNetReward();

      if (
        distM >= engine.rlBrain.maxDistMeters ||
        engine.rlBrain.bestReward === null ||
        engine.ep.peakNetScoreThisRun >= engine.rlBrain.bestReward
      ) {
        engine.rlBrain.eliteActorWeights = cloneMatrix(engine.rlBrain.actorWeights);
      } else {
        for (let a = 0; a < NUM_ACTIONS; a++) {
          for (let f = 0; f < NUM_FEATURES; f++) {
            engine.rlBrain.actorWeights[a][f] =
              (Number(engine.rlBrain.actorWeights[a][f]) || 0) * 0.85 +
              (Number(engine.rlBrain.eliteActorWeights[a][f]) || 0) * 0.15;
          }
        }
      }

      if (distM > engine.rlBrain.maxDistMeters) engine.rlBrain.maxDistMeters = distM;
      if (engine.rlBrain.bestReward === null || engine.ep.peakNetScoreThisRun > engine.rlBrain.bestReward) {
        engine.rlBrain.bestReward = engine.ep.peakNetScoreThisRun;
      }
      if (engine.player.sector > engine.rlBrain.maxSector) {
        engine.rlBrain.maxSector = engine.player.sector;
      }

      const historyItem: EpisodeHistoryItem = {
        attempt: engine.rlBrain.attempt,
        dist: distM,
        recordDist: engine.rlBrain.maxDistMeters,
        reward: finalScore,
        peakScore: engine.ep.peakNetScoreThisRun,
        sectors: engine.ep.sectorsCleared,
        evades: engine.ep.hazardsCleared,
        ghosts: engine.ep.ghostKills,
        coins: engine.ep.coinsCollected,
        bullets: engine.ep.bulletsFired,
        hpLost: engine.ep.heartsLost,
        frames: engine.ep.framesAlive,
        cause: cause || 'Ended',
      };

      engine.rlBrain.fullHistory.push(historyItem);
      engine.rlBrain.attempt++;

      if (engine.rlBrain.attempt % 10 === 0 || engine.targetSimSpeed <= 100) {
        saveRLBrain();
      }

      startNewAttempt();
    },
    [getDistanceMeters, getNetReward, recordAndStepUpdate, runPPOClipEpoch, saveRLBrain, startNewAttempt]
  );

  // Heightmap Perception
  const getTile = useCallback((c: number, r: number) => {
    const engine = engineRef.current;
    if (r < 0 || r >= MAP_ROWS || c < 0) return '1';
    if (c >= engine.worldCols || !engine.grid[r]) return '.';
    return engine.grid[r][c] || '.';
  }, []);

  const isSolidWall = useCallback(
    (c: number, r: number) => {
      const t = getTile(c, r);
      return t === '1' || t === '2';
    },
    [getTile]
  );

  const isTopOfLadder = useCallback(
    (c: number, r: number) => {
      return getTile(c, r) === '3' && getTile(c, r - 1) !== '3';
    },
    [getTile]
  );

  const hasLineOfSight = useCallback(
    (x1: number, y1: number, x2: number, y2: number) => {
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 14);
      for (let i = 1; i < steps; i++) {
        const tx = x1 + ((x2 - x1) * i) / steps;
        const ty = y1 + ((y2 - y1) * i) / steps;
        if (isSolidWall(Math.floor(tx / TILE), Math.floor(ty / TILE))) return false;
      }
      return true;
    },
    [isSolidWall]
  );

  const extractMultiModalPerception = useCallback(() => {
    const engine = engineRef.current;
    const player = engine.player;
    const pCx = player.x + player.w / 2;
    const pCy = player.y + player.h / 2;
    const pCol = Math.floor(pCx / TILE);
    const pRow = Math.floor((player.y + player.h - 2) / TILE);

    const curMeters = Math.max(0, (player.x - engine.ep.startX) / 12);
    engine.rlBrain.activeStageText = getCurriculumStageForMeters(curMeters).label;

    const floorNext1 = getTile(pCol + 1, pRow + 1);
    const floorNext2 = getTile(pCol + 2, pRow + 1);
    const wallNext1 = getTile(pCol + 1, pRow);
    const wallNext2 = getTile(pCol + 2, pRow);

    const pitTakeoffNow = floorNext1 === '.' || floorNext1 === 'L' ? 1.0 : 0.0;
    const pitApproach = !pitTakeoffNow && (floorNext2 === '.' || floorNext2 === 'L') ? 1.0 : 0.0;
    const spikeTakeoffNow = wallNext1 === '4' || (wallNext2 === '4' && (player.x % TILE) > 12) ? 1.0 : 0.0;
    const ladderHere = getTile(pCol, pRow) === '3' || wallNext1 === '3' || isSolidWall(pCol + 1, pRow) ? 1.0 : 0.0;

    let nearestGhost: any = null;
    let nearestGDist = 999;
    for (let i = 0; i < engine.ghosts.length; i++) {
      const gh = engine.ghosts[i];
      if (gh.hp <= 0) continue;
      if (gh.x + 18 < player.x) continue;
      const gd = Math.hypot(gh.x + 14 - pCx, gh.y + 14 - pCy);
      if (gd < 195 && gd < nearestGDist && hasLineOfSight(pCx, pCy, gh.x + 14, gh.y + 14)) {
        nearestGDist = gd;
        nearestGhost = gh;
        engine.ep.aimAngle = Math.atan2(gh.y + 12 - pCy, gh.x + 14 - pCx);
      }
    }
    if (!nearestGhost) engine.ep.aimAngle = 0;

    engine.ep.lidarRays = [
      { x2: (pCol + 1.5) * TILE, y2: (pRow + 1.2) * TILE, hazard: pitTakeoffNow > 0 || spikeTakeoffNow > 0 },
      { x2: (pCol + 2.5) * TILE, y2: (pRow + 1.2) * TILE, hazard: pitApproach > 0 },
    ];
    if (nearestGhost) {
      engine.ep.lidarRays.push({ x2: nearestGhost.x + 14, y2: nearestGhost.y + 14, hazard: true });
    }

    const visitsHere = engine.breadcrumbs[pCol + ',' + pRow] || 0;
    const isStuckHere = visitsHere >= 3 ? 1.0 : 0.0;

    const ghostClose = nearestGhost && nearestGDist < 78 ? 1.0 : 0.0;
    const ghostMed = nearestGhost && nearestGDist >= 78 ? 1.0 : 0.0;

    const isFlatClear =
      !pitTakeoffNow &&
      !pitApproach &&
      !spikeTakeoffNow &&
      !ladderHere &&
      !ghostClose &&
      !ghostMed &&
      !isStuckHere
        ? 1.0
        : 0.0;

    let contextLabel = 'FLAT RUNWAY';
    if (pitTakeoffNow) contextLabel = 'GAP TAKEOFF SCAN';
    else if (spikeTakeoffNow) contextLabel = 'SPIKE LIDAR SCAN';
    else if (ghostClose) contextLabel = 'THREAT PROXIMITY';
    else if (ghostMed) contextLabel = 'THREAT IN CONE';
    else if (pitApproach) contextLabel = 'GAP FAR SCAN';
    else if (ladderHere) contextLabel = 'STEP / LADDER';
    else if (isStuckHere) contextLabel = 'STALL RECOVERY';

    const fArray = [
      isFlatClear,
      pitTakeoffNow,
      pitApproach,
      spikeTakeoffNow,
      ladderHere,
      ghostMed,
      ghostClose,
      isStuckHere,
    ];

    return {
      fArray,
      zKey: fArray.join(''),
      contextLabel,
      pCol,
      pRow,
      visitsHere,
    };
  }, [getTile, hasLineOfSight, isSolidWall]);

  const stepRoboticsAgent = useCallback(() => {
    const engine = engineRef.current;
    const ctxData = extractMultiModalPerception();
    const features = ctxData.fArray;
    const zKey = ctxData.zKey;
    const pCol = ctxData.pCol;
    const pRow = ctxData.pRow;
    const visitsHere = ctxData.visitsHere;
    engine.rlBrain.activeContextText = ctxData.contextLabel;

    const bKey = pCol + ',' + pRow;
    if (engine.ep.framesAlive % 5 === 0) {
      engine.breadcrumbs[bKey] = (engine.breadcrumbs[bKey] || 0) + 1;
    }

    // 1. HUMAN DEMONSTRATION MODE
    if (!engine.aiEnabled) {
      engine.rlBrain.activeContextText = 'HUMAN TELEOP';
      const hLeft = Boolean(engine.keys['KeyA'] || engine.keys['ArrowLeft']);
      const hRight = Boolean(engine.keys['KeyD'] || engine.keys['ArrowRight']);
      const hUp = Boolean(engine.keys['KeyW'] || engine.keys['ArrowUp']);
      const hDown = Boolean(engine.keys['KeyS'] || engine.keys['ArrowDown']);
      const hJump = Boolean(engine.keys['Space'] || (hUp && !engine.player.onLadder));
      const hInteract = Boolean(engine.keys['KeyE']);
      const hShoot = Boolean(engine.mouse.down || engine.keys['KeyJ'] || engine.keys['KeyZ']);

      let humanAct: number | null = null;
      if (hRight && hJump) humanAct = 3;
      else if (hUp && hRight) humanAct = 4;
      else if (hJump) humanAct = 2;
      else if (hShoot) humanAct = 5;
      else if (hRight) humanAct = 1;
      else if (hLeft) humanAct = 0;

      if (humanAct !== null && (engine.player.onGround || engine.player.onLadder)) {
        ensureLatentCluster(zKey);
        engine.rlBrain.latentCounts[zKey][humanAct] += 3;
        recordAndStepUpdate(features, zKey, humanAct, 0.5, +950, features, zKey);
      }

      return {
        left: hLeft,
        right: hRight,
        up: hUp,
        down: hDown,
        jump: hJump,
        interact: hInteract,
        shoot: hShoot,
      };
    }

    // 2. AUTONOMOUS ROBOTICS CONTROLLER (WIN-STAY, LOSE-SHIFT SATISFICING + PPO-GAE)
    if (engine.player.onGround || engine.player.onLadder) {
      if (
        engine.ep.lastDecisionFeatures !== null &&
        engine.ep.lastDecisionKey !== null &&
        engine.ep.lastDecisionAction !== null
      ) {
        const dx = engine.player.x - engine.ep.lastDecisionX;
        const stallPenalty = Math.abs(dx) < 0.4 && visitsHere >= 3 ? -(visitsHere * 240) : 0;
        if (stallPenalty < 0) engine.ep.loopPenalty += Math.abs(stallPenalty);

        const velTrackingReward = dx * 100 + engine.ep.stepRewardAccumulator + stallPenalty;
        recordAndStepUpdate(
          engine.ep.lastDecisionFeatures,
          engine.ep.lastDecisionKey,
          engine.ep.lastDecisionAction,
          engine.ep.lastDecisionProb,
          velTrackingReward,
          features,
          zKey
        );
      }

      engine.ep.stepRewardAccumulator = 0;
      engine.ep.lastDecisionX = engine.player.x;

      ensureLatentCluster(zKey);
      const distObj = evaluateActorDistribution(features, zKey);
      engine.rlBrain.lastProbs = distObj.probs;
      engine.rlBrain.lastAdv = engine.rlBrain.latentActionAdv[zKey];
      engine.rlBrain.lastCriticVal = evaluateCriticV(features, zKey);

      const counts = engine.rlBrain.latentCounts[zKey];
      const advArr = engine.rlBrain.latentActionAdv[zKey];
      let chosenAct = 1;
      const immediateDanger = features[1] === 1 || features[3] === 1 || features[6] === 1;

      if (engine.ep.macroTimer > 0 && !immediateDanger) {
        engine.ep.macroTimer--;
        chosenAct = engine.ep.macroAction!;
      } else {
        engine.ep.macroTimer = 0;

        // WIN-STAY SATISFICING RULE:
        let hasProvenWinner = false;
        let bestProvenAct = 0;
        let bestProvenAdv = -Infinity;
        for (let w = 0; w < NUM_ACTIONS; w++) {
          if (counts[w] > 0 && advArr[w] > 1.5 && advArr[w] > bestProvenAdv) {
            hasProvenWinner = true;
            bestProvenAdv = advArr[w];
            bestProvenAct = w;
          }
        }

        if (hasProvenWinner && visitsHere < 3) {
          chosenAct = bestProvenAct;
        } else {
          let bestScore = -Infinity;
          for (let a = 0; a < NUM_ACTIONS; a++) {
            const nA = counts[a];
            let probeBonus = 0;
            if (nA === 0) {
              probeBonus = 12.0 + Math.random() * 0.5;
            } else if (visitsHere >= 3) {
              probeBonus = a === engine.ep.currentAction ? -35.0 : 10.0 / Math.sqrt(nA);
            }

            const combinedScore = distObj.logits[a] + probeBonus;
            if (combinedScore > bestScore) {
              bestScore = combinedScore;
              chosenAct = a;
            }
          }
        }

        counts[chosenAct]++;

        if (visitsHere >= 3 && chosenAct !== engine.ep.currentAction) {
          engine.ep.macroAction = chosenAct;
          engine.ep.macroTimer = 10;
        }
      }

      engine.ep.lastDecisionFeatures = features;
      engine.ep.lastDecisionKey = zKey;
      engine.ep.lastDecisionAction = chosenAct;
      engine.ep.lastDecisionProb = distObj.probs[chosenAct];
      engine.ep.currentAction = chosenAct;
    } else {
      if (engine.ep.currentAction === 2 || engine.ep.currentAction === 3) {
        engine.ep.currentAction = 3;
      }
    }

    const act = {
      left: false,
      right: false,
      up: false,
      down: false,
      jump: false,
      interact: false,
      shoot: false,
    };
    switch (engine.ep.currentAction) {
      case 0:
        act.left = true;
        break;
      case 1:
        act.right = true;
        break;
      case 2:
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
  }, [
    ensureLatentCluster,
    evaluateActorDistribution,
    evaluateCriticV,
    extractMultiModalPerception,
    recordAndStepUpdate,
  ]);

  const fireSpell = useCallback(
    (targetX: number, targetY: number) => {
      const engine = engineRef.current;
      const player = engine.player;
      if (player.castCd > 0 || player.mana < 5) return;
      player.mana -= 5;
      player.castCd = 14;

      const cfg = engine.rewardCfg;
      engine.ep.bulletsFired++;
      engine.ep.bulletPenalty += cfg.bulletCost;
      engine.ep.stepRewardAccumulator -= cfg.bulletCost;
      playTone(540, 'triangle', 0.1, 180, 0.05);

      const ox = player.x + player.w / 2;
      const oy = player.y + player.h / 2 - 2;
      const ang = Math.atan2(targetY - oy, targetX - ox);
      player.aimAngle = ang;
      player.facing = Math.cos(ang) >= 0 ? 1 : -1;

      const spd = player.weapon === 'crimson' ? 9.2 : 8.2;
      engine.spells.push({
        x: ox + Math.cos(ang) * 10,
        y: oy + Math.sin(ang) * 10,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        dmg: player.weapon === 'crimson' ? 2 : 1,
        type: player.weapon === 'crimson' ? 'flame' : 'arcane',
        life: 50,
      });
    },
    [playTone]
  );

  const applyHeavyHeartLoss = useCallback(
    (heartsLostCount: number) => {
      const engine = engineRef.current;
      engine.player.hp -= heartsLostCount;
      engine.ep.heartsLost += heartsLostCount;
      const pen = heartsLostCount * engine.rewardCfg.heartLostPenalty;
      engine.ep.damagePenalty += pen;
      engine.ep.stepRewardAccumulator -= pen;
      playTone(120, 'sawtooth', 0.18, 40, 0.12);
    },
    [playTone]
  );

  const stepPhysics = useCallback(() => {
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
    const aiAct = stepRoboticsAgent();
    const inLeft = aiAct.left,
      inRight = aiAct.right,
      inUp = aiAct.up,
      inDown = aiAct.down,
      inJump = aiAct.jump,
      inInteract = aiAct.interact;

    if (aiAct.shoot) {
      const pCx = player.x + player.w / 2,
        pCy = player.y + player.h / 2;
      const aimX = engine.aiEnabled ? pCx + Math.cos(engine.ep.aimAngle) * 120 : engine.mouse.worldX;
      const aimY = engine.aiEnabled ? pCy + Math.sin(engine.ep.aimAngle) * 120 : engine.mouse.worldY;
      fireSpell(aimX, aimY);
    }

    const centerC = Math.floor((player.x + player.w / 2) / TILE);
    const bodyR = Math.floor((player.y + player.h / 2) / TILE);
    const feetR = Math.floor((player.y + player.h - 1) / TILE);
    const belowFeetR = Math.floor((player.y + player.h + 4) / TILE);

    const inLad = getTile(centerC, bodyR) === '3' || getTile(centerC, feetR) === '3';
    const onLadTop = isTopOfLadder(centerC, belowFeetR);

    if (inLad && (inUp || inDown)) {
      player.onLadder = true;
      player.x += (centerC * TILE + (TILE - player.w) / 2 - player.x) * 0.25;
    } else if (onLadTop && inDown) {
      player.onLadder = true;
      player.onGround = false;
      player.y += 5;
    }
    if (!inLad && !onLadTop) player.onLadder = false;

    let mx = 0;
    if (inLeft) {
      mx -= 1;
      player.facing = -1;
    }
    if (inRight) {
      mx += 1;
      player.facing = 1;
    }
    player.vx = mx * player.speed;

    if (player.onGround) player.coyote = 8;
    else if (player.coyote > 0) player.coyote--;

    if (inJump && !player.onLadder) player.jumpBuf = 6;
    else if (player.jumpBuf > 0) player.jumpBuf--;

    if (player.onLadder) {
      player.vy = 0;
      if (inUp) player.vy = -player.speed * 0.92;
      if (inDown) player.vy = player.speed * 0.92;
      const topCheckR = Math.floor((player.y + player.h - 2) / TILE);
      if (inUp && getTile(centerC, topCheckR) !== '3' && isTopOfLadder(centerC, topCheckR + 1)) {
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

    if (player.vx > 0) {
      if (isSolidWall(rC, tR) || isSolidWall(rC, bR)) {
        player.x = rC * TILE - player.w - 0.05;
        player.vx = 0;
      }
    } else if (player.vx < 0) {
      if (isSolidWall(lC, tR) || isSolidWall(lC, bR)) {
        player.x = (lC + 1) * TILE + 0.05;
        player.vx = 0;
      }
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
      const ladFl = !inDown && (isTopOfLadder(lC, bR) || isTopOfLadder(rC, bR)) && prevBottom <= bR * TILE + 6;
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
          engine.ep.stepRewardAccumulator += cfg.evadeReward;
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

    if (player.x > engine.ep.maxPxReached) {
      const deltaMeters = (player.x - engine.ep.maxPxReached) / 12;
      engine.ep.maxPxReached = player.x;
      const fwdGain = deltaMeters * cfg.xDistPerMeter * (1 + getDistanceMeters() * 0.02);
      engine.ep.distReward += fwdGain;
      engine.ep.stepRewardAccumulator += fwdGain;
      engine.ep.stagnantFrames = 0;
      if (getDistanceMeters() > engine.rlBrain.maxDistMeters) {
        engine.rlBrain.maxDistMeters = getDistanceMeters();
      }
    } else if (player.x < prevX - 0.1) {
      const backMeters = (prevX - player.x) / 12;
      const backCost = backMeters * cfg.backPenaltyPerMeter;
      engine.ep.distReward -= backCost;
      engine.ep.stepRewardAccumulator -= backCost * 1.5;
    } else if (engine.aiEnabled) {
      engine.ep.stagnantFrames++;
      if (engine.ep.stagnantFrames > 420) {
        concludeAttempt('Stall / Loop', true);
        return;
      }
    }

    const liveScoreBeforeDeath = getNetReward();
    if (liveScoreBeforeDeath > engine.ep.peakNetScoreThisRun) {
      engine.ep.peakNetScoreThisRun = liveScoreBeforeDeath;
    }
    if (engine.rlBrain.bestReward === null || liveScoreBeforeDeath > engine.rlBrain.bestReward) {
      engine.rlBrain.bestReward = liveScoreBeforeDeath;
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
          concludeAttempt('Spikes', true);
          return;
        }
      }
    } else if (hz1 === 'L' || hz2 === 'L') {
      if (player.invuln === 0) {
        applyHeavyHeartLoss(2);
        player.invuln = 35;
        player.vy = -6.8;
        if (player.hp <= 0) {
          concludeAttempt('Lava', true);
          return;
        }
      }
    }

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
          engine.ep.stepRewardAccumulator += cfg.bulletCost * 1.5;
          engine.ep.stagnantFrames = 0;
          s.life = 0;
          if (gh.hp <= 0) {
            engine.ep.ghostKills++;
            engine.ep.ghostReward += cfg.ghostKill;
            engine.ep.stepRewardAccumulator += cfg.ghostKill;
            playTone(680, 'sine', 0.12, 1100, 0.06);
          }
          break;
        }
      }
      if (s.life <= 0) engine.spells.splice(i, 1);
    }

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
          concludeAttempt('Ghost', true);
          return;
        }
      }
    }

    if (inInteract) {
      engine.keys['KeyE'] = false;
      for (let ci = 0; ci < engine.chests.length; ci++) {
        const ch = engine.chests[ci];
        if (!ch.opened && Math.hypot(player.x + 9 - (ch.x + 14), player.y + 12 - (ch.y + 14)) < 32) {
          ch.opened = true;
          engine.ep.coinReward += cfg.coinReward;
          engine.ep.stepRewardAccumulator += cfg.coinReward;
          engine.ep.stagnantFrames = 0;
          if (ch.item === 'crimson') player.weapon = 'crimson';
        }
      }
    }

    for (let cIdx = 0; cIdx < engine.coins.length; cIdx++) {
      const cObj = engine.coins[cIdx];
      if (!cObj.collected && Math.hypot(player.x + 9 - (cObj.x + 8), player.y + 12 - (cObj.y + 8)) < 20) {
        cObj.collected = true;
        engine.ep.coinsCollected++;
        engine.ep.coinReward += cfg.coinReward;
        engine.ep.stepRewardAccumulator += cfg.coinReward;
        engine.ep.stagnantFrames = 0;
        playTone(820, 'sine', 0.06, 1200, 0.05);
      }
    }

    for (let pi = 0; pi < engine.portals.length; pi++) {
      const pt = engine.portals[pi];
      if (!pt.gemTaken && Math.hypot(player.x + 9 - (pt.gemX + 10), player.y + 12 - (pt.gemY + 10)) < 24) {
        pt.gemTaken = true;
        engine.ep.coinsCollected++;
        engine.ep.coinReward += cfg.coinReward * 2;
        engine.ep.stepRewardAccumulator += cfg.coinReward * 2;
        engine.ep.stagnantFrames = 0;
      }
      if (!pt.passed && centerC >= pt.c) {
        pt.passed = true;
        engine.ep.sectorsCleared++;
        player.sector = pt.sector + 1;
        if (player.sector > engine.rlBrain.maxSector) {
          engine.rlBrain.maxSector = player.sector;
        }
        engine.ep.sectorReward += cfg.sectorClear;
        engine.ep.heartsKeptBonus += player.hp * 1000;
        engine.ep.stepRewardAccumulator += cfg.sectorClear;
        engine.ep.stagnantFrames = 0;
      }
    }
  }, [
    appendCurriculumSector,
    applyHeavyHeartLoss,
    concludeAttempt,
    fireSpell,
    getDistanceMeters,
    getNetReward,
    getTile,
    isSolidWall,
    isTopOfLadder,
    playTone,
    stepRoboticsAgent,
  ]);

  // World Rendering
  const renderWorld = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const engine = engineRef.current;
    const player = engine.player;
    if (!player) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const camX = Math.max(0, player.x + player.w / 2 - canvas.width * 0.32);
    if (!engine.aiEnabled) {
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

        const vCount = engine.breadcrumbs[c + ',' + r] || 0;
        if (vCount > 0) {
          const alpha = Math.min(0.6, vCount * 0.1);
          ctx.fillStyle = vCount > 3 ? `rgba(255, 50, 120, ${alpha})` : `rgba(160, 80, 255, ${alpha})`;
          ctx.fillRect(c * TILE + 2, r * TILE + 2, TILE - 4, TILE - 4);
        }

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

    for (let i = 0; i < engine.chests.length; i++) {
      const ch = engine.chests[i];
      ctx.fillStyle = ch.opened ? '#5e4327' : '#9c6631';
      ctx.fillRect(ch.x + 4, ch.y + 10, 20, 18);
      ctx.strokeStyle = '#ffd700';
      ctx.strokeRect(ch.x + 4, ch.y + 10, 20, 18);
    }

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

    const pOx = player.x + player.w / 2;
    const pOy = player.y + player.h / 2 - 2;

    if (engine.aiEnabled && engine.ep.lidarRays) {
      ctx.save();
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      for (let lr = 0; lr < engine.ep.lidarRays.length; lr++) {
        const ray = engine.ep.lidarRays[lr];
        ctx.strokeStyle = ray.hazard ? 'rgba(255, 82, 99, 0.75)' : 'rgba(78, 237, 132, 0.45)';
        ctx.beginPath();
        ctx.moveTo(pOx, pOy);
        ctx.lineTo(ray.x2, ray.y2);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (engine.rlBrain.maxDistMeters > 0) {
      const recordPx = engine.ep.startX + engine.rlBrain.maxDistMeters * 12;
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
      ctx.fillText(`RECORD MAX-X: ${engine.rlBrain.maxDistMeters}m`, recordPx - 55, 42);
      ctx.restore();
    }

    const aimAngle = engine.aiEnabled
      ? engine.ep.aimAngle
      : Math.atan2(engine.mouse.worldY - pOy, engine.mouse.worldX - pOx);
    ctx.save();
    ctx.translate(pOx, player.y + player.h / 2);
    const face = Math.cos(aimAngle) >= 0 ? 1 : -1;
    ctx.scale(face, 1);
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

    for (let si = 0; si < engine.spells.length; si++) {
      const sp = engine.spells[si];
      ctx.fillStyle = sp.type === 'flame' ? '#ff6622' : '#3df7ff';
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Canvas overlay HUD
    ctx.fillStyle = 'rgba(10, 12, 20, 0.92)';
    ctx.fillRect(10, 10, 425, 72);
    ctx.strokeStyle = '#2d3552';
    ctx.strokeRect(10, 10, 425, 72);
    ctx.fillStyle = '#00ffea';
    ctx.font = 'bold 11.5px monospace';
    ctx.fillText(
      `EP #${engine.rlBrain.attempt} | X: ${getDistanceMeters()}m (MAX: ${engine.rlBrain.maxDistMeters}m)`,
      16,
      26
    );
    ctx.fillStyle = '#ffd700';
    ctx.fillText(
      `STAGE ${engine.rlBrain.activeStageText} | LIDAR: ${engine.rlBrain.activeContextText}`,
      16,
      42
    );

    for (let hi = 0; hi < player.maxHp; hi++) {
      const ox = 18 + hi * 20,
        oy = 50;
      ctx.fillStyle = hi < player.hp ? '#e62e49' : '#2e222b';
      ctx.beginPath();
      ctx.arc(ox + 6, oy + 6, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#4eed84';
    ctx.fillText(`CLEARS: ${engine.ep.hazardsCleared} | THREATS: ${engine.ep.ghostKills}`, 130, 60);
  }, [getDistanceMeters, getTile, isSolidWall, isTopOfLadder]);

  // Synchronize UI telemetry
  const updateAIPanelUI = useCallback(() => {
    const engine = engineRef.current;
    if (!engine.player || !engine.ep) return;

    const curDist = getDistanceMeters();
    const stageInfo = getCurriculumStageForMeters(curDist);

    setTelemetry({
      attempt: engine.rlBrain.attempt,
      stageText: engine.rlBrain.activeStageText,
      stageId: stageInfo.id,
      contextText: engine.rlBrain.activeContextText,
      criticVal: Number(engine.rlBrain.lastCriticVal) || 0,
      maxDistMeters: engine.rlBrain.maxDistMeters,
      currentDistMeters: curDist,
      maxSector: engine.rlBrain.maxSector,
      bestReward: engine.rlBrain.bestReward !== null ? engine.rlBrain.bestReward : 0,
      sps: engine.displayedSPS,
      distReward: Math.round(engine.ep.distReward),
      evadeReward: engine.ep.evadeReward,
      hazardsCleared: engine.ep.hazardsCleared,
      sectorReward: engine.ep.sectorReward,
      sectorsCleared: engine.ep.sectorsCleared,
      ghostReward: engine.ep.ghostReward,
      ghostKills: engine.ep.ghostKills,
      coinReward: engine.ep.coinReward,
      coinsCollected: engine.ep.coinsCollected,
      heartsBonus: engine.player.hp * 1000 + engine.ep.heartsKeptBonus,
      playerHp: engine.player.hp,
      bulletPenalty: engine.ep.bulletPenalty,
      bulletsFired: engine.ep.bulletsFired,
      damagePenalty: engine.ep.damagePenalty + engine.ep.loopPenalty,
      heartsLost: engine.ep.heartsLost,
      netReturn: getNetReward(),
      currentAction: engine.ep.currentAction,
      probs: [...engine.rlBrain.lastProbs],
      adv: [...engine.rlBrain.lastAdv],
    });

    setHistoryList(engine.rlBrain.fullHistory.slice(-15).reverse());

    // Render telemetry line chart
    const chart = chartCanvasRef.current;
    if (!chart) return;
    const cctx = chart.getContext('2d');
    if (!cctx) return;
    cctx.clearRect(0, 0, chart.width, chart.height);

    const histArr = engine.rlBrain.fullHistory;
    if (histArr.length > 1) {
      let maxD = 25;
      for (let mi = 0; mi < histArr.length; mi++) {
        const dVal = histArr[mi].recordDist || histArr[mi].dist || 0;
        if (dVal > maxD) maxD = dVal;
      }
      const padL = 28,
        padR = 8,
        padT = 6,
        padB = 14;
      const gw = chart.width - padL - padR,
        gh = chart.height - padT - padB;

      cctx.fillStyle = '#7a88a8';
      cctx.font = '8px monospace';
      cctx.fillText(Math.round(maxD) + 'm', 2, padT + 6);
      cctx.fillText('0m', 4, padT + gh);
      cctx.fillText('#1', padL, chart.height - 2);
      cctx.fillText('#' + histArr[histArr.length - 1].attempt, chart.width - 28, chart.height - 2);

      // Raw distance
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

      // Moving average
      cctx.strokeStyle = '#4eed84';
      cctx.lineWidth = 1.6;
      cctx.beginPath();
      let sumWindow = 0;
      const winSize = 10;
      for (let i2 = 0; i2 < histArr.length; i2++) {
        sumWindow += histArr[i2].dist;
        if (i2 >= winSize) sumWindow -= histArr[i2 - winSize].dist;
        const avgX = sumWindow / Math.min(i2 + 1, winSize);
        const cx2 = padL + (i2 / (histArr.length - 1)) * gw;
        const cy2 = padT + gh - (avgX / maxD) * gh;
        if (i2 === 0) cctx.moveTo(cx2, cy2);
        else cctx.lineTo(cx2, cy2);
      }
      cctx.stroke();

      // Peak record
      cctx.strokeStyle = '#ffd700';
      cctx.lineWidth = 1.8;
      cctx.beginPath();
      let runningMax = 0;
      for (let i3 = 0; i3 < histArr.length; i3++) {
        if (histArr[i3].dist > runningMax) runningMax = histArr[i3].dist;
        const cx3 = padL + (i3 / (histArr.length - 1)) * gw;
        const cy3 = padT + gh - (runningMax / maxD) * gh;
        if (i3 === 0) cctx.moveTo(cx3, cy3);
        else cctx.lineTo(cx3, cy3);
      }
      cctx.stroke();
    }
  }, [getDistanceMeters, getNetReward]);

  // Main simulation loop
  useEffect(() => {
    // Load existing brain from storage
    try {
      const raw = window.localStorage.getItem(RL_STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object') {
          const brain = engineRef.current.rlBrain;
          brain.attempt = Math.max(1, Math.floor(Number(obj.attempt) || 1));
          brain.bestReward = obj.bestReward !== null && obj.bestReward !== undefined ? Number(obj.bestReward) || 0 : null;
          brain.maxDistMeters = Math.max(0, Number(obj.maxDistMeters) || 0);
          brain.maxSector = Math.max(1, Math.floor(Number(obj.maxSector) || 1));
          if (Array.isArray(obj.actorWeights) && obj.actorWeights.length === NUM_ACTIONS) {
            brain.actorWeights = cloneMatrix(obj.actorWeights);
          }
          if (Array.isArray(obj.eliteActorWeights) && obj.eliteActorWeights.length === NUM_ACTIONS) {
            brain.eliteActorWeights = cloneMatrix(obj.eliteActorWeights);
          }
          if (Array.isArray(obj.criticWeights) && obj.criticWeights.length === NUM_FEATURES) {
            brain.criticWeights = obj.criticWeights.map((v: any) => Number(v) || 0);
          }
          if (obj.latentActorLogits) brain.latentActorLogits = obj.latentActorLogits;
          if (obj.latentCriticV) brain.latentCriticV = obj.latentCriticV;
          if (obj.latentActionAdv) brain.latentActionAdv = obj.latentActionAdv;
          if (obj.latentCounts) brain.latentCounts = obj.latentCounts;
          if (Array.isArray(obj.fullHistory)) {
            brain.fullHistory = obj.fullHistory.filter(
              (item: any) => item && typeof item === 'object' && isFinite(item.attempt) && isFinite(item.dist)
            );
          }
        }
      }
    } catch {
      // Ignore initial load failure
    }

    startNewAttempt();
    renderWorld();
    updateAIPanelUI();

    let animId: number;

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
          if (engine.frameCounter % 15 === 1) {
            setEngineStatus({
              text: `CURRICULUM PPO | FRAME #${engine.frameCounter} (${engine.displayedSPS.toLocaleString()} SPS)`,
              isErr: false,
            });
          }

          if (engine.targetSimSpeed <= 20) {
            for (let s = 0; s < engine.targetSimSpeed; s++) stepPhysics();
          } else {
            const deadline = Date.now() + 12;
            let stepsRun = 0;
            while (stepsRun < engine.targetSimSpeed && Date.now() < deadline) {
              for (let b = 0; b < 60 && stepsRun < engine.targetSimSpeed; b++, stepsRun++) {
                stepPhysics();
              }
            }
          }
        }
        renderWorld();
        if (engine.frameCounter % 5 === 0) updateAIPanelUI();
      } catch (err: any) {
        setEngineStatus({
          text: `RECOVERED: ${err.message}`,
          isErr: true,
        });
        startNewAttempt();
      }
      animId = window.requestAnimationFrame(mainLoop);
    };

    animId = window.requestAnimationFrame(mainLoop);
    return () => window.cancelAnimationFrame(animId);
  }, [renderWorld, startNewAttempt, stepPhysics, updateAIPanelUI]);

  // Keyboard and mouse event handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      engineRef.current.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) !== -1) {
        e.preventDefault();
      }
      if (e.code === 'KeyB') {
        setAiEnabled((prev) => !prev);
      }
      if (e.code === 'KeyP') {
        setIsPaused((prev) => !prev);
      }
      if (e.code === 'KeyR') {
        concludeAttempt('Manual Reset', false);
      }
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
  }, [concludeAttempt]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    engineRef.current.mouse.x = (e.clientX - rect.left) * (canvas.width / rect.width);
    engineRef.current.mouse.y = (e.clientY - rect.top) * (canvas.height / rect.height);
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 0) {
      engineRef.current.mouse.down = true;
    }
  };

  // Wipe Brain Handler
  const handleWipeBrain = () => {
    try {
      window.localStorage.removeItem(RL_STORAGE_KEY);
    } catch {
      // Storage error
    }
    const brain = engineRef.current.rlBrain;
    brain.attempt = 1;
    brain.bestReward = null;
    brain.maxDistMeters = 0;
    brain.maxSector = 1;
    brain.actorWeights = createZeroMatrix();
    brain.eliteActorWeights = createZeroMatrix();
    brain.criticWeights = [0, 0, 0, 0, 0, 0, 0, 0];
    brain.latentActorLogits = {};
    brain.latentCriticV = {};
    brain.latentActionAdv = {};
    brain.latentCounts = {};
    brain.lastProbs = [0.167, 0.167, 0.167, 0.167, 0.167, 0.167];
    brain.lastAdv = [0, 0, 0, 0, 0, 0];
    brain.lastCriticVal = 0;
    brain.activeContextText = 'FLAT RUNWAY';
    brain.activeStageText = '1: LAVA ONLY (0-1km)';
    brain.currentSeedStr = 'CUR-1';
    brain.fullHistory = [];
    startNewAttempt();
    updateAIPanelUI();
  };

  // Export Handlers
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

    const brain = engineRef.current.rlBrain;
    ectx.fillStyle = '#070910';
    ectx.fillRect(0, 0, 1280, 700);
    ectx.fillStyle = '#ffd700';
    ectx.font = 'bold 22px monospace';
    ectx.fillText('SHIPIUS MAGOS 5-STAGE CURRICULUM LAB: MAX X (m) VS. EPISODES', 50, 42);
    ectx.fillStyle = '#00ffea';
    ectx.font = '15px monospace';
    ectx.fillText(
      `Episodes: ${brain.fullHistory.length} | Record Max X: ${brain.maxDistMeters}m | Max Score: ${brain.bestReward !== null ? brain.bestReward : 0}`,
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

    const hist = brain.fullHistory;
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
    triggerDownload(expCanvas.toDataURL('image/png'), `shipius_curriculum_ppo_gen${brain.attempt}.png`);
  };

  const handleDownloadCSV = () => {
    const brain = engineRef.current.rlBrain;
    const headers = [
      'Episode,MaxX_Meters,RecordMaxX_Meters,PeakScore,FinalScore,SectorsCleared,ObstaclesCleared,GhostsKilled,CoinsCollected,BulletsFired,HeartsLost,FramesAlive,Cause',
    ];
    const rows: string[] = [];
    for (let i = 0; i < brain.fullHistory.length; i++) {
      const h = brain.fullHistory[i];
      rows.push(
        [
          h.attempt,
          h.dist,
          h.recordDist || h.dist,
          h.peakScore || h.reward,
          h.reward,
          h.sectors,
          h.evades || 0,
          h.ghosts,
          h.coins,
          h.bullets,
          h.hpLost,
          h.frames,
          h.cause,
        ].join(',')
      );
    }
    triggerDownload(
      URL.createObjectURL(new Blob([headers.concat(rows).join('\n')], { type: 'text/csv;charset=utf-8;' })),
      `shipius_curriculum_ppo_gen${brain.attempt}.csv`
    );
  };

  const handleDownloadJSON = () => {
    const brain = engineRef.current.rlBrain;
    triggerDownload(
      URL.createObjectURL(new Blob([JSON.stringify(brain, null, 2)], { type: 'application/json' })),
      `shipius_curriculum_ppo_gen${brain.attempt}.json`
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
          const brain = engineRef.current.rlBrain;
          brain.attempt = Math.max(1, Math.floor(Number(obj.attempt) || 1));
          brain.bestReward = obj.bestReward !== null && obj.bestReward !== undefined ? Number(obj.bestReward) || 0 : null;
          brain.maxDistMeters = Math.max(0, Number(obj.maxDistMeters) || 0);
          brain.maxSector = Math.max(1, Math.floor(Number(obj.maxSector) || 1));
          if (Array.isArray(obj.actorWeights) && obj.actorWeights.length === NUM_ACTIONS) {
            brain.actorWeights = cloneMatrix(obj.actorWeights);
          }
          if (Array.isArray(obj.eliteActorWeights) && obj.eliteActorWeights.length === NUM_ACTIONS) {
            brain.eliteActorWeights = cloneMatrix(obj.eliteActorWeights);
          }
          if (Array.isArray(obj.criticWeights) && obj.criticWeights.length === NUM_FEATURES) {
            brain.criticWeights = obj.criticWeights.map((v: any) => Number(v) || 0);
          }
          if (obj.latentActorLogits) brain.latentActorLogits = obj.latentActorLogits;
          if (obj.latentCriticV) brain.latentCriticV = obj.latentCriticV;
          if (obj.latentActionAdv) brain.latentActionAdv = obj.latentActionAdv;
          if (obj.latentCounts) brain.latentCounts = obj.latentCounts;
          if (Array.isArray(obj.fullHistory)) {
            brain.fullHistory = obj.fullHistory;
          }
          saveRLBrain();
          updateAIPanelUI();
          setEngineStatus({ text: `LOADED BRAIN #${brain.attempt}`, isErr: false });
        }
      } catch {
        setEngineStatus({ text: 'INVALID JSON FORMAT', isErr: true });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-[#05060a] text-[#e0e6ed] font-mono flex flex-col items-center justify-start p-2 select-none">
      {/* Top Controls Bar */}
      <header className="flex flex-wrap gap-2 mb-2 items-center justify-between w-full max-w-[1300px] bg-[#0d101b] px-3 py-2 border-2 border-[#252c44] rounded-lg shadow-xl">
        <div className="flex items-center gap-2 flex-wrap">
          <div
            className={`text-xs font-bold px-2.5 py-1 rounded border min-w-[240px] text-center tracking-wider transition-colors ${
              engineStatus.isErr
                ? 'bg-[#5a121b] text-[#ff7b89] border-[#8a2430]'
                : 'bg-[#0e2918] text-[#4eed84] border-[#28663e]'
            }`}
          >
            {engineStatus.text}
          </div>

          <button
            onClick={() => setAiEnabled(!aiEnabled)}
            className={`px-3 py-1 text-xs font-bold rounded border transition-colors flex items-center gap-1.5 cursor-pointer ${
              aiEnabled
                ? 'bg-[#4d3d10] text-[#ffd700] border-[#ffd700]'
                : 'bg-[#141826] text-[#ffd700] border-[#6b581e] hover:bg-[#222942]'
            }`}
            title="Press B to toggle"
          >
            {aiEnabled ? <Bot className="w-3.5 h-3.5" /> : <User className="w-3.5 h-3.5" />}
            <span>{aiEnabled ? '[B] PPO-GAE Brain: ON' : '[B] Manual Teleop: ON'}</span>
          </button>

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
            <span>{isPaused ? '[P] RESUME' : '[P] PAUSE'}</span>
          </button>

          <button
            onClick={() => concludeAttempt('Manual Reset', false)}
            className="px-2.5 py-1 text-xs font-bold rounded border border-[#2e3856] bg-[#141826] text-[#9cb0d9] hover:bg-[#222942] hover:text-white transition-colors flex items-center gap-1 cursor-pointer"
            title="Press R to restart current rollout"
          >
            <RotateCcw className="w-3 h-3" />
            <span>[R] RESET</span>
          </button>
        </div>

        {/* Speed Controls */}
        <div className="flex items-center gap-1.5 bg-[#080a12] px-2.5 py-1 rounded border border-[#252c44]">
          <span className="text-[11px] text-[#00ffea] font-bold flex items-center gap-1">
            <Zap className="w-3 h-3 text-[#00ffea]" /> SPD:
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

        {/* Export & Utility Actions */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setSfxMuted(!sfxMuted)}
            className={`p-1.5 rounded border border-[#2e3856] text-xs transition-colors cursor-pointer ${
              sfxMuted ? 'bg-[#3d151d] text-[#ff7b89]' : 'bg-[#141826] text-[#4eed84] hover:bg-[#222942]'
            }`}
            title={sfxMuted ? 'Unmute Sound' : 'Mute Sound'}
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
            title="Export full neural policy & state matrix"
          >
            <Download className="w-3 h-3" />
            <span>Save</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-1 text-[11px] font-bold rounded border border-[#1a5c66] bg-[#0e2229] text-[#00ffea] hover:bg-[#163842] hover:border-[#00ffea] transition-colors flex items-center gap-1 cursor-pointer"
            title="Load previously saved brain JSON"
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
            title="Reset policy weights back to zero prior"
          >
            <Trash2 className="w-3 h-3" />
            <span>Wipe</span>
          </button>

          <button
            onClick={() => setShowHelpModal(true)}
            className="p-1.5 rounded border border-[#2e3856] text-[#ffd700] bg-[#141826] hover:bg-[#222942] transition-colors cursor-pointer"
            title="View Curriculum Guide & Controls"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Curriculum Stage Progress Bar */}
      <div className="w-full max-w-[1300px] mb-2 bg-[#0d101b] border-2 border-[#252c44] rounded-lg px-3 py-2 flex flex-col gap-1.5 shadow-md">
        <div className="flex justify-between items-center text-xs">
          <div className="flex items-center gap-2">
            <span className="text-[#a4b0cc] font-semibold flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 text-[#ff6622]" /> 5-STAGE CURRICULUM:
            </span>
            <span
              className="font-bold px-2 py-0.5 rounded text-[11px]"
              style={{
                backgroundColor: `${CURRICULUM_STAGES[telemetry.stageId - 1]?.color}22`,
                color: CURRICULUM_STAGES[telemetry.stageId - 1]?.color,
                border: `1px solid ${CURRICULUM_STAGES[telemetry.stageId - 1]?.color}55`,
              }}
            >
              STAGE {telemetry.stageId}: {CURRICULUM_STAGES[telemetry.stageId - 1]?.name.toUpperCase()} (
              {CURRICULUM_STAGES[telemetry.stageId - 1]?.range})
            </span>
          </div>

          <div className="text-[11px] flex items-center gap-3">
            <span className="text-[#00ffea]">Current X: <b>{telemetry.currentDistMeters}m</b></span>
            <span className="text-[#ffd700]">All-Time Max: <b>{telemetry.maxDistMeters}m</b></span>
          </div>
        </div>

        {/* Multi-stage timeline track */}
        <div className="grid grid-cols-5 gap-1.5 w-full bg-[#080a12] p-1.5 rounded border border-[#1d2336]">
          {CURRICULUM_STAGES.map((st) => {
            const isCompleted = telemetry.currentDistMeters >= st.id * 1000;
            const isCurrent = telemetry.stageId === st.id;
            return (
              <div
                key={st.id}
                className={`relative rounded p-1.5 transition-all border ${
                  isCurrent
                    ? 'border-[#00ffea] bg-[#0e2229]'
                    : isCompleted
                    ? 'border-[#28663e] bg-[#0e2918]/60 opacity-80'
                    : 'border-[#1b2133] bg-[#0d101b]/50 opacity-60'
                }`}
              >
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-bold" style={{ color: st.color }}>
                    #{st.id} {st.name}
                  </span>
                  <span className="text-[9px] text-[#8c97b2]">{st.range}</span>
                </div>
                {isCurrent && (
                  <div className="w-full bg-[#141826] h-1.5 rounded-full mt-1 overflow-hidden border border-[#1b2133]">
                    <div
                      className="h-full bg-gradient-to-r from-[#00ffea] to-[#4eed84] transition-all duration-150"
                      style={{
                        width: `${Math.min(100, Math.max(5, ((telemetry.currentDistMeters % 1000) / 1000) * 100))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Layout Grid */}
      <main className="flex gap-2 items-start max-w-[1300px] w-full justify-center">
        {/* LEFT PANEL: SLIDERS & POLICY */}
        <section className="w-[300px] h-[520px] bg-[#0d101b] border-2 border-[#252c44] rounded-lg p-2.5 flex flex-col justify-between text-[11px] shrink-0 shadow-lg">
          <div>
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-2 text-center flex items-center justify-center gap-1">
              <Shield className="w-3.5 h-3.5 text-[#ffd700]" />
              ROBOTICS VELOCITY & REWARD WEIGHTS
            </div>

            <div className="space-y-1.5 overflow-y-auto max-h-[295px] pr-1">
              {/* Target Vx */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#00ffea]">Target +Vx Tracking (/m):</span>
                  <span className="font-bold text-[#00ffea]">+{rewardCfg.xDistPerMeter.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="2500"
                  step="50"
                  value={rewardCfg.xDistPerMeter}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setRewardCfg((prev) => ({
                      ...prev,
                      xDistPerMeter: val,
                      backPenaltyPerMeter: Math.round(val * 1.5),
                    }));
                  }}
                  className="w-full h-1.5 accent-[#00ffea] cursor-pointer"
                />
              </div>

              {/* Reverse Vx */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#ff5263]">Reverse -Vx Penalty (/m):</span>
                  <span className="font-bold text-[#ff5263]">-{rewardCfg.backPenaltyPerMeter.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="4000"
                  step="50"
                  value={rewardCfg.backPenaltyPerMeter}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, backPenaltyPerMeter: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#ff5263] cursor-pointer"
                />
              </div>

              {/* Heart Lost */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#ff5263]">Collision / Heart Lost:</span>
                  <span className="font-bold text-[#ff5263]">-{rewardCfg.heartLostPenalty.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="2000"
                  max="50000"
                  step="1000"
                  value={rewardCfg.heartLostPenalty}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, heartLostPenalty: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#ff5263] cursor-pointer"
                />
              </div>

              {/* Terminal Fall */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#ff5263]">Terminal Fall / Stall:</span>
                  <span className="font-bold text-[#ff5263]">-{rewardCfg.deathPenalty.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="10000"
                  max="150000"
                  step="2500"
                  value={rewardCfg.deathPenalty}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, deathPenalty: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#ff5263] cursor-pointer"
                />
              </div>

              {/* Clearance */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#4eed84]">Gap / Obstacle Clearance:</span>
                  <span className="font-bold text-[#4eed84]">+{rewardCfg.evadeReward.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="500"
                  max="12000"
                  step="250"
                  value={rewardCfg.evadeReward}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, evadeReward: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#4eed84] cursor-pointer"
                />
              </div>

              {/* Sector */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#ffd700]">Sector Waypoint Reached:</span>
                  <span className="font-bold text-[#ffd700]">+{rewardCfg.sectorClear.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="5000"
                  max="60000"
                  step="1000"
                  value={rewardCfg.sectorClear}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, sectorClear: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#ffd700] cursor-pointer"
                />
              </div>

              {/* Ghost Kill */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#4eed84]">Threat Neutralized:</span>
                  <span className="font-bold text-[#4eed84]">+{rewardCfg.ghostKill.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="10000"
                  step="100"
                  value={rewardCfg.ghostKill}
                  onChange={(e) => {
                    const gVal = Number(e.target.value);
                    setRewardCfg((prev) => ({
                      ...prev,
                      ghostKill: gVal,
                      bulletCost: Math.max(50, Math.round(gVal * 0.32)),
                    }));
                  }}
                  className="w-full h-1.5 accent-[#4eed84] cursor-pointer"
                />
              </div>

              {/* Actuator cost */}
              <div className="bg-[#080a12] p-1.5 rounded border border-[#1b2133]">
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-[#ff5263]">Actuator / Spell Cost:</span>
                  <span className="font-bold text-[#ff5263]">-{rewardCfg.bulletCost.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="5000"
                  step="50"
                  value={rewardCfg.bulletCost}
                  onChange={(e) =>
                    setRewardCfg((prev) => ({ ...prev, bulletCost: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 accent-[#ff5263] cursor-pointer"
                />
              </div>
            </div>
          </div>

          {/* Actor-Critic Policy Probabilities */}
          <div className="border-t border-[#252c44] pt-1.5">
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1.5 text-center flex items-center justify-center gap-1">
              <Target className="w-3.5 h-3.5 text-[#ffd700]" />
              ACTOR π(a|z) & ADVANTAGE A(z,a)
            </div>
            <div className="space-y-1">
              {ACTION_LABELS.map((act) => {
                const prob = telemetry.probs[act.id] !== undefined ? telemetry.probs[act.id] : 0.167;
                const adv = telemetry.adv[act.id] !== undefined ? telemetry.adv[act.id] : 0;
                const isActive = telemetry.currentAction === act.id;
                return (
                  <div
                    key={act.id}
                    className={`flex justify-between items-center px-1.5 py-0.5 rounded transition-colors text-[10px] ${
                      isActive
                        ? 'bg-[#1c422a] border border-[#4eed84] text-white'
                        : 'bg-[#080a12] border border-transparent text-[#a4b0cc]'
                    }`}
                  >
                    <span className="font-semibold">{act.name}:</span>
                    <span
                      className={`font-mono font-bold ${
                        isActive
                          ? 'text-[#4eed84]'
                          : adv < -1.0
                          ? 'text-[#ff5263]'
                          : adv > 1.0
                          ? 'text-[#4eed84]'
                          : 'text-white'
                      }`}
                    >
                      {(prob * 100).toFixed(1)}% ({adv >= 0 ? '+' : ''}
                      {adv.toFixed(1)})
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* CENTER: CANVAS SIMULATION */}
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

          <div className="mt-1.5 text-[11px] text-[#98a3bd] text-center max-w-[660px] bg-[#0d101b] px-3 py-1 rounded border border-[#252c44]">
            <span className="text-[#4eed84] font-bold">5-Stage Curriculum:</span> 0–1000m: Lava Only | 1000–2000m: Spikes Only | 2000–3000m: Ladders | 3000–4000m: Ghosts | 4000m+: Combined Mastery
          </div>
        </div>

        {/* RIGHT PANEL: TELEMETRY & LIVE GRAPH */}
        <section className="w-[300px] h-[520px] bg-[#0d101b] border-2 border-[#252c44] rounded-lg p-2.5 flex flex-col justify-between text-[11px] shrink-0 shadow-lg">
          <div>
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1.5 text-center flex items-center justify-center gap-1">
              <Activity className="w-3.5 h-3.5 text-[#ffd700]" />
              CURRICULUM & PPO TELEMETRY
            </div>
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Episode (Rollout #):</span>
                <span className="font-bold text-[#ffd700]">#{telemetry.attempt}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Curriculum Zone:</span>
                <span className="font-bold text-[#ffd700]">{telemetry.stageText}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Exteroceptive Latent (z):</span>
                <span className="font-bold text-[#00ffea]">{telemetry.contextText}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Critic Value V(z):</span>
                <span className="font-bold text-[#4eed84]">
                  {telemetry.criticVal >= 0 ? '+' : ''}
                  {telemetry.criticVal.toFixed(1)}
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>MAX X TRAVELLED:</span>
                <span className="font-bold text-[#00ffea] text-xs">
                  {telemetry.maxDistMeters}m (Sec {telemetry.maxSector})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>MAX SCORE TILL NOW:</span>
                <span className="font-bold text-[#4eed84] text-xs">{telemetry.bestReward.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Physics Steps/Sec:</span>
                <span className="font-bold text-[#00ffea]">{telemetry.sps.toLocaleString()} SPS</span>
              </div>
            </div>
          </div>

          {/* Current Rollout Breakdown */}
          <div className="border-t border-[#252c44] pt-1.5">
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1 text-center flex items-center justify-center gap-1">
              <Award className="w-3.5 h-3.5 text-[#ffd700]" />
              CURRENT ROLLOUT REWARDS
            </div>
            <div className="space-y-0.5 text-[10px]">
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Velocity Tracking (+X):</span>
                <span className="font-bold text-[#00ffea]">
                  {telemetry.distReward >= 0 ? '+' : ''}
                  {telemetry.distReward.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Obstacles Cleared:</span>
                <span className="font-bold text-[#4eed84]">
                  +{telemetry.evadeReward.toLocaleString()} ({telemetry.hazardsCleared})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Waypoints Reached:</span>
                <span className="font-bold text-[#ffd700]">
                  +{telemetry.sectorReward.toLocaleString()} ({telemetry.sectorsCleared})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Threats Neutralized:</span>
                <span className="font-bold text-[#4eed84]">
                  +{telemetry.ghostReward.toLocaleString()} ({telemetry.ghostKills})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Bonus Nodes:</span>
                <span className="font-bold text-[#ffd700]">
                  +{telemetry.coinReward.toLocaleString()} ({telemetry.coinsCollected})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Integrity Bonus:</span>
                <span className="font-bold text-[#4eed84]">
                  +{telemetry.heartsBonus.toLocaleString()} ({telemetry.playerHp})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Actuator Energy Cost:</span>
                <span className="font-bold text-[#ff5263]">
                  -{telemetry.bulletPenalty.toLocaleString()} ({telemetry.bulletsFired})
                </span>
              </div>
              <div className="flex justify-between text-[#a4b0cc]">
                <span>Collision / Stall Cost:</span>
                <span className="font-bold text-[#ff5263]">
                  -{telemetry.damagePenalty.toLocaleString()} ({telemetry.heartsLost})
                </span>
              </div>
              <div className="flex justify-between text-white font-bold border-t border-[#252c44] pt-1 mt-1">
                <span>LIVE NET RETURN:</span>
                <span className="text-[#00ffea] text-xs">{telemetry.netReturn.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Graph & Episode History */}
          <div className="border-t border-[#252c44] pt-1.5">
            <div className="text-[#ffd700] text-[11px] font-bold border-b border-[#252c44] pb-1 mb-1 text-center flex items-center justify-center gap-1">
              <BarChart3 className="w-3.5 h-3.5 text-[#ffd700]" />
              MAX X (m) VS EPISODES GRAPH
            </div>
            <canvas
              ref={chartCanvasRef}
              width={276}
              height={62}
              className="bg-[#080a10] border border-[#1d2336] rounded mb-1 w-full block"
            />
            <div className="h-[64px] overflow-y-auto bg-[#080a10] border border-[#1d2336] rounded p-1 text-[9.5px] leading-tight space-y-0.5">
              {historyList.length === 0 ? (
                <div className="text-gray-500 italic text-center py-2">No rollouts completed yet</div>
              ) : (
                historyList.map((h, i) => (
                  <div key={i} className="text-[#a4b0cc]">
                    <span className="text-[#ffd700] font-bold">#{h.attempt}</span>: X:
                    <span className="text-[#00ffea] font-semibold">{h.dist}m</span> (Max:
                    {h.recordDist || h.dist}m) | Clr:{h.evades || 0} |{' '}
                    <span className="text-[#ff5263]">{h.cause}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Help & Documentation Modal */}
      {showHelpModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#0d101b] border-2 border-[#252c44] rounded-xl max-w-2xl w-full p-5 text-xs text-[#a4b0cc] shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b border-[#252c44] pb-2">
              <h2 className="text-base font-bold text-[#ffd700] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#ffd700]" />
                Shipius Magos: 5-Stage Curriculum RL & PPO-GAE Lab Guide
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
                <h3 className="text-[#00ffea] font-bold mb-1">Curriculum Design Overview</h3>
                <p className="leading-relaxed">
                  The agent trains on an infinite procedurally generated procedural obstacle runway split into 5 distinct 1,000-meter milestones. Each zone isolates specific locomotion and defense policies to prevent negative catastrophic interference:
                </p>
                <ul className="list-disc pl-5 mt-1.5 space-y-1 text-[#e0e6ed]">
                  {CURRICULUM_STAGES.map((s) => (
                    <li key={s.id}>
                      <b style={{ color: s.color }}>Stage {s.id} ({s.name} - {s.range}):</b> {s.desc}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-[#4eed84] font-bold mb-1">Autonomous PPO-GAE & Win-Stay Satisficing Policy</h3>
                <p className="leading-relaxed">
                  The agent combines <b>PPO-Clip with Generalized Advantage Estimation (GAE λ=0.65)</b> and an exteroceptive LIDAR raycaster. In addition, a <b>Win-Stay Satisficing Controller</b> caches proven clearing trajectories ($A &gt; +1.5$) inside high-priority latent clusters so once an obstacle is conquered, the robot does not perform suicidal exploration on subsequent attempts.
                </p>
              </div>

              <div>
                <h3 className="text-[#ffd700] font-bold mb-1">Desktop Controls & Teleoperation</h3>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div className="bg-[#080a12] p-2 rounded border border-[#1d2336]">
                    <div className="text-white font-bold">Manual Teleop Controls:</div>
                    <ul className="mt-1 space-y-0.5">
                      <li><b>A / D or Left / Right:</b> Run</li>
                      <li><b>W / Space:</b> Jump / Leap</li>
                      <li><b>W / S:</b> Climb Ladders</li>
                      <li><b>Left Click / J / Z:</b> Fire Arcane Staff</li>
                      <li><b>E:</b> Open Loot Chests</li>
                    </ul>
                  </div>

                  <div className="bg-[#080a12] p-2 rounded border border-[#1d2336]">
                    <div className="text-white font-bold">System Hotkeys:</div>
                    <ul className="mt-1 space-y-0.5">
                      <li><b>B:</b> Toggle Autonomous Brain / Teleop</li>
                      <li><b>P:</b> Pause / Resume Simulation</li>
                      <li><b>R:</b> Conclude Rollout & Reset</li>
                      <li><b>Speed Buttons:</b> Accelerate up to 100,000x</li>
                    </ul>
                  </div>
                </div>
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

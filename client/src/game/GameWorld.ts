// Signal Meadow style: physics are immediate and forgiving; authored drawing uses stepped silhouettes and a limited palette.
import { STAGES, cloneStage, type StageData } from "./levelData";
import type { GameCallbacks, GameStatus, HudSnapshot, InputState, Platform, PlayerState, Rect } from "./types";

const W = 640;
const H = 360;
const COLORS = { ink: "#18252b", cream: "#fff1cc", sky: "#91d8db", hillFar: "#73b89a", hillNear: "#3f8c72", moss: "#2f6f59", grass: "#85c45a", soil: "#b96843", copper: "#d17a45", saffron: "#f4b942", coral: "#e45e55", teal: "#267f86", skin: "#f4c89e", white: "#fff9e7" };
const GRAVITY = 0.42;
const MAX_SPEED = 3.5;
const ACCEL = 0.38;
const FRICTION = 0.78;
const JUMP = -8.8;
const COYOTE_FRAMES = 8;
const JUMP_BUFFER_FRAMES = 8;
const HURT_INVULNERABLE_FRAMES = 45;
const MOVE_SUBSTEP = 6;
const STAND_TOLERANCE = 0.6;
const EPSILON = 0.001;

const freshPlayer = (spawnX: number, spawnY: number): PlayerState => ({ x: spawnX, y: spawnY, w: 16, h: 26, vx: 0, vy: 0, onGround: false, facing: 1, anim: 0, hurt: 0 });

export class GameWorld {
  readonly width = W;
  readonly height = H;
  private readonly callbacks: GameCallbacks;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stages: StageData[];
  private input: InputState = { left: false, right: false, jump: false };
  private stageIndex = 0;
  private stage: StageData;
  private status: GameStatus = "menu";
  private score = 0;
  private lives = 3;
  private cameraX = 0;
  private spawnX = 80;
  private spawnY = 220;
  private jumpBuffer = 0;
  private coyote = 0;
  private wasJump = false;
  private message = "RUN THE RELAY";
  private time = 0;
  private player: PlayerState = freshPlayer(80, 220);
  // Moving-platform riding: carrying is positional (never baked into vx), so leaving a
  // platform or the platform reversing can never leave the player drifting.
  private ridePlatform: Platform | null = null;
  private lastRideVx = 0;
  private airBoostVx = 0;
  private readonly platformDx = new Map<Platform, number>();

  constructor(ctx: CanvasRenderingContext2D, callbacks: GameCallbacks, stages: StageData[] = STAGES) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.stages = stages.length > 0 ? stages : STAGES;
    this.stage = cloneStage(this.stages[0]);
    this.emitHud();
  }

  setInput(next: Partial<InputState>) {
    this.input = { ...this.input, ...next };
    if (next.jump && !this.wasJump) this.jumpBuffer = JUMP_BUFFER_FRAMES;
    this.wasJump = Boolean(this.input.jump);
    if (this.status === "menu" && (next.jump || next.left || next.right)) this.start();
    if (this.status === "dead" && next.jump) this.restartAfterDeath();
  }

  press(action: "pause" | "restart") {
    if (action === "pause") {
      if (this.status === "playing") this.status = "paused";
      else if (this.status === "paused") this.status = "playing";
      this.message = this.status === "paused" ? "PAUSED" : "RUN THE RELAY";
      this.emitHud();
    } else this.restartStage();
  }

  start() {
    if (this.status === "menu" || this.status === "complete") { this.stageIndex = 0; this.score = 0; this.lives = 3; this.loadStage(0); }
    else if (this.status === "paused") this.status = "playing";
  }

  /** Read-only snapshot for automated tests and instrumentation; deep-copied so callers cannot mutate game state. */
  inspect() {
    const stage = this.stage;
    return {
      status: this.status,
      stageIndex: this.stageIndex,
      score: this.score,
      lives: this.lives,
      player: { ...this.player },
      spawn: { x: this.spawnX, y: this.spawnY },
      riding: this.ridePlatform ? { ...this.ridePlatform } : null,
      stage: {
        ...stage,
        solids: stage.solids.map((item) => ({ ...item })),
        hazards: stage.hazards.map((item) => ({ ...item })),
        shards: stage.shards.map((item) => ({ ...item })),
        enemies: stage.enemies.map((item) => ({ ...item })),
        checkpoints: stage.checkpoints.map((item) => ({ ...item })),
        platforms: stage.platforms.map((item) => ({ ...item })),
        portal: { ...stage.portal },
      } as StageData,
    };
  }

  private loadStage(index: number) {
    const nextIndex = Math.max(0, Math.min(this.stages.length - 1, index));
    this.stageIndex = nextIndex;
    this.stage = cloneStage(this.stages[nextIndex]);
    this.spawnX = this.stage.spawn.x;
    this.spawnY = this.stage.spawn.y;
    this.player = freshPlayer(this.spawnX, this.spawnY);
    this.resetTransientState();
    this.cameraX = 0;
    this.status = "playing";
    this.message = this.stage.name;
    this.emitHud();
  }

  /** Clear anything tied to the previous stage or previous life so no state leaks across loads. */
  private resetTransientState() {
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.ridePlatform = null;
    this.lastRideVx = 0;
    this.airBoostVx = 0;
    this.platformDx.clear();
  }

  private restartStage() { this.loadStage(this.stageIndex); this.message = "STAGE RESET"; this.emitHud(); }
  private restartAfterDeath() { if (this.lives <= 0) { this.lives = 3; this.score = 0; this.loadStage(0); } else this.loadStage(this.stageIndex); }

  private emitHud() {
    const snapshot: HudSnapshot = { stage: this.stage.id, stageName: this.stage.name, score: this.score, shards: this.stage.shards.filter((s) => s.collected).length, totalShards: this.stage.shards.length, lives: this.lives, status: this.status, message: this.message };
    this.callbacks.onHud(snapshot);
  }

  tick(dtSeconds: number) { const step = Math.min(2.2, Math.max(0.4, dtSeconds * 60)); this.time += dtSeconds; if (this.status === "playing") this.update(step); this.draw(); }

  private update(step: number) {
    this.jumpBuffer = Math.max(0, this.jumpBuffer - step);
    this.coyote = this.player.onGround ? COYOTE_FRAMES : Math.max(0, this.coyote - step);
    if (this.coyote <= 0) this.lastRideVx = 0;

    // 1. Platforms move first, and a rider is translated by the platform's actual delta
    //    for this frame (so reversals are followed immediately and nothing drifts).
    this.platformDx.clear();
    for (const item of this.stage.platforms) this.movePlatform(item, step);
    // `ridePlatform` is only ever set at the end of a frame in which the player was
    // grounded and standing on it, so trusting it here is safe. `carryX` resolves against
    // solids and the level bounds, which may legitimately push the rider off the platform.
    if (this.ridePlatform && this.stage.platforms.includes(this.ridePlatform)) {
      this.carryX(this.platformDx.get(this.ridePlatform) ?? 0);
    }
    if (this.ridePlatform && !this.isStandingOn(this.ridePlatform)) this.ridePlatform = null;

    // 2. Horizontal intent.
    if (this.input.left) { this.player.vx -= ACCEL * step; this.player.facing = -1; }
    if (this.input.right) { this.player.vx += ACCEL * step; this.player.facing = 1; }
    if (!this.input.left && !this.input.right && this.player.onGround) this.player.vx *= Math.pow(FRICTION, step);
    const speedCap = this.player.onGround ? MAX_SPEED : MAX_SPEED + Math.abs(this.airBoostVx);
    this.player.vx = Math.max(-speedCap, Math.min(speedCap, this.player.vx));

    // 3. Jump. A platform launch lends its horizontal velocity to the jump, and the cap
    //    above keeps that momentum alive while airborne.
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.player.vy = JUMP;
      this.player.onGround = false;
      this.jumpBuffer = 0;
      this.coyote = 0;
      const launch = this.ridePlatform?.vx ?? this.lastRideVx;
      if (launch !== 0) { this.player.vx += launch; this.airBoostVx = launch; }
      this.ridePlatform = null;
      this.lastRideVx = 0;
      this.callbacks.onAudioCue?.("jump");
    }

    // 4. Vertical motion first, then horizontal, both robust to fast frames.
    this.player.vy += GRAVITY * step;
    this.moveX(this.player.vx * step);
    this.player.onGround = false;
    this.moveY(this.player.vy * step);

    // 5. Re-establish the rider from the resolved position. When the player is airborne,
    //    `lastRideVx` survives the coyote window so an edge jump still launches with the
    //    platform's momentum, and it is cleared by the coyote timer right after.
    if (this.player.onGround) {
      this.airBoostVx = 0;
      this.ridePlatform = this.findRide();
      this.lastRideVx = this.ridePlatform ? this.ridePlatform.vx : 0;
    } else {
      this.ridePlatform = null;
    }

    this.player.anim += Math.abs(this.player.vx) * step * 0.28; this.player.hurt = Math.max(0, this.player.hurt - step);
    for (const item of this.stage.enemies) {
      if (!item.alive) continue;
      item.x += item.vx * step;
      if (Math.abs(item.x - Math.round(item.x / 80) * 80) > item.phase) item.vx *= -1;
      if (this.overlaps(this.player, item)) {
        const landing = this.player.vy > 0 && this.player.y + this.player.h - item.y < 12;
        if (landing) { item.alive = false; this.player.vy = -5.8; this.score += 150; this.callbacks.onAudioCue?.("stomp"); }
        else if (this.player.hurt <= 0) this.hurt();
      }
    }
    for (const item of this.stage.shards) { item.bob += step * 0.08; if (!item.collected && this.overlaps(this.player, item)) { item.collected = true; this.score += 100; this.callbacks.onAudioCue?.("collect"); } }
    for (const item of this.stage.checkpoints) if (!item.active && this.overlaps(this.player, item)) { item.active = true; this.spawnX = Math.max(0, Math.min(this.stage.width - this.player.w, item.x + 24)); this.spawnY = item.y - 16; this.score += 250; this.message = "RELAY LOCKED"; this.callbacks.onAudioCue?.("checkpoint"); }
    if (this.stage.hazards.some((hazard) => this.overlaps(this.player, hazard)) || this.player.y > H + 80) this.hurt();
    if (this.overlaps(this.player, this.stage.portal)) this.finishStage();
    this.cameraX += (Math.max(0, this.player.x - 190) - this.cameraX) * 0.12;
    this.cameraX = Math.max(0, Math.min(this.stage.width - W, this.cameraX)); this.emitHud();
  }

  private movePlatform(platform: Platform, step: number) {
    // Clamp the travel range to the level first so a platform pinned at a boundary still
    // bounces (instead of keeping an outbound velocity and freezing there forever).
    const rawMin = Math.min(platform.minX, platform.maxX);
    const rawMax = Math.max(platform.minX, platform.maxX);
    const lower = Math.max(0, Math.min(rawMin, this.stage.width - platform.w));
    const upper = Math.max(lower, Math.min(rawMax, this.stage.width - platform.w));
    const previous = platform.x;
    let next = platform.x + platform.vx * step;
    if (next <= lower) { next = lower + (lower - next); platform.vx = Math.abs(platform.vx); }
    else if (next >= upper) { next = upper - (next - upper); platform.vx = -Math.abs(platform.vx); }
    platform.x = Math.max(lower, Math.min(upper, next));
    this.platformDx.set(platform, platform.x - previous);
  }

  /** Carry a rider horizontally, stopping at authored solids and the level bounds instead of squeezing through them. */
  private carryX(amount: number) {
    if (amount === 0) return;
    this.player.x += amount;
    for (const solid of this.stage.solids) {
      if (!this.overlaps(this.player, solid)) continue;
      this.player.x = amount > 0 ? solid.x - this.player.w : solid.x + solid.w;
    }
    this.player.x = Math.max(0, Math.min(this.stage.width - this.player.w, this.player.x));
  }

  private moveX(amount: number) {
    if (amount === 0) return;
    this.player.x += amount;
    for (const solid of this.stage.solids) if (this.overlaps(this.player, solid)) { this.player.x = amount > 0 ? solid.x - this.player.w : solid.x + solid.w; this.player.vx = 0; }
    const clamped = Math.max(0, Math.min(this.stage.width - this.player.w, this.player.x));
    if (clamped !== this.player.x) this.player.vx = 0;
    this.player.x = clamped;
  }

  private moveY(amount: number) {
    if (amount === 0) return;
    // Substep so a fast fall cannot tunnel through a 20px platform.
    const slices = Math.max(1, Math.ceil(Math.abs(amount) / MOVE_SUBSTEP));
    const slice = amount / slices;
    for (let i = 0; i < slices; i += 1) {
      const previousBottom = this.player.y + this.player.h;
      this.player.y += slice;
      for (const solid of this.stage.solids) {
        if (!this.overlaps(this.player, solid)) continue;
        if (slice > 0) { this.player.y = solid.y - this.player.h; this.player.vy = 0; this.player.onGround = true; }
        else { this.player.y = solid.y + solid.h; this.player.vy = 0; }
      }
      if (slice <= 0) continue;
      // Moving platforms are one-way: land on them only when descending onto their top.
      for (const platform of this.stage.platforms) {
        if (previousBottom > platform.y + EPSILON) continue;
        if (!this.overlaps(this.player, platform)) continue;
        this.player.y = platform.y - this.player.h;
        this.player.vy = 0;
        this.player.onGround = true;
      }
    }
  }

  private isStandingOn(platform: Platform) {
    const bottom = this.player.y + this.player.h;
    return Math.abs(bottom - platform.y) <= STAND_TOLERANCE && this.player.x + this.player.w > platform.x + EPSILON && this.player.x < platform.x + platform.w - EPSILON;
  }

  private findRide() {
    for (const platform of this.stage.platforms) if (this.isStandingOn(platform)) return platform;
    return null;
  }

  private overlaps(a: Rect, b: Rect) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

  private hurt() {
    if (this.player.hurt > 0) return;
    this.lives -= 1; this.callbacks.onAudioCue?.("hurt");
    if (this.lives <= 0) { this.player.hurt = HURT_INVULNERABLE_FRAMES; this.ridePlatform = null; this.lastRideVx = 0; this.airBoostVx = 0; this.status = "dead"; this.message = "SIGNAL LOST — TAP JUMP"; this.emitHud(); return; }
    this.respawn();
    this.message = "TRY THE ROUTE AGAIN";
  }

  /** Return to the active checkpoint (or stage spawn) with a predictable pose and zero momentum. */
  private respawn() {
    this.player.x = this.spawnX;
    this.player.y = this.spawnY;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.onGround = false;
    this.player.facing = 1;
    this.player.anim = 0;
    this.player.hurt = HURT_INVULNERABLE_FRAMES;
    this.jumpBuffer = 0;
    this.coyote = 0;
    this.ridePlatform = null;
    this.lastRideVx = 0;
    this.airBoostVx = 0;
  }

  private finishStage() {
    this.score += 500 + this.stage.shards.filter((s) => s.collected).length * 50; this.callbacks.onAudioCue?.("finish");
    if (this.stageIndex < this.stages.length - 1) { this.loadStage(this.stageIndex + 1); this.message = "NEXT RELAY: " + this.stage.name; }
    else { this.status = "complete"; this.message = "ROUTE COMPLETE — TAP JUMP"; this.emitHud(); }
  }

  private draw() {
    const ctx = this.ctx; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, W, H); this.drawBackground(ctx); ctx.save(); ctx.translate(-Math.round(this.cameraX), 0);
    for (const solid of this.stage.solids) this.drawTile(ctx, solid);
    for (const platform of this.stage.platforms) this.drawTile(ctx, platform, true);
    for (const hazard of this.stage.hazards) this.drawHazard(ctx, hazard);
    for (const item of this.stage.shards) if (!item.collected) this.drawShard(ctx, item);
    for (const item of this.stage.checkpoints) this.drawCheckpoint(ctx, item);
    for (const enemy of this.stage.enemies) if (enemy.alive) this.drawEnemy(ctx, enemy);
    this.drawPortal(ctx, this.stage.portal); this.drawPlayer(ctx); ctx.restore();
  }

  private drawBackground(ctx: CanvasRenderingContext2D) {
    const sky = ctx.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, COLORS.sky); sky.addColorStop(1, COLORS.cream); ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COLORS.cream; ctx.fillRect(500, 52, 28, 28);
    ctx.fillStyle = COLORS.hillFar; for (let x = -80 - ((this.cameraX * 0.1) % 160); x < W + 160; x += 160) { ctx.beginPath(); ctx.moveTo(x, 224); ctx.lineTo(x + 24, 224); ctx.lineTo(x + 24, 208); ctx.lineTo(x + 40, 208); ctx.lineTo(x + 40, 192); ctx.lineTo(x + 56, 192); ctx.lineTo(x + 56, 176); ctx.lineTo(x + 72, 176); ctx.lineTo(x + 72, 160); ctx.lineTo(x + 96, 160); ctx.lineTo(x + 96, 176); ctx.lineTo(x + 112, 176); ctx.lineTo(x + 112, 192); ctx.lineTo(x + 128, 192); ctx.lineTo(x + 128, 208); ctx.lineTo(x + 144, 208); ctx.lineTo(x + 144, 224); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = COLORS.hillNear; for (let x = -120 - ((this.cameraX * 0.22) % 180); x < W + 180; x += 180) { ctx.beginPath(); ctx.moveTo(x, 282); ctx.lineTo(x + 30, 282); ctx.lineTo(x + 30, 258); ctx.lineTo(x + 50, 258); ctx.lineTo(x + 50, 234); ctx.lineTo(x + 70, 234); ctx.lineTo(x + 70, 210); ctx.lineTo(x + 90, 210); ctx.lineTo(x + 90, 186); ctx.lineTo(x + 110, 186); ctx.lineTo(x + 110, 210); ctx.lineTo(x + 130, 210); ctx.lineTo(x + 130, 234); ctx.lineTo(x + 150, 234); ctx.lineTo(x + 150, 258); ctx.lineTo(x + 180, 258); ctx.lineTo(x + 180, 282); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = "#23604f"; for (let x = -60 - ((this.cameraX * 0.35) % 96); x < W + 100; x += 96) { ctx.fillRect(x, 218, 10, 62); ctx.fillRect(x - 14, 204, 38, 20); ctx.fillRect(x - 8, 190, 26, 20); }
  }

  private drawTile(ctx: CanvasRenderingContext2D, r: Rect, elevated = false) { ctx.fillStyle = COLORS.soil; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.fillStyle = COLORS.grass; ctx.fillRect(r.x, r.y, r.w, 7); ctx.fillStyle = COLORS.moss; for (let x = r.x + 4; x < r.x + r.w; x += 22) ctx.fillRect(x, r.y + 10, 10, Math.min(r.h - 10, elevated ? 7 : 14)); ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 2; ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); }
  private drawHazard(ctx: CanvasRenderingContext2D, r: Rect) { ctx.fillStyle = COLORS.ink; for (let x = r.x; x < r.x + r.w; x += 14) { ctx.beginPath(); ctx.moveTo(x, r.y + r.h); ctx.lineTo(x + 7, r.y + 7); ctx.lineTo(x + 14, r.y + r.h); ctx.closePath(); ctx.fill(); } ctx.fillStyle = COLORS.coral; ctx.fillRect(r.x, r.y + r.h - 5, r.w, 5); }
  private drawShard(ctx: CanvasRenderingContext2D, s: Rect & { bob: number }) { const y = s.y + Math.sin(s.bob) * 3; for (const offset of [0, 7, 14]) { ctx.fillStyle = COLORS.ink; ctx.beginPath(); ctx.moveTo(s.x + 4 + offset, y + 4); ctx.lineTo(s.x + 9 + offset, y + 10); ctx.lineTo(s.x + 4 + offset, y + 16); ctx.lineTo(s.x - 1 + offset, y + 10); ctx.closePath(); ctx.fill(); ctx.fillStyle = COLORS.saffron; ctx.fillRect(s.x + 2 + offset, y + 8, 4, 5); } }
  private drawCheckpoint(ctx: CanvasRenderingContext2D, c: Rect & { active: boolean }) { ctx.fillStyle = COLORS.ink; ctx.fillRect(c.x + 7, c.y, 3, 40); ctx.fillStyle = c.active ? COLORS.saffron : COLORS.coral; ctx.beginPath(); ctx.moveTo(c.x + 9, c.y + 3); ctx.lineTo(c.x + 27, c.y + 9); ctx.lineTo(c.x + 9, c.y + 17); ctx.closePath(); ctx.fill(); }
  private drawPortal(ctx: CanvasRenderingContext2D, p: Rect) { ctx.fillStyle = COLORS.ink; ctx.fillRect(p.x, p.y + 12, p.w, p.h - 12); ctx.fillStyle = COLORS.teal; ctx.fillRect(p.x + 5, p.y + 7, p.w - 10, p.h - 12); ctx.fillStyle = COLORS.saffron; ctx.fillRect(p.x + 9, p.y + 14, 5, 24); ctx.fillStyle = COLORS.white; ctx.fillRect(p.x + 16, p.y + 22, 4, 4); }
  private drawEnemy(ctx: CanvasRenderingContext2D, e: Rect) { ctx.fillStyle = COLORS.ink; ctx.fillRect(e.x + 2, e.y + 5, e.w - 4, e.h - 5); ctx.fillStyle = COLORS.copper; ctx.fillRect(e.x + 4, e.y + 2, e.w - 8, e.h - 7); ctx.fillStyle = COLORS.saffron; ctx.fillRect(e.x + 5, e.y + 6, 3, 3); ctx.fillRect(e.x + 11, e.y + 6, 3, 3); ctx.fillStyle = COLORS.ink; ctx.fillRect(e.x + 1, e.y + e.h - 2, 6, 4); ctx.fillRect(e.x + e.w - 7, e.y + e.h - 2, 6, 4); }
  private drawPlayer(ctx: CanvasRenderingContext2D) {
    const p = this.player; const bob = p.onGround && Math.abs(p.vx) > 0.4 ? Math.round(Math.sin(p.anim) * 2) : 0; const x = Math.round(p.x); const y = Math.round(p.y + bob); ctx.save();
    if (p.facing < 0) { ctx.translate(x + p.w, 0); ctx.scale(-1, 1); } else ctx.translate(x, 0);
    ctx.globalAlpha = p.hurt > 0 && Math.floor(p.hurt / 4) % 2 === 0 ? 0.45 : 1; ctx.fillStyle = COLORS.ink; ctx.fillRect(2, y + 5, 14, 18); ctx.fillStyle = COLORS.teal; ctx.fillRect(1, y + 3, 15, 6); ctx.fillRect(4, y, 10, 5); ctx.fillStyle = COLORS.skin; ctx.fillRect(5, y + 9, 9, 8); ctx.fillStyle = COLORS.coral; ctx.fillRect(3, y + 16, 12, 8); ctx.fillStyle = COLORS.saffron; ctx.fillRect(0, y + 18, 5, 4); ctx.fillStyle = COLORS.ink; ctx.fillRect(2, y + 22, 5, 4); ctx.fillRect(11, y + 22, 5, 4); ctx.fillRect(12, y + 11, 2, 2); ctx.restore();
  }
}

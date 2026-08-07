/**
 * I Ching 64 Hexagrams tool module.
 * Dual concentric rings (upper/lower trigrams) with drag-to-rotate,
 * real-time hexagram combination at the top pointer, and a detail view.
 * Visual style inspired by Wang Ye's Fenghou Qimen disk: deep blue-black
 * background with cyan glowing yao lines.
 */

import { HEXAGRAMS, type IchingHexagram } from "./iching-data";

// --- Trigram helpers ---

const TRIGRAM_BITS: Record<string, [number, number, number]> = {
  "\u4E7E": [1, 1, 1],   // 乾
  "\u5156": [1, 1, 0],   // 兑
  "\u79BB": [1, 0, 1],   // 离
  "\u9707": [1, 0, 0],   // 震
  "\u5DFD": [0, 1, 1],   // 巽
  "\u574E": [0, 1, 0],   // 坎
  "\u826E": [0, 0, 1],   // 艮
  "\u5764": [0, 0, 0],   // 坤
};

function findHexagram(upper: string, lower: string): IchingHexagram | undefined {
  return HEXAGRAMS.find((h) => h.upperTrigram === upper && h.lowerTrigram === lower);
}

// --- SVG yao rendering ---

function yaoLine(bits: number, x: number, width: number, y: number, highlighted?: boolean): string {
  const stroke = highlighted ? "var(--iching-glow)" : "var(--iching-yao)";
  const glowColor = "var(--iching-glow-soft)";
  const sw = highlighted ? 3.2 : 2.6;
  const glowSw = sw + 5;
  const glowOpacity = highlighted ? 0.45 : 0.25;
  if (bits === 1) {
    return `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${glowColor}" stroke-width="${glowSw}" stroke-linecap="round" opacity="${glowOpacity}"/>`
      + `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
  }
  const gap = width * 0.18;
  const seg = (width - gap) / 2;
  return `<line x1="${x}" y1="${y}" x2="${x + seg}" y2="${y}" stroke="${glowColor}" stroke-width="${glowSw}" stroke-linecap="round" opacity="${glowOpacity}"/>`
    + `<line x1="${x + seg + gap}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${glowColor}" stroke-width="${glowSw}" stroke-linecap="round" opacity="${glowOpacity}"/>`
    + `<line x1="${x}" y1="${y}" x2="${x + seg}" y2="${y}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`
    + `<line x1="${x + seg + gap}" y1="${y}" x2="${x + width}" y2="${y}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
}

function trigramSvg(trigram: string, cx: number, cy: number, scale: number, highlighted?: boolean): string {
  const bits = TRIGRAM_BITS[trigram];
  if (!bits) return "";
  const w = 28 * scale;
  const x = cx - w / 2;
  const gap = 7 * scale;
  const startY = cy - gap;
  return bits.map((b, i) => yaoLine(b, x, w, startY + i * gap, highlighted)).join("");
}

// --- Ring geometry ---

const R_OUTER = 270;
const R_OUTER_INNER = 200;
const R_INNER = 190;
const R_INNER_INNER = 120;
const LABEL_R = 292;
const N = 64;
const SLOT = 360 / N;

// --- State ---

interface RingState {
  rotation: number;
  dragging: boolean;
  lastAngle: number;
  velocity: number;
  animating: boolean;
}

let upperState: RingState = { rotation: 0, dragging: false, lastAngle: 0, velocity: 0, animating: false };
let lowerState: RingState = { rotation: 0, dragging: false, lastAngle: 0, velocity: 0, animating: false };
let inertiaRAF: number | null = null;

function slotAtPointer(rotation: number): number {
  let r = rotation % 360;
  if (r < 0) r += 360;
  return Math.round(r / SLOT) % N;
}

function trigramAtPointer(rotation: number, isUpper: boolean): string {
  const idx = slotAtPointer(rotation);
  const h = HEXAGRAMS[idx];
  return isUpper ? h.upperTrigram : h.lowerTrigram;
}

function currentHexagram(): IchingHexagram | undefined {
  const upper = trigramAtPointer(upperState.rotation, true);
  const lower = trigramAtPointer(lowerState.rotation, false);
  return findHexagram(upper, lower);
}

// --- SVG ring construction ---

function buildRing(isUpper: boolean): string {
  const rOuter = isUpper ? R_OUTER : R_INNER;
  const rInner = isUpper ? R_OUTER_INNER : R_INNER_INNER;
  const rotation = isUpper ? upperState.rotation : lowerState.rotation;
  let elements = "";

  for (let i = 0; i < N; i++) {
    const h = HEXAGRAMS[i];
    const trigram = isUpper ? h.upperTrigram : h.lowerTrigram;
    const angle = i * SLOT;
    const svgAngle = angle - 90;
    const rad = (svgAngle * Math.PI) / 180;
    const midR = (rOuter + rInner) / 2;
    const cx = midR * Math.cos(rad);
    const cy = midR * Math.sin(rad);

    elements += `<g transform="rotate(${angle} ${cx} ${cy})">`;
    elements += trigramSvg(trigram, cx, cy, 1.0);
    elements += `</g>`;

    if (isUpper) {
      const lx = LABEL_R * Math.cos(rad);
      const ly = LABEL_R * Math.sin(rad);
      const textRotate = angle > 90 && angle < 270 ? angle + 180 : angle;
      elements += `<text x="${lx}" y="${ly}" class="iching-label" transform="rotate(${textRotate} ${lx} ${ly})" text-anchor="middle" dominant-baseline="middle">${h.name}</text>`;
    }
  }

  let dividers = "";
  for (let i = 0; i < N; i++) {
    const angle = i * SLOT - SLOT / 2;
    const svgAngle = angle - 90;
    const rad = (svgAngle * Math.PI) / 180;
    const x1 = rInner * Math.cos(rad);
    const y1 = rInner * Math.sin(rad);
    const x2 = rOuter * Math.cos(rad);
    const y2 = rOuter * Math.sin(rad);
    dividers += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--iching-divider)" stroke-width="0.5"/>`;
  }

  const midCircle = `<circle cx="0" cy="0" r="${(rOuter + rInner) / 2}" fill="none" stroke="var(--iching-ring-bg)" stroke-width="${rOuter - rInner}" />`;
  const outerCircle = `<circle cx="0" cy="0" r="${rOuter}" fill="none" stroke="var(--iching-ring-border)" stroke-width="1"/>`;
  const innerCircle = `<circle cx="0" cy="0" r="${rInner}" fill="none" stroke="var(--iching-ring-border)" stroke-width="1"/>`;

  // Use SVG transform attribute (rotates around 0,0 = center) instead of CSS transform
  return `<g class="iching-ring" data-ring="${isUpper ? "upper" : "lower"}" transform="rotate(${rotation})">`
    + midCircle + dividers + elements + outerCircle + innerCircle
    + `</g>`;
}

function buildCenter(): string {
  const r = 40;
  return `<g class="iching-taiji">
    <circle cx="0" cy="0" r="${r}" fill="none" stroke="var(--iching-taiji-stroke)" stroke-width="1.5"/>
    <path d="M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r} A ${r/2} ${r/2} 0 0 1 0 0 A ${r/2} ${r/2} 0 0 0 0 ${-r} Z" fill="none" stroke="var(--iching-taiji-stroke)" stroke-width="1.5"/>
    <circle cx="0" cy="${-r/2}" r="3" fill="var(--iching-taiji-stroke)"/>
    <circle cx="0" cy="${r/2}" r="3" fill="var(--iching-taiji-stroke)"/>
  </g>`;
}

function buildPointer(): string {
  return `<g class="iching-pointer">
    <line x1="0" y1="${-R_OUTER - 38}" x2="0" y2="${-R_OUTER - 4}" stroke="var(--iching-glow)" stroke-width="2" stroke-linecap="round"/>
    <line x1="0" y1="${-R_OUTER - 38}" x2="0" y2="${-R_OUTER - 4}" stroke="var(--iching-glow-soft)" stroke-width="6" stroke-linecap="round" opacity="0.4"/>
    <polygon points="0,${-R_OUTER - 4} -6,${-R_OUTER - 14} 6,${-R_OUTER - 14}" fill="var(--iching-glow)"/>
  </g>`;
}

function buildBg(): string {
  return `<defs>
    <radialGradient id="iching-disc-bg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="var(--iching-disc-center)"/>
      <stop offset="100%" stop-color="var(--iching-disc-edge)"/>
    </radialGradient>
  </defs>
  <circle cx="0" cy="0" r="${R_OUTER + 50}" fill="url(#iching-disc-bg)" stroke="var(--iching-ring-border)" stroke-width="0.5"/>`;
}

function renderRingSVG(): string {
  const svgContent = buildBg() + buildRing(true) + buildRing(false) + buildCenter() + buildPointer();
  const vb = -(R_OUTER + 70);
  const size = (R_OUTER + 70) * 2;
  return `<svg class="iching-ring-svg" viewBox="${vb} ${vb} ${size} ${size}" preserveAspectRatio="xMidYMid meet">${svgContent}</svg>`;
}

// --- Interaction ---

function pointerAngle(evt: PointerEvent, svg: SVGSVGElement): number {
  const rect = svg.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = evt.clientX - cx;
  const dy = evt.clientY - cy;
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  return angle;
}

function applyInertia() {
  let needContinue = false;
  for (const s of [upperState, lowerState]) {
    if (!s.dragging && !s.animating && Math.abs(s.velocity) > 0.05) {
      s.rotation += s.velocity;
      s.velocity *= 0.94;
      needContinue = true;
    } else if (!s.dragging && !s.animating) {
      s.velocity = 0;
    }
  }
  updateTransforms();
  updateDisplay();
  if (needContinue) {
    inertiaRAF = requestAnimationFrame(applyInertia);
  } else {
    inertiaRAF = null;
  }
}

function startInertia() {
  if (inertiaRAF === null) inertiaRAF = requestAnimationFrame(applyInertia);
}

// Use SVG transform attribute for reliable rotation around (0,0)
function updateTransforms() {
  const u = document.querySelector<SVGGElement>('.iching-ring[data-ring="upper"]');
  const l = document.querySelector<SVGGElement>('.iching-ring[data-ring="lower"]');
  if (u) u.setAttribute("transform", `rotate(${upperState.rotation})`);
  if (l) l.setAttribute("transform", `rotate(${lowerState.rotation})`);
}

function updateDisplay() {
  const current = currentHexagram();
  const name = document.getElementById("iching-current-name");
  const sub = document.getElementById("iching-current-sub");
  if (name) name.textContent = current ? `${current.symbol} ${current.name}` : "\u7EC4\u5408\u65E0\u6548";
  if (sub) sub.textContent = current ? `\u7B2C${current.number}\u5366 \u00B7 ${current.upperTrigram}\u4E0A${current.lowerTrigram}\u4E0B` : "";
}

function setupDrag(container: HTMLElement) {
  const svg = container.querySelector<SVGSVGElement>(".iching-ring-svg");
  if (!svg) return;
  let activeState: RingState | null = null;

  svg.addEventListener("pointerdown", (evt) => {
    const rect = svg.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = evt.clientX - cx;
    const dy = evt.clientY - cy;
    const scale = ((R_OUTER + 70) * 2) / rect.width;
    const svgDist = Math.sqrt(dx * dx + dy * dy) * scale;

    if (svgDist >= R_OUTER_INNER && svgDist <= R_OUTER + 20) {
      activeState = upperState;
    } else if (svgDist >= R_INNER_INNER - 10 && svgDist <= R_INNER) {
      activeState = lowerState;
    } else {
      return;
    }
    activeState.dragging = true;
    activeState.velocity = 0;
    activeState.lastAngle = pointerAngle(evt, svg);
    svg.setPointerCapture(evt.pointerId);
  });

  svg.addEventListener("pointermove", (evt) => {
    if (!activeState || !activeState.dragging) return;
    const angle = pointerAngle(evt, svg);
    let delta = angle - activeState.lastAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    activeState.rotation += delta;
    activeState.velocity = delta;
    activeState.lastAngle = angle;
    updateTransforms();
    updateDisplay();
  });

  const endDrag = (evt: PointerEvent) => {
    if (activeState) {
      activeState.dragging = false;
      startInertia();
    }
    activeState = null;
    try { svg.releasePointerCapture(evt.pointerId); } catch { /* */ }
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
}

// --- Reset animation ---

function animateReset() {
  const sU = upperState.rotation;
  const sL = lowerState.rotation;
  const dur = 600;
  const t0 = performance.now();
  upperState.animating = true;
  lowerState.animating = true;
  upperState.velocity = 0;
  lowerState.velocity = 0;

  const targetU = sU > 180 ? sU - 360 : (sU < -180 ? sU + 360 : sU);
  const targetL = sL > 180 ? sL - 360 : (sL < -180 ? sL + 360 : sL);

  function step(now: number) {
    const t = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    upperState.rotation = sU + (0 - targetU) * eased;
    lowerState.rotation = sL + (0 - targetL) * eased;
    if (t >= 1) {
      upperState.rotation = 0;
      lowerState.rotation = 0;
      upperState.animating = false;
      lowerState.animating = false;
    }
    updateTransforms();
    updateDisplay();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// --- Detail page ---

function hexagramBits(h: IchingHexagram): number[] {
  return [...TRIGRAM_BITS[h.lowerTrigram], ...TRIGRAM_BITS[h.upperTrigram]];
}

function renderDetail(h: IchingHexagram): string {
  const bits = hexagramBits(h);
  const yaoW = 100;
  const yaoX = 50;
  const yaoGap = 14;
  const sY = 25;
  let yaoSvg = "";
  for (let i = 5; i >= 0; i--) {
    yaoSvg += yaoLine(bits[i], yaoX, yaoW, sY + (5 - i) * yaoGap);
  }
  const yaoH = sY + 5 * yaoGap + 25;

  return `
    <button class="tools-detail-back" onclick="ichingBackToRing()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      \u8FD4\u56DE\u5706\u76D8
    </button>

    <div class="iching-detail-layout">
      <div class="iching-detail-header">
        <svg class="iching-detail-symbol" viewBox="0 0 200 ${yaoH}" width="200" height="${yaoH}">
          ${yaoSvg}
        </svg>
        <div class="iching-detail-title">
          <h2>${h.symbol} ${h.name}</h2>
          <p class="iching-detail-meta">\u7B2C${h.number}\u5366 \u00B7 ${h.upperTrigram}\u4E0A${h.lowerTrigram}\u4E0B</p>
        </div>
      </div>

      <div class="iching-detail-section">
        <h3>\u5366\u8F9E</h3>
        <p class="iching-classic-text">${h.judgment}</p>
      </div>

      <div class="iching-detail-section">
        <h3>\u5927\u8C61\u4F20</h3>
        <p class="iching-classic-text">${h.image}</p>
      </div>

      <div class="iching-detail-section">
        <h3>\u723B\u8F9E\u4E0E\u5C0F\u8C61\u4F20</h3>
        <div class="iching-lines">
          ${h.lines.map((line) => `
            <div class="iching-line-item">
              <div class="iching-line-position">${line.position}</div>
              <div class="iching-line-content">
                <p class="iching-classic-text iching-line-text">${line.text}</p>
                ${line.commentary ? `<p class="iching-classic-text iching-line-commentary">${line.commentary}</p>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

// --- Main entry ---

export function renderIchingDetail(): void {
  const cards = document.getElementById("tools-cards");
  const detail = document.getElementById("tools-detail");
  if (!cards || !detail) return;
  cards.style.display = "none";

  upperState = { rotation: 0, dragging: false, lastAngle: 0, velocity: 0, animating: false };
  lowerState = { rotation: 0, dragging: false, lastAngle: 0, velocity: 0, animating: false };

  const current = currentHexagram();

  detail.innerHTML = `
    <button class="tools-detail-back" onclick="backToToolsCards()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
      \u8FD4\u56DE\u5DE5\u5177\u5217\u8868
    </button>

    <div class="iching-main">
      <div class="iching-ring-container" id="iching-ring-container">
        ${renderRingSVG()}
      </div>

      <div class="iching-info-panel">
        <div class="iching-current-display">
          <div class="iching-current-symbol" id="iching-current-name">${current ? current.symbol + " " + current.name : "\u7EC4\u5408\u65E0\u6548"}</div>
          <div class="iching-current-sub" id="iching-current-sub">${current ? `\u7B2C${current.number}\u5366 \u00B7 ${current.upperTrigram}\u4E0A${current.lowerTrigram}\u4E0B` : ""}</div>
        </div>

        <div class="iching-actions">
          <button class="btn btn-primary iching-reset-btn" onclick="ichingReset()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            \u590D\u4F4D
          </button>
          <button class="btn iching-view-btn" onclick="ichingViewDetail()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            \u67E5\u770B\u8BE6\u60C5
          </button>
        </div>

        <div class="iching-hint">
          <p>\u62D6\u52A8\u5916\u73AF\u8F6C\u52A8\u4E0A\u5366\uFF0C\u5185\u73AF\u8F6C\u52A8\u4E0B\u5366\u3002</p>
          <p>\u9876\u90E8\u6307\u9488\u6240\u6307\u5373\u4E3A\u5F53\u524D\u7EC4\u5408\u5366\u8C61\u3002</p>
          <p>\u590D\u4F4D\u53EF\u6062\u590D\u6807\u51C6\u516D\u5341\u56DB\u5366\u5366\u5E8F\u3002</p>
        </div>
      </div>
    </div>
  `;

  setupDrag(detail);
}

// --- Global handlers ---

(window as any).ichingReset = function (): void {
  animateReset();
};

(window as any).ichingViewDetail = function (): void {
  const current = currentHexagram();
  if (!current) return;
  const detail = document.getElementById("tools-detail");
  if (!detail) return;
  detail.innerHTML = renderDetail(current);
  document.querySelector(".content-area")?.scrollTo({ top: 0, behavior: "smooth" });
};

(window as any).ichingBackToRing = function (): void {
  renderIchingDetail();
};

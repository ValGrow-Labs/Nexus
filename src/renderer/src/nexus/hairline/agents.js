/**
 * Agents: four desks on one plate, a lead agent at the back and three helpers,
 * each seated at a screen. They work for good: heads bob, arms type, code
 * types out line by line on every screen, and notes run between the lead and
 * each helper. The desk nearest the pointer lifts on the 700ms curve and its
 * screen takes the bright edge; at rest the lead's screen has it. The read-out
 * names the agent and what it is doing. The slider is how high a desk lifts.
 *
 * App copy of hairline/agents.js (made with the hairline-create skill), as a module.
 */
import { HL } from "./kernel.js";
const {
  Cam, clamp, facing, fillet, fit, open, poly, prism, proj, put, rings, rrect, seg,
  tdone, tset, tval, tween, unproj, disposer, mk, place, pointer, reducedMotion, reflect, register, solid,
} = HL;

const WHO = ["lead · planning", "helper 1 · editing files", "helper 2 · running tests", "helper 3 · writing the diff"];
const AT = [[46, 40], [144, 40], [46, 104], [144, 104]];
const PW = 190, PD = 146, PT = 6, DW = 19, DD = 11, DZ = 13, MW = 15, MH = 22, SPEED = 0.16;

/** Desk i's parts as path strings, lifted by z, at time t (seconds): the agent types, the screen fills. */
function desk(P, C, front, i, z, t) {
  const [cx, cy] = AT[i];
  const part = (x0, y0, x1, y1, r, b, z0, z1) => { const [ring, inner] = rings(x0, y0, x1, y1, r, b); return prism(P, front, ring, inner, z0, z1); };
  const top = PT + DZ + z;
  const table = part(cx - DW, cy - DD, cx + DW, cy + DD, 3, 1.2, PT + z, top);
  const keys = part(cx - 9, cy + 1, cx + 9, cy + 7, 1.4, 0.7, top, top + 1.6);
  const mon = part(cx - MW, cy - DD + 1, cx + MW, cy - DD + 5, 1.6, 0.8, top + 3, top + MH);
  const stand = part(cx - 2.5, cy - DD + 2, cx + 2.5, cy - DD + 4, 0.8, 0.4, top, top + 3);
  const fy = cy - DD + 5, face = (u, v) => P(u, fy, top + v);
  const screen = poly(rrect(cx - MW + 3, 6, cx + MW - 3, MH - 3, 2, 4).map((q) => face(q.u, q.v)));
  // code typing out, one line after another, then the screen clears and starts again
  const ph = (t * 0.22 + i * 0.27) % 1, widths = [18, 12, 20, 9];
  const code = widths.map((w, k) => {
    const f = clamp(ph * 5 - k, 0, 1);
    return f > 0.02 ? seg(face(cx - MW + 6, MH - 7 - k * 3.4), face(cx - MW + 6 + w * f, MH - 7 - k * 3.4)) : "";
  }).join("");
  // the agent, on a chair in front of the desk, its back to us
  const ay = cy + DD + 6, bob = Math.sin(t * 5 + i * 1.7) * 0.5;
  const seat = part(cx - 7, ay - 3, cx + 7, ay + 6, 2, 0.8, PT + z, PT + 9 + z);
  const torso = part(cx - 6, ay - 3, cx + 6, ay + 3, 3, 1, PT + 9 + z, PT + 23 + z + bob);
  const back = part(cx - 7, ay + 4, cx + 7, ay + 6.5, 1.2, 0.6, PT + 9 + z, PT + 19 + z);
  const tap = (s) => Math.sin(t * 14 + s + i) * 0.9;
  const arms = [-1, 1].map((s) => open([P(cx + s * 6, ay - 1, PT + 20 + z + bob), P(cx + s * 7, cy + DD + 1, top + 4), P(cx + s * 4 + tap(s * 2), cy + 5, top + 2 + Math.abs(tap(s)))])).join("");
  const hc = P(cx, ay, PT + 28 + z + bob), hr = 4.4 * C.S;
  const head = poly(Array.from({ length: 24 }, (_, k) => [hc[0] + Math.cos((k / 24) * 2 * Math.PI) * hr, hc[1] + Math.sin((k / 24) * 2 * Math.PI) * hr]));
  return { table, keys, mon, stand, screen, code, seat, torso, back, arms, head };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let lift = value;

  const C = Cam(45, 0.5, 1.62);
  fit(C, [[0, 0, 0], [PW, 0, 0], [0, PD, 0], [PW, PD, -12], [AT[0][0], AT[0][1] - DD, PT + DZ + MH + 24]], 200, 160);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [pRing, pIn] = rings(0, 0, PW, PD, 14, 1.8);
  reflect(svg, g, P, front, pRing, 0, 14);
  put(solid(g), prism(P, front, pRing, pIn, 0, PT));

  // the lanes the notes run in, painted on the plate under everything
  const lanes = AT.slice(1).map((h) => {
    const [lx, ly] = AT[0], dx = h[0] - lx, dy = h[1] - ly, L = Math.hypot(dx, dy), t = [dx / L, dy / L], n = [-t[1], t[0]];
    const a = [lx + t[0] * 28, ly + t[1] * 28], b = [h[0] - t[0] * 28, h[1] - t[1] * 28];
    return { a, b, t, n, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], half: Math.hypot(b[0] - a[0], b[1] - a[1]) / 2 };
  });
  lanes.forEach((l) => mk("path", { d: seg(P(l.a[0], l.a[1], PT), P(l.b[0], l.b[1], PT)), class: "nf lo dash" }, g));

  const mid = mk("g", {}, g);
  const ORDER = [["table", "sil"], ["tableCr", "nf lo"], ["keys", ""], ["stand", ""], ["mon", "sil"], ["monCr", "nf lo"], ["screen", "nf"], ["code", "nf lo"],
    ["seat", "sil"], ["torso", "sil"], ["torsoCr", "nf lo"], ["arms", "nf sil"], ["back", "sil"], ["head", "sil"]];
  const desks = AT.map((c, i) => {
    const grp = mk("g", {}, mid), s = { i, el: grp, key: c[0] + c[1] + 14, z: tween(0), dots: [] };
    ORDER.forEach(([k, cls]) => { s[k] = mk("path", { class: cls }, grp); });
    for (let k = 0; k < 4; k++) s.dots.push(mk("circle", { r: 0.9, class: "dot " + (k === i ? "m" : "off") }, grp));
    return s;
  });
  desks[0].screen.classList.add("hi");

  // two notes per helper, half a lap apart
  const notes = [];
  lanes.forEach((l, k) => [0, 0.5].forEach((ph) => {
    const grp = mk("g", {}, mid);
    notes.push({ l, ph: ph + k * 0.17, el: grp, face: mk("path", { class: "sil" }, grp), fold: mk("path", { class: "nf lo" }, grp), key: 0 });
  }));

  function drawDesk(s, z, t) {
    const q = desk(P, C, front, s.i, z, t), [cx, cy] = AT[s.i];
    const set = (k, d) => s[k].setAttribute("d", d);
    set("table", q.table.sil); set("tableCr", q.table.crease); set("keys", q.keys.sil); set("stand", q.stand.sil);
    set("mon", q.mon.sil); set("monCr", q.mon.crease); set("screen", q.screen); set("code", q.code);
    set("seat", q.seat.sil); set("torso", q.torso.sil); set("torsoCr", q.torso.crease); set("arms", q.arms); set("back", q.back.sil); set("head", q.head);
    s.dots.forEach((el, k) => place(el, P(cx + DW - 4 - (3 - k) * 2.6, cy - DD + 8, PT + DZ + z)));
  }

  function drawNote(n, u) {
    const { l } = n, a = Math.cos(2 * Math.PI * u) * l.half, b = Math.sin(2 * Math.PI * u) * 3.5;
    const c = [l.mid[0] - l.t[0] * a + l.n[0] * b, l.mid[1] - l.t[1] * a + l.n[1] * b];
    const w = (p, q) => [c[0] + l.t[0] * p + l.n[0] * q, c[1] + l.t[1] * p + l.n[1] * q];
    const shape = fillet([w(-5, -3.6), w(5, -3.6), w(5, 3.6), w(-5, 3.6)], [1.2, 1.2, 1.2, 1.2]);
    n.face.setAttribute("d", poly(shape.map((p) => P(p[0], p[1], PT + 0.8))));
    const f0 = w(0, -2.6), f1 = w(0, 2.6);
    n.fold.setAttribute("d", seg(P(f0[0], f0[1], PT + 0.8), P(f1[0], f1[1], PT + 0.8)));
    n.key = c[0] + c[1];
  }

  let clock = 0, order = "";
  const B = register(stage, (dt, now) => {
    if (!reducedMotion()) clock += dt;
    let moving = false;
    desks.forEach((s) => { drawDesk(s, tval(s.z, now), clock); if (!tdone(s.z, now)) moving = true; });
    notes.forEach((n) => drawNote(n, clock * SPEED + n.ph));
    const items = desks.map((s) => ({ el: s.el, key: s.key, id: "d" + s.i })).concat(notes.map((n, k) => ({ el: n.el, key: n.key, id: "n" + k })));
    items.sort((p, q) => p.key - q.key);
    const o = items.map((x) => x.id).join();
    if (o !== order) { order = o; items.forEach((x) => mid.appendChild(x.el)); }
    return moving || !reducedMotion();
  });
  bag.add(B.unregister);

  let act = -1;
  /** Lifts desk n (-1 sets them all down), and moves the bright edge to its screen. */
  function setActive(n) {
    if (n === act) return;
    const now = performance.now();
    act = n;
    desks.forEach((s) => {
      tset(s.z, s.i === n ? lift : 0, now, 0);
      s.screen.classList.toggle("hi", n < 0 ? s.i === 0 : s.i === n);
    });
    read.textContent = n < 0 ? "rest" : WHO[n];
    B.wake();
  }

  // the pointer is read on the plate's top, which never moves; desks are picked by their resting centres
  function hit(p) {
    const [x, y] = unproj(C, p[0], p[1], PT);
    let best = -1, bd = 36;
    AT.forEach(([cx, cy], i) => { const d = Math.hypot(x - cx, y - (cy + 6)); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  read.textContent = "rest";
  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { lift = clamp(v, 0, 30); },
    destroy: bag.dispose,
  };
}

export const agents = {
  name: "agents",
  means: "A lead agent and three helpers at their desks, typing, with notes running between them; the desk nearest the pointer lifts.",
  rules: [1, 4, 6, 7],
  range: [8, 16, 26],
  mount,
};

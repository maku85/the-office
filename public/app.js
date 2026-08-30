// The Office — event-stream client. Maintains office state from the WebSocket
// feed and drives the side panels; the pixel-art view is rendered by render.js.

const canvas = document.getElementById("office");
const logEl = document.getElementById("log");
const approvalsEl = document.getElementById("approvals");
const tasksEl = document.getElementById("tasks");
const goalsEl = document.getElementById("goals");
const usageEl = document.getElementById("usage");
const memoryEl = document.getElementById("memory");
const connEl = document.getElementById("conn");
const sysEl = document.getElementById("sysbar");
const commandForm = document.getElementById("command");
const commandInput = document.getElementById("command-input");
const planEl = document.getElementById("plan");
const planBlock = document.getElementById("plan-block");
const planApprovalCheckbox = document.getElementById("plan-approval");

const TASK_GLYPH = {
  queued: "▪",
  active: "▸",
  reviewing: "◎",
  revision: "↺",
  done: "✓",
  failed: "✗",
};

/* ---------- runtime state ---------- */

const agents = new Map(); // id -> { role, desk, state, task, progress, bubble, bubbleUntil, meetingUntil, meetingSlot, ...render fields }
const approvals = new Map(); // requestId -> { agent, action, detail }
const tasks = new Map(); // taskId -> { title, assignee, status, result }
const goals = new Map(); // goalId -> { text, status, commit }
const memories = new Map(); // id -> { kind, agent, text }
const goalUsage = new Map(); // goalId -> { text, inputTokens, outputTokens, ms, costUsd? }
const plans = new Map(); // requestId -> { goalId, round, tasks }

/* ---------- notification sounds (WebAudio, no files) ---------- */

const sfx = (() => {
  let actx = null;
  let on = false;
  try {
    on = localStorage.getItem("office.sound") === "1";
  } catch {
    /* private mode */
  }

  function play(seq) {
    if (!on) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
      let t = actx.currentTime + 0.01;
      for (const [freq, dur, type] of seq) {
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = type || "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.14, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(actx.destination);
        o.start(t);
        o.stop(t + dur + 0.02);
        t += dur * 0.9;
      }
    } catch {
      /* audio unavailable */
    }
  }

  return {
    get on() {
      return on;
    },
    toggle() {
      on = !on;
      try {
        localStorage.setItem("office.sound", on ? "1" : "0");
      } catch {
        /* ignore */
      }
      if (on)
        play([
          [660, 0.07],
          [990, 0.1],
        ]);
      return on;
    },
    done: () =>
      play([
        [523, 0.09],
        [784, 0.14],
      ]), // goal finished
    fail: () =>
      play([
        [349, 0.12],
        [262, 0.2],
      ]), // goal / task failed
    attention: () =>
      play([
        [880, 0.08, "square"],
        [880, 0.09, "square"],
      ]), // approval needed
    nudge: () => play([[700, 0.06, "triangle"]]), // question / changes
  };
})();

/* ---------- event handling ---------- */

function handle(event) {
  const now = performance.now();
  switch (event.type) {
    case "agent_registered": {
      const existing = agents.get(event.agent) || {};
      agents.set(event.agent, {
        ...existing,
        role: event.role,
        desk: event.desk,
        model: event.model,
        state: "idle",
        task: "",
        progress: 0,
        bubble: "",
        bubbleUntil: 0,
        badge: null, // persistent status glyph: { glyph, color }
        meetingUntil: 0,
        meetingSlot: 0,
        meetingWith: null,
      });
      log(
        `${event.agent} joined as ${event.role}${event.model ? ` · ${event.model}` : ""}`,
        "info",
        event.agent,
      );
      break;
    }
    case "agent_state": {
      const a = agents.get(event.agent);
      if (!a) break;
      a.state = event.state;
      if (event.task !== undefined) a.task = event.task;
      if (event.progress !== undefined) a.progress = event.progress;
      break;
    }
    case "agent_model": {
      const a = agents.get(event.agent);
      if (a) {
        a.model = event.model;
        a.reskin = true; // render.js re-tints the avatar from the model name
        a.bubble = `→ ${event.model}`;
        a.bubbleUntil = performance.now() + 4000;
      }
      log(`${event.agent} → ${event.model} (${event.reason})`, "warn", event.agent);
      sfx.nudge();
      break;
    }
    case "agent_dismissed": {
      const a = agents.get(event.agent);
      if (a) {
        a.leaving = true;
        a.badge = null;
      } // render.js walks them out
      else agents.delete(event.agent);
      log(`${event.agent} left the office`, "info");
      break;
    }
    case "question": {
      const a = agents.get(event.from);
      if (a) {
        a.bubble = `❓ ${event.text}`;
        a.bubbleUntil = now + 7000;
        a.badge = { glyph: "?", color: "#93c5fd" }; // stays until answered
      }
      sfx.nudge();
      log(`asks manager: ${short(event.text, 100)}`, "info", event.from);
      break;
    }
    case "answer": {
      const carol = agents.get("carol");
      if (carol) {
        carol.bubble = event.text;
        carol.bubbleUntil = now + 7000;
      }
      const asker = agents.get(event.to);
      if (asker) asker.badge = null;
      log(`→ ${event.to}: ${short(event.text, 100)}`, "info", "carol");
      break;
    }
    case "agent_message": {
      const a = agents.get(event.agent);
      if (a) {
        a.bubble = event.text;
        a.bubbleUntil = now + 7000;
      }
      const to = event.target && event.target !== "all" ? ` → ${event.target}` : "";
      log(`${event.text}`, "info", `${event.agent}${to}`);
      break;
    }
    case "meeting": {
      const anchorId = event.participants[0];
      event.participants.forEach((id, i) => {
        const a = agents.get(id);
        if (a) {
          a.meetingUntil = now + 4500;
          a.meetingSlot = i;
          a.meetingWith = anchorId; // huddle around the first participant
        }
      });
      log(`meeting: ${event.participants.join(" + ")} — ${event.topic}`, "info");
      break;
    }
    case "goal_update": {
      goals.set(event.goalId, { text: event.text, status: event.status, commit: event.commit });
      renderGoals();
      if (event.usage) {
        goalUsage.set(event.goalId, { text: event.text, ...event.usage });
        renderUsage();
      }
      if (event.status === "done") sfx.done();
      else if (event.status === "failed") sfx.fail();
      log(
        `goal ${event.status}: ${short(event.text, 70)}`,
        event.status === "failed" ? "warn" : "info",
      );
      break;
    }
    case "usage":
      log(
        `${fmtTok(event.inputTokens)} in / ${fmtTok(event.outputTokens)} out · ` +
          `${(event.ms / 1000).toFixed(1)}s · ${event.turns} turn${event.turns === 1 ? "" : "s"}`,
        "info",
        event.agent,
      );
      break;
    case "task_update": {
      const prev = tasks.get(event.taskId);
      tasks.set(event.taskId, {
        title: event.title,
        assignee: event.assignee,
        status: event.status,
        result: event.result,
        priority: event.priority,
        dependsOn: event.dependsOn,
      });
      renderTasks();
      const a = agents.get(event.assignee);
      if (a && event.status !== prev?.status) {
        if (event.status === "done") {
          a.bubble = "✓";
          a.bubbleUntil = now + 2500;
        } else if (event.status === "failed") {
          a.bubble = "✗";
          a.bubbleUntil = now + 3500;
          sfx.fail();
        }
      }
      log(
        `task ${event.status}: ${event.title} (${event.assignee})`,
        event.status === "failed" ? "warn" : "info",
      );
      break;
    }
    case "review": {
      const a = agents.get(event.by);
      const text =
        event.verdict === "approve"
          ? `approved "${short(event.task, 40)}"`
          : `changes needed: ${short(event.feedback || event.task, 90)}`;
      if (a) {
        a.bubble = text;
        a.bubbleUntil = now + 7000;
      }
      if (event.verdict !== "approve") sfx.nudge();
      log(text, event.verdict === "approve" ? "info" : "warn", event.by);
      if (event.suggestions) log(`suggestions: ${short(event.suggestions, 120)}`, "info", event.by);
      break;
    }
    case "skill_use": {
      const a = agents.get(event.agent);
      if (a && event.found) {
        a.libraryUntil = now + 6000; // time to walk there, read a beat, walk back
        a.librarySkill = event.skill;
      }
      log(
        event.found
          ? `went to the library for “${event.skill}”`
          : `looked for skill “${event.skill}” — not found`,
        event.found ? "info" : "warn",
        event.agent,
      );
      break;
    }
    case "board": {
      const a = agents.get(event.by);
      if (a) a.boardUntil = now + 4500; // walk over, move the card, walk back
      const verb =
        {
          post: "pinned a card:",
          claim: "took the card:",
          done: "moved to done:",
          check: "checked the board on:",
        }[event.phase] || "board:";
      log(`${verb} “${short(event.task, 48)}”`, "info", event.by);
      break;
    }
    case "memory_note":
      memories.set(event.id, { kind: event.kind, agent: event.agent, text: event.text });
      renderMemory();
      break;
    case "tool_call": {
      const a = agents.get(event.agent);
      if (a) {
        a.currentTool = event.tool;
        a.toolUntil = now + 6000;
      }
      log(`→ ${event.tool}(${short(JSON.stringify(event.args))})`, "info", event.agent);
      break;
    }
    case "tool_result": {
      const a = agents.get(event.agent);
      if (a) a.toolUntil = now + 500; // let the pose settle, then revert
      log(
        `${event.ok ? "✓" : "✗"} ${event.tool}: ${short(event.summary)}`,
        event.ok ? "info" : "warn",
        event.agent,
      );
      break;
    }
    case "approval_request": {
      approvals.set(event.requestId, {
        agent: event.agent,
        action: event.action,
        detail: event.detail,
      });
      const a = agents.get(event.agent);
      if (a) a.badge = { glyph: "!", color: "#fbbf24" }; // stays until resolved
      renderApprovals();
      sfx.attention();
      log(`needs approval: ${event.action}`, "warn", event.agent);
      break;
    }
    case "approval_resolved": {
      const pending = approvals.get(event.requestId);
      const a = pending && agents.get(pending.agent);
      if (a) a.badge = null;
      approvals.delete(event.requestId);
      renderApprovals();
      log(`approval ${event.approved ? "granted" : "denied"}`, event.approved ? "info" : "warn");
      break;
    }
    case "plan_review": {
      plans.set(event.requestId, { goalId: event.goalId, round: event.round, tasks: event.tasks });
      renderPlans();
      log(
        `plan ready for review (${event.tasks.length} task${event.tasks.length === 1 ? "" : "s"}${event.round > 1 ? `, round ${event.round}` : ""})`,
        "warn",
      );
      sfx.attention();
      break;
    }
    case "plan_resolved": {
      plans.delete(event.requestId);
      renderPlans();
      log(`plan ${event.approved ? "approved" : "sent back"}`, event.approved ? "info" : "warn");
      break;
    }
    case "system":
      renderSystem(event);
      break;
    case "cooldown": {
      const keep = new Set(event.keep || []);
      let slot = 0;
      for (const [id, a] of agents) {
        a.onBreak = event.active && !keep.has(id);
        if (a.onBreak) a.breakSlot = slot++;
      }
      log(
        event.active
          ? `machine under pressure (${event.reason}) — team on break`
          : `machine recovered — back to work`,
        event.active ? "warn" : "info",
      );
      break;
    }
    case "log":
      log(event.text, event.level, event.agent);
      break;
  }
}

/* ---------- machine status ---------- */

function bar(label, used, total, unit, cls) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const level = cls || (pct >= 90 ? "hot" : pct >= 75 ? "warn" : "");
  const fmt = (v) => (unit === "GB" ? (v / 1024).toFixed(1) : Math.round(v));
  return (
    `<div class="row"><span class="lbl">${label}</span>` +
    `<span class="bar ${level}"><span style="width:${pct}%"></span></span>` +
    `<span class="val">${fmt(used)}${total ? " / " + fmt(total) : ""}${unit && total ? " " + unit : unit ? "%" : ""}</span></div>`
  );
}

function renderSystem(s) {
  const rows = [bar("CPU", s.cpu, 100, ""), bar("RAM", s.memUsedMB, s.memTotalMB, "GB")];
  if (s.swapTotalMB) rows.push(bar("swap", s.swapUsedMB || 0, s.swapTotalMB, "GB"));
  const rss = s.procRssMB < 1024 ? `${s.procRssMB}M` : `${(s.procRssMB / 1024).toFixed(1)}G`;
  const meta = [
    `load ${s.load.join(" ")}`,
    `${s.cores} cores`,
    s.tempC != null ? `${s.tempC}°C` : null,
    `office ${rss}`,
  ].filter(Boolean);
  let models = "";
  if (s.models && s.models.length) {
    models =
      `<div class="models">` +
      s.models
        .map(
          (m) =>
            `<div class="m"><span>${m.name}</span><span class="val">${(m.sizeMB / 1024).toFixed(1)}G` +
            `${m.vramMB ? ` · ${(m.vramMB / 1024).toFixed(1)}G vram` : ""}</span></div>`,
        )
        .join("") +
      `</div>`;
  }
  sysEl.innerHTML = rows.join("") + models + `<div class="meta">${meta.join(" · ")}</div>`;
  sysEl.hidden = false;
}

/* ---------- side panel ---------- */

function short(s, n = 80) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtTok(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n);
}

function renderUsage() {
  usageEl.innerHTML = "";
  if (goalUsage.size === 0) {
    usageEl.innerHTML = '<li class="empty">nothing measured yet</li>';
    return;
  }
  let tin = 0,
    tout = 0,
    tms = 0,
    tcost = 0,
    anyCost = false;
  for (const [, u] of goalUsage) {
    tin += u.inputTokens;
    tout += u.outputTokens;
    tms += u.ms;
    if (u.costUsd != null) {
      tcost += u.costUsd;
      anyCost = true;
    }
    const li = document.createElement("li");
    const cost = u.costUsd != null ? ` · $${u.costUsd.toFixed(u.costUsd < 1 ? 4 : 2)}` : "";
    let html =
      `${short(u.text, 60)}<span class="detail">${fmtTok(u.inputTokens)} in / ` +
      `${fmtTok(u.outputTokens)} out · ${(u.ms / 1000).toFixed(0)}s${cost}</span>`;
    if (u.byModel) {
      for (const [m, mu] of Object.entries(u.byModel)) {
        html += `<span class="detail">↳ ${m}: ${fmtTok(mu.inputTokens)} / ${fmtTok(mu.outputTokens)}</span>`;
      }
    }
    li.innerHTML = html;
    usageEl.appendChild(li);
  }
  const total = document.createElement("li");
  total.className = "usage-total";
  total.innerHTML =
    `<strong>session</strong><span class="detail">${fmtTok(tin)} in / ${fmtTok(tout)} out · ` +
    `${(tms / 1000).toFixed(0)}s${anyCost ? ` · $${tcost.toFixed(tcost < 1 ? 4 : 2)}` : ""}</span>`;
  usageEl.appendChild(total);
}

function log(text, level = "info", who) {
  const li = document.createElement("li");
  li.className = level;
  if (who) {
    const span = document.createElement("span");
    span.className = "who";
    span.textContent = who + " ";
    li.appendChild(span);
  }
  li.appendChild(document.createTextNode(text));
  logEl.appendChild(li);
  while (logEl.childElementCount > 160) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderApprovals() {
  approvalsEl.innerHTML = "";
  if (approvals.size === 0) {
    approvalsEl.innerHTML = '<li class="empty">none pending</li>';
    return;
  }
  for (const [requestId, req] of approvals) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="who">${req.agent}</span> ` +
      `<span class="action">${req.action}</span>` +
      `<span class="detail">${short(req.detail, 160)}</span>`;

    const remember = document.createElement("input");
    remember.type = "checkbox";
    const lbl = document.createElement("label");
    lbl.appendChild(remember);
    lbl.appendChild(document.createTextNode("allow this for the rest of the session"));

    for (const [text, approved, cls] of [
      ["approve", true, "approve"],
      ["reject", false, "reject"],
    ]) {
      const b = document.createElement("button");
      b.textContent = text;
      b.className = cls;
      b.onclick = () => {
        send({ type: "approval_decision", requestId, approved, remember: remember.checked });
        approvals.delete(requestId);
        renderApprovals();
      };
      li.appendChild(b);
    }
    li.appendChild(lbl);
    approvalsEl.appendChild(li);
  }
}

function renderPlans() {
  planEl.innerHTML = "";
  planBlock.hidden = plans.size === 0;
  const PRIO = { high: "↑", low: "↓" };
  for (const [requestId, plan] of plans) {
    const li = document.createElement("li");
    const rows = plan.tasks
      .map((t) => {
        const prio = t.priority && PRIO[t.priority] ? `${PRIO[t.priority]} ` : "";
        const dep = t.dependsOn && t.dependsOn.length ? ` ⋯${t.dependsOn.join(", ")}` : "";
        const rev = t.reviewedBy ? ` · review: ${t.reviewedBy}` : "";
        return `<span class="detail">${prio}${short(t.title, 44)} — ${t.assignee}${rev}${dep}</span>`;
      })
      .join("");
    li.innerHTML = `<span class="action">plan${plan.round > 1 ? ` · round ${plan.round}` : ""}</span>${rows}`;

    const fb = document.createElement("input");
    fb.type = "text";
    fb.placeholder = "what to change (for reject)";

    const approve = document.createElement("button");
    approve.textContent = "approve";
    approve.className = "approve";
    approve.onclick = () => {
      send({ type: "plan_decision", requestId, approved: true });
      plans.delete(requestId);
      renderPlans();
    };
    const reject = document.createElement("button");
    reject.textContent = "reject";
    reject.className = "reject";
    reject.onclick = () => {
      send({
        type: "plan_decision",
        requestId,
        approved: false,
        feedback: fb.value.trim() || undefined,
      });
      plans.delete(requestId);
      renderPlans();
    };

    li.appendChild(approve);
    li.appendChild(reject);
    li.appendChild(fb);
    planEl.appendChild(li);
  }
}

function renderGoals() {
  goalsEl.innerHTML = "";
  if (goals.size === 0) {
    goalsEl.innerHTML = '<li class="empty">no goals yet</li>';
    return;
  }
  for (const [goalId, g] of goals) {
    const li = document.createElement("li");
    li.className = g.status;
    li.innerHTML = `<span class="glyph">${TASK_GLYPH[g.status] ?? "•"}</span>${short(g.text, 84)}`;
    if (g.commit) {
      const sha = document.createElement("span");
      sha.className = "commit";
      sha.textContent = g.commit;
      li.appendChild(sha);
      const undo = document.createElement("button");
      undo.className = "undo";
      undo.textContent = "undo";
      undo.onclick = () => send({ type: "undo_goal", goalId });
      li.appendChild(undo);
    }
    goalsEl.appendChild(li);
  }
}

function renderTasks() {
  tasksEl.innerHTML = "";
  if (tasks.size === 0) {
    tasksEl.innerHTML = '<li class="empty">no tasks yet</li>';
    return;
  }
  const PRIO = { high: "↑", low: "↓" };
  for (const t of tasks.values()) {
    const li = document.createElement("li");
    li.className = t.status;
    const prio = PRIO[t.priority] ? `<span class="prio">${PRIO[t.priority]}</span>` : "";
    const dep =
      t.dependsOn && t.dependsOn.length
        ? `<span class="dep" title="waits for: ${t.dependsOn.join(", ")}">⋯</span>`
        : "";
    li.innerHTML =
      `<span class="glyph">${TASK_GLYPH[t.status] ?? "•"}</span>${prio}` +
      `${t.title} <span class="who">${t.assignee}</span>${dep}`;
    tasksEl.appendChild(li);
  }
}

function renderMemory() {
  memoryEl.innerHTML = "";
  if (memories.size === 0) {
    memoryEl.innerHTML = '<li class="empty">nothing on record</li>';
    return;
  }
  for (const m of [...memories.values()].slice(-12).reverse()) {
    const li = document.createElement("li");
    li.className = m.kind;
    li.innerHTML =
      `<span class="kind">${m.kind}</span>` +
      (m.agent ? `<span class="who">${m.agent}</span> ` : "") +
      short(m.text, 120);
    memoryEl.appendChild(li);
  }
}

/* ---------- render loop ---------- */
// The loop stops scheduling frames once the scene is at rest (no one walking,
// no bubbles, camera settled) and resumes on the next event or camera input —
// so an idle office costs ~no CPU instead of repainting 60fps forever.

let sleeping = false;
let settleFrames = 0;

function frame() {
  const busy = renderer.draw(agents, tasks, performance.now());
  if (busy) {
    settleFrames = 0;
    requestAnimationFrame(frame);
  } else if (settleFrames < 3) {
    settleFrames++; // a couple more frames so the resting image is exact
    requestAnimationFrame(frame);
  } else {
    sleeping = true;
  }
}

function wakeRender() {
  settleFrames = 0;
  if (!sleeping) return;
  sleeping = false;
  requestAnimationFrame(frame);
}

const renderer = new OfficeRenderer(canvas, wakeRender);
requestAnimationFrame(frame);

/* ---------- websocket ---------- */

let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => {
    connEl.textContent = "online";
    connEl.className = "online";
  };
  ws.onclose = () => {
    connEl.textContent = "offline — retrying";
    connEl.className = "offline";
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "snapshot") {
      agents.clear();
      approvals.clear();
      plans.clear();
      tasks.clear();
      goals.clear();
      memories.clear();
      logEl.innerHTML = "";
      msg.events.forEach(handle);
      renderApprovals();
      renderPlans();
      renderGoals();
      renderTasks();
      renderMemory();
    } else {
      handle(msg);
    }
    wakeRender(); // any event may change the scene — resume the render loop
  };
}
connect();

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

commandForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;
  send({ type: "command", text, planApproval: planApprovalCheckbox.checked || undefined });
  commandInput.value = "";
});

const soundBtn = document.getElementById("sound-toggle");
function paintSoundBtn() {
  soundBtn.textContent = sfx.on ? "🔊" : "🔇";
  soundBtn.title = `notification sounds: ${sfx.on ? "on" : "off"}`;
  soundBtn.classList.toggle("on", sfx.on);
}
soundBtn.addEventListener("click", () => {
  sfx.toggle();
  paintSoundBtn();
});
paintSoundBtn();

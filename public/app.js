// The Office — event-stream client. Maintains office state from the WebSocket
// feed and drives the side panels; the pixel-art view is rendered by render.js.

const canvas = document.getElementById("office");
const logEl = document.getElementById("log");
const approvalsEl = document.getElementById("approvals");
const tasksEl = document.getElementById("tasks");
const goalsEl = document.getElementById("goals");
const memoryEl = document.getElementById("memory");
const connEl = document.getElementById("conn");
const commandForm = document.getElementById("command");
const commandInput = document.getElementById("command-input");

const TASK_GLYPH = {
  queued: "▪", active: "▸", reviewing: "◎", revision: "↺", done: "✓", failed: "✗",
};

/* ---------- runtime state ---------- */

const agents = new Map(); // id -> { role, desk, state, task, progress, bubble, bubbleUntil, meetingUntil, meetingSlot, ...render fields }
const approvals = new Map(); // requestId -> { agent, action, detail }
const tasks = new Map(); // taskId -> { title, assignee, status, result }
const goals = new Map(); // goalId -> { text, status, commit }
const memories = new Map(); // id -> { kind, agent, text }

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
        meetingUntil: 0,
        meetingSlot: 0,
      });
      log(`${event.agent} joined as ${event.role}${event.model ? ` · ${event.model}` : ""}`,
          "info", event.agent);
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
    case "agent_dismissed": {
      const a = agents.get(event.agent);
      if (a) a.leaving = true; // render.js walks them to the door, then removes
      else agents.delete(event.agent);
      log(`${event.agent} left the office`, "info");
      break;
    }
    case "question": {
      const a = agents.get(event.from);
      if (a) {
        a.bubble = `❓ ${event.text}`;
        a.bubbleUntil = now + 7000;
      }
      log(`asks manager: ${short(event.text, 100)}`, "info", event.from);
      break;
    }
    case "answer": {
      const carol = agents.get("carol");
      if (carol) {
        carol.bubble = event.text;
        carol.bubbleUntil = now + 7000;
      }
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
      event.participants.forEach((id, i) => {
        const a = agents.get(id);
        if (a) {
          a.meetingUntil = now + 4500;
          a.meetingSlot = i;
        }
      });
      log(`meeting: ${event.participants.join(" + ")} — ${event.topic}`, "info");
      break;
    }
    case "goal_update": {
      goals.set(event.goalId, { text: event.text, status: event.status, commit: event.commit });
      renderGoals();
      log(`goal ${event.status}: ${short(event.text, 70)}`,
          event.status === "failed" ? "warn" : "info");
      break;
    }
    case "task_update": {
      tasks.set(event.taskId, {
        title: event.title,
        assignee: event.assignee,
        status: event.status,
        result: event.result,
      });
      renderTasks();
      log(`task ${event.status}: ${event.title} (${event.assignee})`,
          event.status === "failed" ? "warn" : "info");
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
      log(text, event.verdict === "approve" ? "info" : "warn", event.by);
      break;
    }
    case "memory_note":
      memories.set(event.id, { kind: event.kind, agent: event.agent, text: event.text });
      renderMemory();
      break;
    case "tool_call":
      log(`→ ${event.tool}(${short(JSON.stringify(event.args))})`, "info", event.agent);
      break;
    case "tool_result":
      log(`${event.ok ? "✓" : "✗"} ${event.tool}: ${short(event.summary)}`,
          event.ok ? "info" : "warn", event.agent);
      break;
    case "approval_request":
      approvals.set(event.requestId, {
        agent: event.agent,
        action: event.action,
        detail: event.detail,
      });
      renderApprovals();
      log(`needs approval: ${event.action}`, "warn", event.agent);
      break;
    case "approval_resolved":
      approvals.delete(event.requestId);
      renderApprovals();
      log(`approval ${event.approved ? "granted" : "denied"}`,
          event.approved ? "info" : "warn");
      break;
    case "log":
      log(event.text, event.level, event.agent);
      break;
  }
}

/* ---------- side panel ---------- */

function short(s, n = 80) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
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
  for (const t of tasks.values()) {
    const li = document.createElement("li");
    li.className = t.status;
    li.innerHTML =
      `<span class="glyph">${TASK_GLYPH[t.status] ?? "•"}</span>` +
      `${t.title} <span class="who">${t.assignee}</span>`;
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

const renderer = new OfficeRenderer(canvas);
function frame() {
  renderer.draw(agents, performance.now());
  requestAnimationFrame(frame);
}
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
      tasks.clear();
      goals.clear();
      memories.clear();
      logEl.innerHTML = "";
      msg.events.forEach(handle);
      renderApprovals();
      renderGoals();
      renderTasks();
      renderMemory();
    } else {
      handle(msg);
    }
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
  send({ type: "command", text });
  commandInput.value = "";
});

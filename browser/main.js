const defineControlUiPlugin = (p) => p; // host injects ControlUiHost into activate()

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTERS = [
  ["all", "全部"],
  ["pending", "待唤醒"],
  ["fired", "已投递"],
  ["failed", "失败"],
];
const STATUS_LABEL = {
  pending: "待唤醒",
  fired: "已投递",
  failed: "失败",
  unknown: "未知",
};

let mountSeq = 0;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function svgIcon(parts, cls) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (cls) svg.setAttribute("class", cls);
  for (const [tag, attrs] of parts) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const name of Object.keys(attrs)) child.setAttribute(name, attrs[name]);
    svg.appendChild(child);
  }
  return svg;
}

function clockIcon(cls) {
  return svgIcon(
    [
      ["circle", { cx: "12", cy: "12", r: "9" }],
      ["polyline", { points: "12 7 12 12 15.5 14" }],
    ],
    cls,
  );
}

function refreshIcon(cls) {
  return svgIcon(
    [
      ["path", { d: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4" }],
      ["path", { d: "M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" }],
    ],
    cls,
  );
}

function trashIcon(cls) {
  return svgIcon(
    [
      ["path", { d: "M4 7h16" }],
      ["path", { d: "M9 7V4h6v3" }],
      ["path", { d: "M6 7l1 13h10l1-13" }],
      ["path", { d: "M10 11v5M14 11v5" }],
    ],
    cls,
  );
}

function alertIcon(cls) {
  return svgIcon(
    [
      ["path", { d: "M12 4 3.5 19h17z" }],
      ["path", { d: "M12 9.5v4.5" }],
      ["path", { d: "M12 17h.01" }],
    ],
    cls,
  );
}

function inboxIcon(cls) {
  return svgIcon(
    [
      ["path", { d: "M4 6h16v12H4z" }],
      ["path", { d: "M4 13h5l1.5 2h3L15 13h5" }],
    ],
    cls,
  );
}

function shortKey(key) {
  const value = String(key || "");
  const match = /^agent:([^:]+):([^:]+):(.+)$/.exec(value);
  if (match) {
    const id = match[3];
    const shortId = id.length > 12 ? id.slice(0, 8) + "…" : id;
    return match[1] + ":" + match[2] + ":" + shortId;
  }
  if (value.length > 32) return value.slice(0, 14) + "…" + value.slice(-8);
  return value;
}

function fmtLocal(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const opts = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  try {
    return new Intl.DateTimeFormat("zh-CN", opts).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function fmtClock(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return mins + " 分钟";
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? hours + " 小时 " + rest + " 分钟" : hours + " 小时";
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? days + " 天 " + remHours + " 小时" : days + " 天";
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function updatedAtMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function errorText(error) {
  let text = "";
  if (error && typeof error === "object" && "message" in error) text = String(error.message || "");
  else if (error != null) text = String(error);
  text = text.replace(/^Error:\s*/i, "").trim();
  if (!text) text = "未知错误";
  return text.length > 240 ? text.slice(0, 240) + "…" : text;
}

function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

function sessionKeyValue(value) {
  return typeof value === "string" && /^agent:[^\s:]+:[^\s]+$/.test(value) ? value : "";
}

function statusOf(wake) {
  const raw = wake && wake.status != null ? String(wake.status) : "";
  return STATUS_LABEL[raw] ? raw : "unknown";
}

function statusLabel(wake) {
  return STATUS_LABEL[statusOf(wake)] || STATUS_LABEL.unknown;
}

export default defineControlUiPlugin({
  id: "session-wakes",
  activate(host) {
    const disposers = [];

    const page = {
      id: "session-wakes",
      label: "Wakes",
      mount(container, ctx) {
        mountSeq += 1;
        const uid = "sw-" + mountSeq;
        const ids = {
          session: uid + "-session",
          sessionHelp: uid + "-session-help",
          sessionKey: uid + "-session-key",
          time: uid + "-time",
          timeHelp: uid + "-time-help",
          message: uid + "-message",
          messageHelp: uid + "-message-help",
          feedback: uid + "-feedback",
          composerTitle: uid + "-composer-title",
          queueTitle: uid + "-queue-title",
        };

        container.textContent = "";
        container.classList.add("sw-root");
        container.dataset.swMount = uid;

        let disposed = false;
        let pollTimer = null;
        let listInFlight = false;
        let listQueued = false;
        let listSeq = 0;
        let wakes = [];
        let loadedOnce = false;
        let listError = null;
        let lastLoadedAt = null;
        let submitting = false;
        let filter = "all";
        let scopedKey = sessionKeyValue(ctx && ctx.props && ctx.props.sessionKey);
        let selectedKey = scopedKey;
        let sessionSignature = "";
        let sessionLookup = new Map();
        let connected = false;
        const deleting = new Set();
        const deleteErrors = new Map();
        const removedIds = new Set();

        /* ---------------- header ---------------- */

        const header = el("header", "sw-head sw-header");
        const identity = el("div", "sw-identity");
        const logo = el("span", "sw-logo");
        logo.setAttribute("aria-hidden", "true");
        logo.appendChild(clockIcon("sw-icon sw-icon--lg"));

        const heading = el("div", "sw-heading");
        const title = el("h2", "sw-title", "Session Wakes");
        const subtitle = el(
          "p",
          "sw-subtitle",
          "安排定时唤醒，到点向指定会话投递一条消息。",
        );
        heading.append(title, subtitle);
        identity.append(logo, heading);

        const connection = el("div", "sw-connection");
        connection.setAttribute("role", "status");
        connection.setAttribute("aria-live", "polite");
        connection.dataset.state = "unknown";
        const connectionDot = el("span", "sw-conn-dot");
        connectionDot.setAttribute("aria-hidden", "true");
        const connectionText = el("span", "sw-conn-text", "正在检测连接…");
        connection.append(connectionDot, connectionText);
        header.append(identity, connection);

        container.appendChild(header);

        const scopeBanner = el("div", "sw-banner sw-scope");
        scopeBanner.hidden = !scopedKey;
        scopeBanner.setAttribute("aria-label", "会话筛选");
        const scopeCopy = el("div", "sw-banner-copy");
        const scopeText = el("span", "sw-banner-text");
        const showAll = el("button", "sw-banner-action", "查看全部会话");
        showAll.type = "button";
        showAll.addEventListener("click", () => navigateScope(""));
        scopeCopy.append(scopeText, showAll);
        scopeBanner.appendChild(scopeCopy);
        container.appendChild(scopeBanner);

        /* ---------------- overview ---------------- */

        const overview = el("section", "sw-metrics");
        overview.setAttribute("aria-label", "队列概览");
        overview.title = "基于最近一次同步的队列数据";
        const metricValues = {};
        for (const [key, label] of [
          ["pending", "待唤醒"],
          ["fired", "已投递"],
          ["failed", "失败"],
        ]) {
          const tile = el("div", "sw-metric");
          tile.dataset.tone = key;
          const dot = el("span", "sw-metric-dot");
          dot.setAttribute("aria-hidden", "true");
          const name = el("span", "sw-metric-label", label);
          const value = el("span", "sw-metric-value", "—");
          tile.append(dot, name, value);
          overview.appendChild(tile);
          metricValues[key] = value;
        }
        container.appendChild(overview);

        /* ---------------- layout ---------------- */

        const layout = el("div", "sw-layout");

        /* ---------------- composer ---------------- */

        const composer = el("section", "sw-card sw-panel sw-composer");
        composer.setAttribute("aria-labelledby", ids.composerTitle);

        const composerHead = el("div", "sw-panel-head");
        const composerTitle = el("h3", "sw-panel-title", "安排唤醒");
        composerTitle.id = ids.composerTitle;
        const composerSubtitle = el(
          "p",
          "sw-panel-sub",
          "选会话、定时间、写消息，提交后进入队列。",
        );
        const composerTitleWrap = el("div");
        composerTitleWrap.append(composerTitle, composerSubtitle);
        composerHead.appendChild(composerTitleWrap);

        const form = el("form", "sw-form");
        form.noValidate = true;

        const fieldSession = el("div", "sw-field");
        const headSession = el("div", "sw-field-head");
        const stepSession = el("span", "sw-step", "1");
        stepSession.setAttribute("aria-hidden", "true");
        const labelSession = el("label", "sw-label", "目标会话");
        labelSession.htmlFor = ids.session;
        headSession.append(stepSession, labelSession);
        fieldSession.appendChild(headSession);

        const select = el("select", "sw-key");
        select.id = ids.session;
        select.required = true;
        select.setAttribute(
          "aria-describedby",
          ids.sessionHelp + " " + ids.sessionKey,
        );
        const placeholder = el("option", null, "选择目标会话…");
        placeholder.value = "";
        select.appendChild(placeholder);
        fieldSession.appendChild(select);

        const sessionHelp = el(
          "p",
          "sw-help",
          "列表按最近活跃排序，最多显示 200 个会话。",
        );
        sessionHelp.id = ids.sessionHelp;
        fieldSession.appendChild(sessionHelp);

        const keyLine = el("p", "sw-key-line is-empty");
        keyLine.id = ids.sessionKey;
        keyLine.appendChild(el("span", "sw-key-line-label", "完整会话键"));
        const keyCode = el("code", "sw-key-full", "尚未选择会话");
        keyLine.appendChild(keyCode);
        fieldSession.appendChild(keyLine);
        form.appendChild(fieldSession);

        const fieldTime = el("div", "sw-field");
        const headTime = el("div", "sw-field-head");
        const stepTime = el("span", "sw-step", "2");
        stepTime.setAttribute("aria-hidden", "true");
        const labelTime = el("label", "sw-label", "投递时间");
        labelTime.htmlFor = ids.time;
        const optional = el("span", "sw-optional", "可选");
        headTime.append(stepTime, labelTime, optional);
        fieldTime.appendChild(headTime);

        const atInput = el("input", "sw-at");
        atInput.id = ids.time;
        atInput.type = "datetime-local";
        atInput.setAttribute("aria-describedby", ids.timeHelp);
        atInput.autocomplete = "off";
        fieldTime.appendChild(atInput);

        const presets = el("div", "sw-presets");
        presets.setAttribute("role", "group");
        presets.setAttribute("aria-label", "快捷时间");
        const presetDefs = [
          ["现在", 0],
          ["+5 分钟", 5 * 60 * 1000],
          ["+30 分钟", 30 * 60 * 1000],
          ["+1 小时", 60 * 60 * 1000],
        ];
        for (const [label, offset] of presetDefs) {
          const button = el("button", "sw-preset", label);
          button.type = "button";
          button.addEventListener("click", () => {
            atInput.value = localInputValue(new Date(Date.now() + offset));
            updateTimeHint();
          });
          presets.appendChild(button);
        }
        const clearPreset = el("button", "sw-preset", "清空");
        clearPreset.type = "button";
        clearPreset.addEventListener("click", () => {
          atInput.value = "";
          updateTimeHint();
        });
        presets.appendChild(clearPreset);
        fieldTime.appendChild(presets);

        const timeNote = el("p", "sw-help sw-time-note");
        timeNote.id = ids.timeHelp;
        fieldTime.appendChild(timeNote);
        form.appendChild(fieldTime);

        const fieldMessage = el("div", "sw-field");
        const headMessage = el("div", "sw-field-head");
        const stepMessage = el("span", "sw-step", "3");
        stepMessage.setAttribute("aria-hidden", "true");
        const labelMessage = el("label", "sw-label", "消息");
        labelMessage.htmlFor = ids.message;
        const counter = el("span", "sw-counter", "2 字");
        headMessage.append(stepMessage, labelMessage, counter);
        fieldMessage.appendChild(headMessage);

        const msg = el("textarea", "sw-msg");
        msg.id = ids.message;
        msg.rows = 3;
        msg.value = "继续";
        msg.setAttribute("aria-describedby", ids.messageHelp);
        fieldMessage.appendChild(msg);

        const messageHelp = el(
          "p",
          "sw-help",
          "到点后作为一条消息发送；留空时使用默认消息「继续」。",
        );
        messageHelp.id = ids.messageHelp;
        fieldMessage.appendChild(messageHelp);
        form.appendChild(fieldMessage);

        const addBtn = el("button", "sw-add sw-primary");
        addBtn.type = "submit";
        addBtn.setAttribute("data-testid", "sw-create");
        const buttonIcon = el("span", "sw-btn-icon");
        buttonIcon.setAttribute("aria-hidden", "true");
        buttonIcon.appendChild(clockIcon("sw-icon"));
        const buttonSpinner = el("span", "sw-spinner");
        buttonSpinner.hidden = true;
        buttonSpinner.setAttribute("aria-hidden", "true");
        const buttonLabel = el("span", "sw-btn-label", "安排唤醒");
        addBtn.append(buttonIcon, buttonSpinner, buttonLabel);
        form.appendChild(addBtn);

        const feedback = el("p", "sw-formmsg sw-feedback");
        feedback.id = ids.feedback;
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        feedback.setAttribute("aria-atomic", "true");
        form.appendChild(feedback);

        composer.append(composerHead, form);
        layout.appendChild(composer);

        /* ---------------- queue ---------------- */

        const queueCard = el("section", "sw-card sw-panel sw-queue");
        queueCard.setAttribute("aria-labelledby", ids.queueTitle);

        const queueHead = el("div", "sw-panel-head sw-queue-head");
        const queueTitleWrap = el("div");
        const queueTitle = el("h3", "sw-panel-title", "唤醒队列");
        queueTitle.id = ids.queueTitle;
        const queueSub = el("p", "sw-panel-sub");
        const updated = el("span", "sw-updated", "尚未同步");
        const sep = el("span", "sw-sep", "·");
        sep.setAttribute("aria-hidden", "true");
        const autoNote = el("span", null, "每 20 秒自动刷新");
        queueSub.append(updated, sep, autoNote);
        queueTitleWrap.append(queueTitle, queueSub);

        const refreshBtn = el("button", "sw-iconbtn sw-refresh");
        refreshBtn.type = "button";
        refreshBtn.setAttribute("data-testid", "sw-refresh");
        refreshBtn.setAttribute("aria-label", "刷新队列");
        refreshBtn.title = "刷新队列";
        refreshBtn.appendChild(refreshIcon("sw-icon"));
        queueHead.append(queueTitleWrap, refreshBtn);
        queueCard.appendChild(queueHead);

        const filters = el("div", "sw-filters");
        filters.setAttribute("role", "group");
        filters.setAttribute("aria-label", "按状态筛选队列");
        const filterRefs = {};
        for (const [value, label] of FILTERS) {
          const button = el("button", "sw-filter");
          button.type = "button";
          button.dataset.filter = value;
          button.setAttribute("aria-label", label);
          button.setAttribute("data-testid", "sw-filter-" + value);
          button.setAttribute("aria-pressed", value === filter ? "true" : "false");
          const filterLabel = el("span", "sw-filter-label", label);
          const filterCount = el("span", "sw-filter-count", "—");
          filterCount.setAttribute("aria-hidden", "true");
          button.append(filterLabel, filterCount);
          button.addEventListener("click", () => {
            if (filter === value) return;
            filter = value;
            syncFilters();
            renderQueue();
          });
          filters.appendChild(button);
          filterRefs[value] = { button, count: filterCount };
        }
        queueCard.appendChild(filters);

        const queueBody = el("div", "sw-queue-body");
        queueCard.appendChild(queueBody);
        const queueLive = el("p", "sw-sr-only");
        queueLive.setAttribute("role", "status");
        queueLive.setAttribute("aria-live", "polite");
        queueCard.appendChild(queueLive);
        layout.appendChild(queueCard);
        container.appendChild(layout);

        /* ---------------- shared helpers ---------------- */

        function readConnected() {
          try {
            return !!(host.connection && host.connection.connected);
          } catch {
            return false;
          }
        }

        function updateConnection(force) {
          if (disposed) return;
          const next = readConnected();
          if (!force && next === connected) return;
          connected = next;
          connection.dataset.state = next ? "online" : "offline";
          connectionText.textContent = next ? "已连接" : "未连接";
          connection.title = next ? "与网关的连接正常" : "与网关的连接已断开";
          connection.setAttribute(
            "aria-label",
            next ? "连接状态：已连接" : "连接状态：未连接",
          );
          updateCreateAvailability();
        }

        function setFeedback(text, tone) {
          if (disposed) return;
          feedback.textContent = text || "";
          feedback.dataset.tone = tone || "";
        }

        function setSubmitting(next) {
          submitting = next;
          if (disposed) return;
          addBtn.classList.toggle("is-loading", next);
          addBtn.setAttribute("aria-busy", next ? "true" : "false");
          buttonIcon.hidden = next;
          buttonSpinner.hidden = !next;
          buttonLabel.textContent = next ? "正在安排…" : "安排唤醒";
          updateCreateAvailability();
        }

        function updateCreateAvailability() {
          if (disposed) return;
          const disabled = submitting || !connected;
          addBtn.disabled = disabled;
          addBtn.setAttribute("aria-disabled", disabled ? "true" : "false");
          if (submitting) addBtn.title = "正在安排唤醒…";
          else if (!connected) addBtn.title = "连接断开时无法安排唤醒";
          else addBtn.title = "";
        }

        function updateTimeHint() {
          if (disposed) return;
          timeNote.classList.remove("is-warn");
          if (!atInput.value) {
            timeNote.textContent = "留空表示立即投递。";
            return;
          }
          const date = new Date(atInput.value);
          if (Number.isNaN(date.getTime())) {
            timeNote.textContent = "时间格式无效，请重新选择。";
            timeNote.classList.add("is-warn");
            return;
          }
          if (date.getTime() < Date.now()) {
            timeNote.textContent = "该时间已过，服务端会在下一轮检查时立即投递。";
            timeNote.classList.add("is-warn");
          } else {
            timeNote.textContent = "按本地时间投递；注入器约每 10 秒检查一次。";
          }
        }

        function updateCounter() {
          if (disposed) return;
          const length = Array.from(msg.value).length;
          counter.textContent = length + " 字";
        }

        function updateSelectedKeyInfo() {
          if (disposed) return;
          const key = selectedKey || select.value || "";
          keyCode.textContent = key || "尚未选择会话";
          keyCode.title = key;
          select.title = key;
          keyLine.classList.toggle("is-empty", !key);
          scopeBanner.hidden = !scopedKey;
          scopeText.textContent = scopedKey ? "当前会话：「" + sessionTitle(scopedKey) + "」 · " + shortKey(scopedKey) : "";
          scopeText.title = scopedKey;
        }

        function sessionTitle(key) {
          const row = key ? sessionLookup.get(String(key)) : null;
          const name = row && row.displayName != null ? String(row.displayName).trim() : "";
          return name || "未命名会话";
        }

        function fillSessions(force) {
          if (disposed) return;
          let rows = [];
          try {
            rows = (host.sessions && host.sessions.rows) || [];
          } catch {
            rows = [];
          }
          if (disposed) return;

          const all = [];
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (row && row.key) all.push(row);
            }
          }
          sessionLookup = new Map();
          for (const row of all) sessionLookup.set(String(row.key), row);

          const sorted = all
            .slice()
            .sort((a, b) => updatedAtMs(b.updatedAt) - updatedAtMs(a.updatedAt))
            .slice(0, 200);
          const signature = sorted
            .map(
              (row) =>
                String(row.key) +
                "\u0000" +
                (row.displayName == null ? "" : String(row.displayName)),
            )
            .join("\u0001");

          if (!force && signature === sessionSignature) {
            updateSelectedKeyInfo();
            return;
          }
          sessionSignature = signature;

          const hadFocus = document.activeElement === select;
          const current = selectedKey || select.value || "";
          select.textContent = "";

          const emptyOption = el("option", null, "选择目标会话…");
          emptyOption.value = "";
          emptyOption.selected = !current;
          select.appendChild(emptyOption);

          let found = false;
          for (const row of sorted) {
            const key = String(row.key);
            const name = row.displayName == null ? "" : String(row.displayName).trim();
            const option = el("option");
            option.value = key;
            option.textContent = name ? name + " · " + shortKey(key) : shortKey(key);
            option.title = key;
            if (key === current) {
              option.selected = true;
              found = true;
            }
            select.appendChild(option);
          }

          if (current && !found) {
            const option = el(
              "option",
              null,
              "已选会话（不在当前列表）· " + shortKey(current),
            );
            option.value = current;
            option.title = current;
            option.selected = true;
            select.appendChild(option);
          }

          selectedKey = current;
          updateSelectedKeyInfo();
          if (hadFocus) select.focus({ preventScroll: true });
        }

        function scopedWakes() {
          return scopedKey ? wakes.filter((wake) => wake.key === scopedKey) : wakes;
        }

        function applyScope(value) {
          if (disposed) return;
          const next = sessionKeyValue(value);
          if (next === scopedKey) return;
          scopedKey = next;
          if (next) selectedKey = next;
          fillSessions(true);
          renderQueue();
        }

        function navigateScope(key) {
          applyScope(key);
          if (host.navigation && typeof host.navigation.openPage === "function") {
            host.navigation.openPage({ id: "session-wakes", params: key ? { sessionKey: key } : {} }, { replace: true });
          }
        }

        function countStatuses() {
          const visible = scopedWakes();
          const counts = { all: visible.length, pending: 0, fired: 0, failed: 0 };
          for (const wake of visible) {
            const status = statusOf(wake);
            if (status === "pending" || status === "fired" || status === "failed") {
              counts[status] += 1;
            }
          }
          return counts;
        }

        function syncFilters() {
          if (disposed) return;
          const counts = countStatuses();
          for (const [value] of FILTERS) {
            const ref = filterRefs[value];
            if (!ref) continue;
            ref.button.setAttribute("aria-pressed", value === filter ? "true" : "false");
            ref.count.textContent = loadedOnce ? String(counts[value] || 0) : "—";
          }
        }

        function updateMetrics() {
          if (disposed) return;
          const counts = countStatuses();
          for (const key of ["pending", "fired", "failed"]) {
            metricValues[key].textContent = loadedOnce ? String(counts[key] || 0) : "—";
          }
        }

        function updateRefreshUi() {
          if (disposed) return;
          refreshBtn.disabled = listInFlight;
          refreshBtn.classList.toggle("is-spinning", listInFlight);
          refreshBtn.setAttribute("aria-busy", listInFlight ? "true" : "false");
          refreshBtn.setAttribute(
            "aria-label",
            listInFlight ? "正在刷新队列" : "刷新队列",
          );
          refreshBtn.title = listInFlight ? "正在刷新队列" : "刷新队列";

          if (listInFlight) {
            updated.textContent = loadedOnce ? "正在刷新…" : "正在同步…";
          } else if (lastLoadedAt) {
            updated.textContent =
              "更新于 " + fmtClock(lastLoadedAt) + (listError ? " · 刷新失败" : "");
          } else if (listError) {
            updated.textContent = "同步失败";
          } else {
            updated.textContent = "尚未同步";
          }

          queueBody.setAttribute(
            "aria-busy",
            !loadedOnce && listInFlight ? "true" : "false",
          );
        }

        function sortedWakes() {
          return scopedWakes()
            .filter((wake) => filter === "all" || statusOf(wake) === filter)
            .slice()
            .sort((a, b) => {
              const aPending = statusOf(a) === "pending" ? 0 : 1;
              const bPending = statusOf(b) === "pending" ? 0 : 1;
              if (aPending !== bPending) return aPending - bPending;
              if (aPending === 0) {
                const aTime = a.deliverAt ? Date.parse(a.deliverAt) : -Infinity;
                const bTime = b.deliverAt ? Date.parse(b.deliverAt) : -Infinity;
                const safeA = Number.isNaN(aTime) ? Infinity : aTime;
                const safeB = Number.isNaN(bTime) ? Infinity : bTime;
                if (safeA !== safeB) return safeA - safeB;
                return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
              }
              return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
            });
        }

        function renderBanner(tone, text, actionLabel, action) {
          const banner = el("div", "sw-banner");
          banner.dataset.tone = tone;
          const iconWrap = el("span", "sw-banner-icon");
          iconWrap.setAttribute("aria-hidden", "true");
          iconWrap.appendChild(alertIcon("sw-icon"));
          const copy = el("div", "sw-banner-copy");
          copy.appendChild(el("span", "sw-banner-text", text));
          if (action) {
            const button = el("button", "sw-banner-action", actionLabel);
            button.type = "button";
            button.addEventListener("click", action);
            copy.appendChild(button);
          }
          banner.append(iconWrap, copy);
          return banner;
        }

        function renderState(tone, icon, headingText, detailText, actionLabel, action) {
          const state = el("div", "sw-state");
          if (tone) state.dataset.tone = tone;
          const iconWrap = el("span", "sw-state-icon");
          iconWrap.setAttribute("aria-hidden", "true");
          iconWrap.appendChild(icon);
          const heading = el("strong", "sw-state-title", headingText);
          const detail = el("p", "sw-state-detail", detailText);
          state.append(iconWrap, heading, detail);
          if (action) {
            const button = el("button", "sw-secondary", actionLabel);
            button.type = "button";
            button.addEventListener("click", action);
            state.appendChild(button);
          }
          return state;
        }

        function whenNode(wake) {
          const status = statusOf(wake);
          const planned = parseDate(wake.deliverAt);
          const fired = parseDate(wake.firedAt);
          const created = parseDate(wake.createdAt);
          const item = el("span", "sw-meta-item");
          const iconWrap = el("span", "sw-meta-icon");
          iconWrap.setAttribute("aria-hidden", "true");
          iconWrap.appendChild(clockIcon("sw-icon sw-icon--xs"));
          item.appendChild(iconWrap);

          let label = "立即投递";
          let moment = null;
          if (status === "fired" && fired) {
            label = "投递于 " + fmtLocal(fired);
            moment = fired;
          } else if (planned) {
            label = "计划 " + fmtLocal(planned);
            moment = planned;
          } else if (status === "fired") {
            label = "已投递";
          }

          const time = el("time", "sw-meta-strong", label);
          if (moment) time.dateTime = moment.toISOString();
          item.appendChild(time);

          if (status === "pending" && planned) {
            const diff = planned.getTime() - Date.now();
            const hint = el("span", "sw-meta-hint");
            if (diff >= 60000) hint.textContent = "约 " + fmtDuration(diff) + "后";
            else if (diff > 0) hint.textContent = "不到 1 分钟后";
            else hint.textContent = "已到期，等待投递";
            item.appendChild(hint);
          }

          const titleParts = [];
          if (created) titleParts.push("创建于 " + created.toLocaleString("zh-CN"));
          if (planned) titleParts.push("计划 " + planned.toLocaleString("zh-CN"));
          if (fired) titleParts.push("投递 " + fired.toLocaleString("zh-CN"));
          if (titleParts.length) item.title = titleParts.join(" · ");
          return item;
        }

        function rowElement(wake) {
          const status = statusOf(wake);
          const id = wake.id == null ? "" : String(wake.id);
          const key = wake.key == null ? "" : String(wake.key);
          const row = el("li", "sw-row");
          row.dataset.status = status;
          if (id) row.dataset.wakeId = id;

          const top = el("div", "sw-row-top");
          const session = el("div", "sw-row-session");
          const name = sessionTitle(key);
          const nameEl = el("span", "sw-row-title", name);
          nameEl.title = name;
          const keyEl = el("code", "sw-row-key", key ? shortKey(key) : "（缺少会话键）");
          if (key) keyEl.title = key;
          session.append(nameEl, keyEl);

          const pill = el("span", "sw-pill");
          pill.dataset.status = status;
          const pillDot = el("span", "sw-pill-dot");
          pillDot.setAttribute("aria-hidden", "true");
          pill.append(pillDot, el("span", null, statusLabel(wake)));

          const del = el("button", "sw-del");
          del.type = "button";
          del.setAttribute("data-action", "delete");
          del.setAttribute(
            "aria-label",
            "删除「" + name + "」的这条唤醒",
          );
          del.title = "删除这条唤醒";
          del.appendChild(trashIcon("sw-icon"));
          if (deleting.has(id)) {
            del.disabled = true;
            del.classList.add("is-busy");
            del.setAttribute("aria-busy", "true");
          }
          del.addEventListener("click", () => {
            void handleDelete(wake, id, del);
          });
          top.append(session, pill, del);

          const message = el(
            "p",
            "sw-row-message",
            wake.message == null || wake.message === ""
              ? "（空消息）"
              : String(wake.message),
          );

          const meta = el("div", "sw-row-meta");
          meta.appendChild(whenNode(wake));
          const attempts = el("span", "sw-meta-item");
          const attemptsIcon = el("span", "sw-meta-icon");
          attemptsIcon.setAttribute("aria-hidden", "true");
          attemptsIcon.appendChild(refreshIcon("sw-icon sw-icon--xs"));
          attempts.appendChild(attemptsIcon);
          attempts.appendChild(
            el("span", null, "尝试 " + String(Number(wake.attempts) || 0) + " 次"),
          );
          meta.appendChild(attempts);

          row.append(top, message, meta);

          if (wake.lastError) {
            const details = el("details", "sw-row-details");
            const summary = el(
              "summary",
              null,
              status === "failed" ? "查看失败原因" : "查看上次错误",
            );
            const detail = el("pre", "sw-row-detail", String(wake.lastError));
            details.append(summary, detail);
            row.appendChild(details);
          }

          const deleteError = id ? deleteErrors.get(id) : "";
          if (deleteError) {
            const error = el("p", "sw-row-error", "删除失败：" + deleteError);
            row.appendChild(error);
          }

          return row;
        }

        function captureRowFocus() {
          const active = document.activeElement;
          if (!active || !queueBody.contains(active) || !active.closest) return null;
          const row = active.closest("[data-wake-id]");
          if (!row) return null;
          return {
            id: row.getAttribute("data-wake-id"),
            action: active.getAttribute("data-action") || "",
          };
        }

        function restoreRowFocus(state) {
          if (!state || disposed) return;
          const rows = queueBody.querySelectorAll("[data-wake-id]");
          for (const row of rows) {
            if (row.getAttribute("data-wake-id") !== state.id) continue;
            const target = state.action
              ? row.querySelector('[data-action="' + state.action + '"]')
              : row;
            if (target && typeof target.focus === "function") {
              target.focus({ preventScroll: true });
            }
            return;
          }
        }

        function renderQueue() {
          if (disposed) return;
          const focusState = captureRowFocus();
          syncFilters();
          updateMetrics();
          updateRefreshUi();
          queueBody.textContent = "";

          if (!loadedOnce) {
            if (listError && !connected) {
              queueBody.appendChild(
                renderState(
                  "error",
                  alertIcon("sw-icon sw-icon--state"),
                  "尚未连接到网关",
                  "与网关的连接已断开。恢复连接后，队列会自动重新同步。",
                  "重试",
                  () => requestQueueRefresh(),
                ),
              );
            } else if (listError) {
              queueBody.appendChild(
                renderState(
                  "error",
                  alertIcon("sw-icon sw-icon--state"),
                  "队列加载失败",
                  listError,
                  "重试",
                  () => requestQueueRefresh(),
                ),
              );
            } else {
              const state = el("div", "sw-state");
              const spinner = el("span", "sw-spinner sw-spinner--lg");
              spinner.setAttribute("aria-hidden", "true");
              state.append(
                spinner,
                el("strong", "sw-state-title", "正在读取唤醒队列…"),
                el("p", "sw-state-detail", "正在向网关请求最新数据。"),
              );
              state.setAttribute("role", "status");
              queueBody.appendChild(state);
            }
            restoreRowFocus(focusState);
            return;
          }

          if (!connected) {
            queueBody.appendChild(
              renderBanner(
                "warn",
                "连接已断开，队列可能不是最新。",
                "重试",
                () => requestQueueRefresh(),
              ),
            );
          }
          if (listError) {
            queueBody.appendChild(
              renderBanner(
                "error",
                "刷新失败，正在显示上次同步的数据：" + listError,
                "重试",
                () => requestQueueRefresh(),
              ),
            );
          }

          const list = sortedWakes();
          if (!list.length) {
            if (!scopedWakes().length) {
              queueBody.appendChild(
                renderState(
                  "empty",
                  inboxIcon("sw-icon sw-icon--state"),
                  scopedKey ? "这个会话还没有唤醒任务" : "队列还是空的",
                  "在「安排唤醒」表单里安排第一条任务，到点后会自动投递。",
                ),
              );
            } else {
              const activeLabel =
                (FILTERS.find(([value]) => value === filter) || [null, "该状态"])[1];
              queueBody.appendChild(
                renderState(
                  "empty",
                  inboxIcon("sw-icon sw-icon--state"),
                  "没有匹配的唤醒",
                  "当前筛选为「" + activeLabel + "」，换一个筛选条件试试。",
                  "查看全部",
                  () => {
                    filter = "all";
                    syncFilters();
                    renderQueue();
                    filterRefs.all.button.focus({ preventScroll: true });
                  },
                ),
              );
            }
            restoreRowFocus(focusState);
            return;
          }

          const listEl = el("ul", "sw-rows");
          for (const wake of list) listEl.appendChild(rowElement(wake));
          queueBody.appendChild(listEl);
          restoreRowFocus(focusState);
        }

        async function refreshQueue() {
          if (disposed) return;
          if (listInFlight) {
            listQueued = true;
            return;
          }
          listInFlight = true;
          const seq = ++listSeq;
          updateRefreshUi();
          if (!loadedOnce) renderQueue();

          try {
            const result = await host.request("sessionwakes.wakes.list", {});
            if (disposed || seq !== listSeq) return;
            wakes =
              result && Array.isArray(result.wakes)
                ? result.wakes.filter(
                    (wake) =>
                      wake &&
                      typeof wake === "object" &&
                      !removedIds.has(String(wake.id)),
                  )
                : [];
            loadedOnce = true;
            listError = null;
            lastLoadedAt = new Date();
          } catch (error) {
            if (disposed || seq !== listSeq) return;
            listError = errorText(error);
          } finally {
            if (seq === listSeq) {
              listInFlight = false;
              if (!disposed) {
                renderQueue();
                if (listQueued) {
                  listQueued = false;
                  requestQueueRefresh();
                }
              } else {
                listQueued = false;
              }
            }
          }
        }

        function requestQueueRefresh() {
          if (disposed) return;
          if (listInFlight) {
            listQueued = true;
            return;
          }
          void refreshQueue();
        }

        function findDeleteButton(id) {
          const rows = queueBody.querySelectorAll("[data-wake-id]");
          for (const row of rows) {
            if (row.getAttribute("data-wake-id") === String(id)) {
              return row.querySelector(".sw-del");
            }
          }
          return null;
        }

        async function handleDelete(wake, id, button) {
          if (disposed || !id || deleting.has(id)) return;
          deleting.add(id);
          deleteErrors.delete(id);
          button.disabled = true;
          button.classList.add("is-busy");
          button.setAttribute("aria-busy", "true");

          try {
            const result = await host.request("sessionwakes.wakes.delete", {
              id: id,
            });
            if (disposed) return;
            if (result && result.removed === false) {
              throw new Error("该唤醒已不存在，可能已被删除");
            }
            removedIds.add(id);
            wakes = wakes.filter((item) => String(item.id) !== id);
            deleteErrors.delete(id);
            const active = document.activeElement;
            const keepFocus =
              !!active &&
              active !== document.body &&
              !queueBody.contains(active);
            renderQueue();
            if (!keepFocus) refreshBtn.focus({ preventScroll: true });
            queueLive.textContent = "已删除这条唤醒。";
            requestQueueRefresh();
          } catch (error) {
            if (disposed) return;
            deleting.delete(id);
            deleteErrors.set(id, errorText(error));
            renderQueue();
            queueLive.textContent = "删除失败：" + errorText(error);
          } finally {
            deleting.delete(id);
            if (!disposed) {
              const currentButton = findDeleteButton(id);
              if (currentButton) {
                currentButton.disabled = false;
                currentButton.classList.remove("is-busy");
                currentButton.removeAttribute("aria-busy");
              }
            }
          }
        }

        async function submitWake() {
          if (disposed || submitting) return;
          setFeedback("", "");

          if (!connected) {
            setFeedback("当前与网关断开，无法安排唤醒。", "error");
            return;
          }

          const key = select.value || selectedKey || "";
          selectedKey = key;
          if (!key) {
            setFeedback("请先选择目标会话。", "error");
            select.focus();
            return;
          }

          const rawMessage = msg.value;
          const message = rawMessage.trim() ? rawMessage : "继续";
          const params = { key: key, message: message };
          let past = false;

          if (atInput.value) {
            const date = new Date(atInput.value);
            if (Number.isNaN(date.getTime())) {
              setFeedback("时间格式无效，请重新选择。", "error");
              atInput.focus();
              return;
            }
            past = date.getTime() < Date.now();
            params.deliverAt = date.toISOString();
          }

          setSubmitting(true);
          try {
            await host.request("sessionwakes.wakes.create", params);
            if (disposed) return;
            setFeedback(
              past
                ? "已加入队列。所选时间已过，将在下一轮检查时立即投递。"
                : "已加入队列。注入器约每 10 秒检查一次，到点后自动投递。",
              "success",
            );
            atInput.value = "";
            updateTimeHint();
            requestQueueRefresh();
          } catch (error) {
            if (disposed) return;
            setFeedback("安排失败：" + errorText(error), "error");
          } finally {
            submitting = false;
            if (!disposed) setSubmitting(false);
          }
        }

        /* ---------------- events ---------------- */

        select.addEventListener("change", () => {
          selectedKey = select.value;
          if (scopedKey) navigateScope(selectedKey);
          updateSelectedKeyInfo();
        });
        atInput.addEventListener("input", updateTimeHint);
        atInput.addEventListener("change", updateTimeHint);
        msg.addEventListener("input", updateCounter);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          void submitWake();
        });
        refreshBtn.addEventListener("click", () => {
          requestQueueRefresh();
        });

        /* ---------------- polling / lifecycle ---------------- */

        function scheduleNextPoll() {
          if (disposed) return;
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = setTimeout(tick, 20000);
        }

        async function tick() {
          if (disposed) return;
          pollTimer = null;
          scheduleNextPoll();
          updateConnection();
          fillSessions(false);
          try {
            await refreshQueue();
          } catch {
            // refreshQueue owns its error state; never break the polling chain
          }
        }

        function stop() {
          if (disposed) return;
          disposed = true;
          if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
          }
          try {
            if (ctx && ctx.signal) {
              ctx.signal.removeEventListener("abort", stop);
            }
          } catch {
            // ignore
          }
          try {
            if (container.dataset.swMount === uid) container.textContent = "";
          } catch {
            // ignore
          }
        }

        updateConnection(true);
        fillSessions(true);
        updateTimeHint();
        updateCounter();
        renderQueue();

        if (ctx && ctx.signal) {
          if (ctx.signal.aborted) stop();
          else ctx.signal.addEventListener("abort", stop, { once: true });
        }

        if (!disposed) void tick();

        return {
          update(nextContext) {
            applyScope(nextContext && nextContext.props && nextContext.props.sessionKey);
          },
          dispose() {
            stop();
            try {
              if (container.dataset.swMount === uid) {
                container.classList.remove("sw-root");
                delete container.dataset.swMount;
              }
            } catch {
              // ignore
            }
          },
        };
      },
    };

    try {
      const disposePage = host.ui.registerPage(page);
      if (typeof disposePage === "function") disposers.push(disposePage);
    } catch (error) {
      try {
        console.warn("[session-wakes] registerPage failed: " + String(error));
      } catch {
        // ignore logging failures
      }
    }
    if (typeof host.ui.registerAction === "function" && host.navigation && typeof host.navigation.openPage === "function") {
      const actionKey = (context) => sessionKeyValue(context && (context.sessionKey || (context.session && context.session.key)));
      const disposeAction = host.ui.registerAction({
        id: "wake-settings",
        label: "唤醒设置",
        placement: "session",
        resolve(context) { return { hidden: !actionKey(context) }; },
        run(context) {
          const key = actionKey(context);
          if (!key || (context.signal && context.signal.aborted)) return;
          host.navigation.openPage({ id: "session-wakes", params: { sessionKey: key } });
        },
      });
      if (typeof disposeAction === "function") disposers.push(disposeAction);
    }
    try {
      if (typeof host.ui.invalidate === "function") host.ui.invalidate();
    } catch {
      // invalidate is best-effort; the page is already registered
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
    };
  },
});

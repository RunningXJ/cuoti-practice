(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const MODE_LABELS = {
    all: "全部错题练习",
    hot: "多次错题（≥2次）",
    "practice-wrong": "本次练习错题",
    single: "只练单选",
    multi: "只练多选",
    judge: "只练判断",
    retry: "重做错题",
  };

  const state = {
    bank: null,
    queue: [],
    index: 0,
    selected: new Set(),
    answered: false,
    answerLog: {},
    session: { total: 0, correct: 0, wrong: 0, wrongIds: [] },
    mode: "all",
    shuffle: true,
  };

  const LOCAL_STATE_KEY = "cuoti_user_state_v1";

  function scoreUserState(s) {
    if (!s || typeof s !== "object") return 0;
    const pw = Object.keys(s.practiceWrongs || {}).length;
    const chops = (s.choppedIds || []).length;
    const statsAns = Number((s.stats && s.stats.answered) || 0);
    let prog = 0;
    Object.values(s.progressByMode || {}).forEach((p) => {
      if (!p) return;
      prog += Number(p.index || 0);
      prog += (p.queueIds || []).length ? 1 : 0;
      prog += Number((p.session && p.session.correct) || 0);
      prog += Number((p.session && p.session.wrong) || 0);
    });
    return pw * 10 + chops * 25 + statsAns + prog;
  }

  function readLocalStateWrap() {
    try {
      const raw = localStorage.getItem(LOCAL_STATE_KEY);
      if (!raw) return null;
      const wrap = JSON.parse(raw);
      if (!wrap || typeof wrap !== "object" || !wrap.state) return null;
      return wrap;
    } catch (e) {
      return null;
    }
  }

  function mirrorStateToLocal(userState) {
    if (!userState) return;
    try {
      const prev = readLocalStateWrap();
      const prevState = (prev && prev.state) || {};
      const pick = (key, fallback) =>
        userState[key] != null ? userState[key] : prevState[key] != null ? prevState[key] : fallback;
      localStorage.setItem(
        LOCAL_STATE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          state: {
            choppedIds: pick("choppedIds", []),
            choppedMeta: pick("choppedMeta", {}),
            practiceWrongs: pick("practiceWrongs", {}),
            stats: pick("stats", {}),
            history: pick("history", []),
            progressByMode: pick("progressByMode", {}),
          },
        })
      );
    } catch (e) {
      console.error("local backup failed", e);
    }
  }

  function mirrorBankState() {
    if (state.bank && state.bank.state) mirrorStateToLocal(state.bank.state);
  }

  async function pullAndMirrorServerState() {
    try {
      const st = await api("/api/state");
      if (state.bank) state.bank.state = {
        ...(state.bank.state || {}),
        stats: st.stats || {},
        practiceWrongs: st.practiceWrongs || {},
        choppedIds: st.choppedIds || [],
        choppedMeta: st.choppedMeta || {},
        progressByMode: st.progressByMode || {},
        history: st.history || [],
      };
      mirrorStateToLocal(st);
    } catch (e) {
      mirrorBankState();
    }
  }

  async function maybeRestoreFromLocal() {
    const wrap = readLocalStateWrap();
    if (!wrap || !wrap.state) return false;
    const server = (state.bank && state.bank.state) || {};
    const localScore = scoreUserState(wrap.state);
    const serverScore = scoreUserState(server);
    // 本地更“充实”时恢复（典型：云端休眠后服务器回到镜像初始态）
    if (localScore <= serverScore) return false;
    try {
      await api("/api/state/restore", {
        method: "POST",
        body: JSON.stringify({ state: wrap.state }),
      });
      return true;
    } catch (e) {
      console.error("restore failed", e);
      return false;
    }
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  function show(viewId) {
    ["homeView", "quizView", "resultView", "choppedView"].forEach((id) => {
      const el = $("#" + id);
      if (!el) return;
      el.classList.toggle("hidden", id !== viewId);
    });
  }

  function practiceWrongCount(q) {
    const pw = (state.bank && state.bank.state && state.bank.state.practiceWrongs) || {};
    const item = pw[q.id];
    return item ? Number(item.count || 0) : 0;
  }

  function isHot(q) {
    // 历史考试错≥2次，或本次练习错≥2次，都按多次错题处理
    return (q.wrongCount || 0) >= 2 || practiceWrongCount(q) >= 2;
  }

  function progressMap() {
    return (state.bank && state.bank.state && state.bank.state.progressByMode) || {};
  }

  function getProgress(mode) {
    return progressMap()[mode] || null;
  }

  function isProgressActive(p) {
    if (!p || !Array.isArray(p.queueIds) || !p.queueIds.length) return false;
    const idx = Number(p.index || 0);
    return idx < p.queueIds.length;
  }

  /** 题库增减后：保留已练进度，去掉失效题，把新题追加到队尾 */
  function reconcileProgress(mode, saved) {
    if (!saved || !Array.isArray(saved.queueIds)) return null;
    const current = filterByMode(mode);
    const currentIdSet = new Set(current.map((q) => q.id));
    const oldIds = saved.queueIds || [];
    const oldIndex = Number(saved.index || 0);
    const keptBefore = [];
    const keptAfter = [];
    oldIds.forEach((id, i) => {
      if (!currentIdSet.has(id)) return;
      if (i < oldIndex) keptBefore.push(id);
      else keptAfter.push(id);
    });
    const keptSet = new Set([...keptBefore, ...keptAfter]);
    let newcomers = current.map((q) => q.id).filter((id) => !keptSet.has(id));
    if (saved.shuffle) newcomers = shuffle(newcomers);
    const queueIds = [...keptBefore, ...keptAfter, ...newcomers];
    if (!queueIds.length) return null;
    const sess = saved.session || {};
    return {
      mode,
      queueIds,
      index: keptBefore.length,
      shuffle: !!saved.shuffle,
      session: {
        total: queueIds.length,
        correct: Number(sess.correct || 0),
        wrong: Number(sess.wrong || 0),
        wrongIds: (sess.wrongIds || []).filter((id) => currentIdSet.has(id)),
      },
    };
  }

  function progressChanged(a, b) {
    if (!a || !b) return true;
    if (Number(a.index || 0) !== Number(b.index || 0)) return true;
    const aq = a.queueIds || [];
    const bq = b.queueIds || [];
    if (aq.length !== bq.length) return true;
    for (let i = 0; i < aq.length; i++) {
      if (aq[i] !== bq[i]) return true;
    }
    return false;
  }

  async function persistProgressObject(p) {
    if (!p || !p.mode) return;
    try {
      const resp = await api("/api/progress/save", {
        method: "POST",
        body: JSON.stringify({
          mode: p.mode,
          queueIds: p.queueIds,
          index: p.index,
          session: p.session,
          shuffle: !!p.shuffle,
        }),
      });
      if (state.bank && state.bank.state) {
        state.bank.state.progressByMode = resp.progressByMode || {};
      }
      mirrorBankState();
    } catch (e) {
      console.error(e);
    }
  }

  async function saveProgress() {
    if (!state.mode || !state.queue.length) return;
    if (state.index >= state.queue.length) {
      await clearProgress(state.mode);
      return;
    }
    await persistProgressObject({
      mode: state.mode,
      queueIds: state.queue.map((q) => q.id),
      index: state.index,
      session: {
        total: state.session.total,
        correct: state.session.correct,
        wrong: state.session.wrong,
        wrongIds: state.session.wrongIds || [],
      },
      shuffle: !!state.shuffle,
    });
  }

  async function clearProgress(mode) {
    try {
      const resp = await api("/api/progress/clear", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      if (state.bank && state.bank.state) {
        state.bank.state.progressByMode = resp.progressByMode || {};
      }
      mirrorBankState();
    } catch (e) {
      console.error(e);
    }
  }

  async function syncAllProgressWithBank() {
    const map = { ...progressMap() };
    for (const mode of Object.keys(map)) {
      if (mode === "retry") continue;
      const saved = map[mode];
      if (!saved || !Array.isArray(saved.queueIds) || !saved.queueIds.length) continue;
      const synced = reconcileProgress(mode, saved);
      if (!synced || synced.index >= synced.queueIds.length) {
        await clearProgress(mode);
        continue;
      }
      if (progressChanged(saved, synced)) {
        await persistProgressObject(synced);
      }
    }
  }

  function updateModeButtonsProgress() {
    const map = progressMap();
    $$(".mode-btn").forEach((btn) => {
      const mode = btn.dataset.mode;
      const el = btn.querySelector(`[data-progress-for="${mode}"]`);
      const raw = map[mode];
      const p = raw ? reconcileProgress(mode, raw) || raw : null;
      btn.classList.toggle("has-progress", isProgressActive(p));
      if (!el) return;
      if (isProgressActive(p)) {
        const done = Math.min(Number(p.index || 0), p.queueIds.length);
        el.textContent = `进度 ${done}/${p.queueIds.length} · 继续中`;
      } else {
        el.textContent = "";
      }
    });
  }

  function renderHome() {
    const b = state.bank;
    $("#examName").textContent = `${b.examName} · 题库更新 ${b.updatedAt || ""}`;
    const hot = b.questions.filter(isHot).length;
    const pw = Object.keys(b.state.practiceWrongs || {}).filter((id) => {
      const item = b.state.practiceWrongs[id];
      return b.questions.some((q) => q.id === id) && Number((item && item.count) || 0) > 0;
    }).length;
    $("#homeStats").innerHTML = `
      <div class="stat"><div class="n">${b.activeTotal}</div><div class="l">可练习题</div></div>
      <div class="stat"><div class="n">${hot}</div><div class="l">多次错题(≥2)</div></div>
      <div class="stat"><div class="n">${pw}</div><div class="l">练习错题</div></div>
      <div class="stat"><div class="n">${b.choppedTotal || 0}</div><div class="l">已斩题</div></div>
    `;
    updateModeButtonsProgress();
  }

  function filterByMode(mode) {
    let list = [...state.bank.questions];
    const pw = state.bank.state.practiceWrongs || {};
    if (mode === "hot") list = list.filter(isHot);
    else if (mode === "practice-wrong") {
      // 只要练习中错过就保留（答对也不清次数），按错误次数排序
      list = list.filter((q) => practiceWrongCount(q) > 0);
      list.sort((a, b) => practiceWrongCount(b) - practiceWrongCount(a));
    } else if (mode === "single") list = list.filter((q) => q.type === "单选题");
    else if (mode === "multi") list = list.filter((q) => q.type === "多选题");
    else if (mode === "judge") list = list.filter((q) => q.type === "判断题");
    return list;
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function buildQueueFromIds(ids) {
    const byId = new Map(state.bank.questions.map((q) => [q.id, q]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  async function startMode(mode, customList, options = {}) {
    const forceRestart = !!options.forceRestart;

    // 有进度则静默继续（无弹窗）；题库更新后会自动并入新题
    if (!forceRestart && !customList) {
      const saved = getProgress(mode);
      const synced = saved ? reconcileProgress(mode, saved) : null;
      if (isProgressActive(synced)) {
        await resumeProgress(mode, saved);
        return;
      }
      if (saved && synced && synced.index >= synced.queueIds.length) {
        await clearProgress(mode);
      }
    }

    state.mode = mode;
    state.shuffle = $("#shuffleToggle") ? $("#shuffleToggle").checked : true;
    let list = customList || filterByMode(mode);
    if (!list.length) {
      alert("当前模式下没有题目");
      return;
    }
    if (state.shuffle) list = shuffle(list);
    state.queue = list;
    state.index = 0;
    state.answerLog = {};
    state.session = { total: list.length, correct: 0, wrong: 0, wrongIds: [] };
    await saveProgress();
    show("quizView");
    renderQuestion();
  }

  async function resumeProgress(mode, saved) {
    const synced = reconcileProgress(mode, saved);
    if (!synced || !synced.queueIds.length) {
      await clearProgress(mode);
      alert("进度中的题目已不存在，已清除进度");
      renderHome();
      return;
    }
    let queue = buildQueueFromIds(synced.queueIds);
    if (!queue.length) {
      await clearProgress(mode);
      alert("进度中的题目已不存在，已清除进度");
      renderHome();
      return;
    }
    let index = Number(synced.index || 0);
    if (index >= queue.length) index = Math.max(0, queue.length - 1);
    state.mode = mode;
    state.shuffle = !!synced.shuffle;
    state.queue = queue;
    state.index = index;
    state.answerLog = {};
    state.session = {
      total: queue.length,
      correct: (synced.session && synced.session.correct) || 0,
      wrong: (synced.session && synced.session.wrong) || 0,
      wrongIds: (synced.session && synced.session.wrongIds) || [],
    };
    await saveProgress();
    show("quizView");
    renderQuestion();
  }

  function currentQ() {
    return state.queue[state.index];
  }

  function sameAnswers(selected, answerKeys) {
    const a = [...selected].map(String).sort().join(",");
    const b = [...(answerKeys || [])].map(String).sort().join(",");
    return a === b && a.length > 0;
  }

  function updateNavButtons() {
    const atFirst = state.index <= 0;
    const atLast = state.index >= state.queue.length - 1;
    const prev = $("#btnPrev");
    const next = $("#btnNext");
    if (prev) prev.disabled = atFirst;
    if (next) {
      next.disabled = false;
      if (atLast && state.answered) next.textContent = "完成本轮";
      else if (atLast && !state.answered) next.textContent = "下一题";
      else next.textContent = "下一题";
      // 最后一题且未作答时，下一题不可跳过结束
      if (atLast && !state.answered) next.disabled = true;
    }
  }

  function applyAnsweredUI(q, correct) {
    $$("#optBox .opt").forEach((el) => {
      const key = el.dataset.key;
      el.disabled = true;
      el.classList.toggle("selected", state.selected.has(key));
      if ((q.answerKeys || []).includes(key)) el.classList.add("correct");
      if (state.selected.has(key) && !(q.answerKeys || []).includes(key))
        el.classList.add("wrong");
    });
    const fb = $("#feedback");
    fb.classList.remove("hidden", "ok", "bad");
    fb.classList.add(correct ? "ok" : "bad");
    fb.innerHTML = correct
      ? "回答正确"
      : `回答错误。正确答案：<strong>${escapeHtml(
          q.answer || (q.answerKeys || []).join(",")
        )}</strong>`;
    $("#btnSubmit").classList.add("hidden");
  }

  function renderQuestion() {
    const q = currentQ();
    if (!q) {
      finishSession();
      return;
    }
    const logged = state.answerLog[q.id];
    state.selected = logged ? new Set(logged.selected || []) : new Set();
    state.answered = !!logged;

    $("#btnSubmit").classList.toggle("hidden", state.answered);
    $("#feedback").classList.add("hidden");
    $("#feedback").classList.remove("ok", "bad");

    const pct = ((state.index + (state.answered ? 1 : 0)) / Math.max(state.queue.length, 1)) * 100;
    $("#progressFill").style.width = Math.min(100, pct) + "%";
    $("#progressText").textContent = `${MODE_LABELS[state.mode] || ""} · 第 ${
      state.index + 1
    } / ${state.queue.length} 题`;

    const hot = isHot(q);
    const pCount = practiceWrongCount(q);
    const multi = (q.answerKeys || []).length > 1 || q.type === "多选题";
    const card = $("#questionCard");
    card.className = "q-card" + (hot ? " hot-q" : "");
    const practiceBadge =
      pCount > 0
        ? `<span class="badge ${pCount >= 2 ? "hot" : ""}">练习错 ${pCount} 次${
            pCount >= 2 ? " · 已计入多次错题" : ""
          }</span>`
        : "";
    card.innerHTML = `
      <div class="badge-row">
        <span class="badge">${q.type || "题目"}</span>
        <span class="badge">历史错 ${q.wrongCount || 1} 次</span>
        ${practiceBadge}
        ${hot ? '<span class="badge hot">多次错题 · 重点</span>' : ""}
        ${multi ? '<span class="badge">多选</span>' : '<span class="badge">单选</span>'}
      </div>
      <div class="stem ${hot ? "hot-text" : ""}">${escapeHtml(q.stem)}</div>
      <div class="options" id="optBox"></div>
    `;

    const box = $("#optBox");
    (q.options || []).forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "opt";
      btn.dataset.key = opt.key;
      btn.innerHTML = `<span class="k">${escapeHtml(opt.key)}</span><span>${escapeHtml(
        opt.text
      )}</span>`;
      btn.addEventListener("click", () => toggleOpt(opt.key, multi));
      box.appendChild(btn);
    });

    if (logged) {
      applyAnsweredUI(q, !!logged.correct);
    }
    updateNavButtons();
  }

  function toggleOpt(key, multi) {
    if (state.answered) return;
    if (multi) {
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
    } else {
      state.selected = new Set([key]);
    }
    $$("#optBox .opt").forEach((el) => {
      el.classList.toggle("selected", state.selected.has(el.dataset.key));
    });
  }

  async function submitAnswer() {
    const q = currentQ();
    if (!q) return;
    if (state.answerLog[q.id]) return;
    if (!state.selected.size) {
      alert(
        q.type === "多选题" || (q.answerKeys || []).length > 1
          ? "请至少选择一个选项"
          : "请先选择答案"
      );
      return;
    }
    const correct = sameAnswers(state.selected, q.answerKeys);
    state.answered = true;
    state.answerLog[q.id] = {
      selected: [...state.selected],
      correct,
    };
    if (correct) state.session.correct += 1;
    else {
      state.session.wrong += 1;
      if (!state.session.wrongIds.includes(q.id)) state.session.wrongIds.push(q.id);
    }

    applyAnsweredUI(q, correct);
    updateNavButtons();

    try {
      const resp = await api("/api/answer", {
        method: "POST",
        body: JSON.stringify({
          id: q.id,
          correct,
          selected: [...state.selected],
        }),
      });
      state.bank.state.stats = resp.stats;
      state.bank.state.practiceWrongs = resp.practiceWrongs;
      mirrorBankState();
      // 练习错达≥2次时，立即按多次错题样式处理
      if (!correct && practiceWrongCount(q) >= 2) {
        const card = $("#questionCard");
        card.classList.add("hot-q");
        const stem = card.querySelector(".stem");
        if (stem) stem.classList.add("hot-text");
        const row = card.querySelector(".badge-row");
        if (row) {
          if (![...row.querySelectorAll(".badge.hot")].some((el) => el.textContent.includes("多次错题"))) {
            row.insertAdjacentHTML(
              "beforeend",
              '<span class="badge hot">多次错题 · 重点</span>'
            );
          }
          let pBadge = [...row.querySelectorAll(".badge")].find((el) =>
            el.textContent.includes("练习错")
          );
          if (!pBadge) {
            row.insertAdjacentHTML(
              "beforeend",
              `<span class="badge hot">练习错 ${practiceWrongCount(q)} 次 · 已计入多次错题</span>`
            );
          } else {
            pBadge.classList.add("hot");
            pBadge.textContent = `练习错 ${practiceWrongCount(q)} 次 · 已计入多次错题`;
          }
        }
      } else if (!correct) {
        const row = $("#questionCard .badge-row");
        if (row) {
          let pBadge = [...row.querySelectorAll(".badge")].find((el) =>
            el.textContent.includes("练习错")
          );
          if (!pBadge) {
            row.insertAdjacentHTML(
              "beforeend",
              `<span class="badge">练习错 ${practiceWrongCount(q)} 次</span>`
            );
          } else {
            pBadge.textContent = `练习错 ${practiceWrongCount(q)} 次`;
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
    await saveProgress();
  }

  async function prevQuestion() {
    if (state.index <= 0) return;
    state.index -= 1;
    await saveProgress();
    renderQuestion();
  }

  async function nextQuestion() {
    if (state.index >= state.queue.length - 1) {
      if (state.answered) await finishSession();
      return;
    }
    state.index += 1;
    await saveProgress();
    renderQuestion();
  }

  async function finishSession() {
    const finishedMode = state.mode;
    await clearProgress(finishedMode);
    // 全部练完后自动重新开始，不弹窗、不进结果页
    if (finishedMode === "retry") {
      await reloadBank();
      show("homeView");
      renderHome();
      return;
    }
    await reloadBank();
    await startMode(finishedMode, null, { forceRestart: true });
  }

  async function goHome() {
    await saveProgress();
    await reloadBank();
    show("homeView");
    renderHome();
  }

  async function chopCurrent() {
    const q = currentQ();
    if (!q) return;
    if (!confirm("确认斩掉这道题？斩题后将从练习题库中删除。")) return;
    try {
      const resp = await api("/api/chop", {
        method: "POST",
        body: JSON.stringify({
          id: q.id,
          stem: q.stem,
          type: q.type,
          answer: q.answer,
        }),
      });
      state.bank.questions = state.bank.questions.filter((x) => x.id !== q.id);
      state.bank.activeTotal = state.bank.questions.length;
      state.bank.choppedTotal = (resp.choppedIds || []).length;
      state.bank.state.choppedIds = resp.choppedIds || [];
      if (resp.choppedMeta) state.bank.state.choppedMeta = resp.choppedMeta;
      if (resp.stats) state.bank.state.stats = resp.stats;
      mirrorBankState();
      state.queue = state.queue.filter((x) => x.id !== q.id);
      state.session.total = state.queue.length;
      if (!state.queue.length) {
        await clearProgress(state.mode);
        alert("已斩题，当前队列已空");
        await reloadBank();
        show("homeView");
        renderHome();
        return;
      }
      if (state.index >= state.queue.length) state.index = state.queue.length - 1;
      await saveProgress();
      alert("已斩题");
      renderQuestion();
    } catch (e) {
      alert("斩题失败：" + e.message);
    }
  }

  async function renderChopped() {
    show("choppedView");
    const st = await api("/api/state");
    const ids = st.choppedIds || [];
    const meta = st.choppedMeta || {};
    const box = $("#choppedList");
    if (!ids.length) {
      box.innerHTML = '<p class="hint">暂无已斩题目</p>';
      return;
    }
    const cache = JSON.parse(localStorage.getItem("qCache") || "{}");
    box.innerHTML = ids
      .map((id) => {
        const q = meta[id] || cache[id] || {};
        const title = q.stem || `题目ID：${id}`;
        return `<div class="chop-item"><div class="t">${escapeHtml(title)}</div>
          <button class="ghost mini" data-unchop="${id}">恢复此题</button></div>`;
      })
      .join("");
    box.querySelectorAll("[data-unchop]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-unchop");
        await api("/api/unchop", { method: "POST", body: JSON.stringify({ id }) });
        await reloadBank();
        await pullAndMirrorServerState();
        renderChopped();
      });
    });
  }

  function cacheQuestions(qs) {
    const cache = JSON.parse(localStorage.getItem("qCache") || "{}");
    qs.forEach((q) => {
      cache[q.id] = { stem: q.stem, type: q.type, answer: q.answer };
    });
    localStorage.setItem("qCache", JSON.stringify(cache));
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function answerKeysOf(q) {
    if (!q) return [];
    const keys = [...(q.answerKeys || [])].map(String);
    if (keys.length) return keys;
    if (q.type !== "判断题") return [];
    const ans = String(q.answer || "").trim();
    if (ans === "正确" || ans === "对" || ans === "是" || ans === "A") return ["A"];
    if (ans === "错误" || ans === "错" || ans === "否" || ans === "B") return ["B"];
    const hit = (q.options || []).find((o) => o && o.text === ans);
    return hit && hit.key ? [String(hit.key)] : [];
  }

  function isActuallyCorrect(q, selected) {
    const want = answerKeysOf(q).slice().sort().join(",");
    const sel = [...(selected || [])].map(String).sort().join(",");
    return want.length > 0 && sel === want;
  }

  /** 修正判断题因 answerKeys 为空被误判错的历史统计 */
  async function repairJudgeFalseWrongs() {
    const qs = (state.bank && state.bank.questions) || [];
    const byId = {};
    qs.forEach((q) => {
      byId[q.id] = q;
    });
    try {
      const cache = JSON.parse(localStorage.getItem("qCache") || "{}");
      Object.keys(cache).forEach((id) => {
        if (byId[id]) return;
        const c = cache[id] || {};
        byId[id] = normalizeQuestion({
          id,
          type: c.type || "判断题",
          stem: c.stem || "",
          answer: c.answer || "",
          options: [
            { key: "A", text: "正确" },
            { key: "B", text: "错误" },
          ],
          answerKeys: [],
        });
      });
    } catch (e) {}
    let st;
    try {
      st = await api("/api/state");
    } catch (e) {
      return false;
    }
    const hist = Array.isArray(st.history) ? st.history : [];
    let changed = false;
    hist.forEach((h) => {
      const q = byId[h.id];
      if (!q || q.type !== "判断题") return;
      const act = isActuallyCorrect(q, h.selected);
      if (Boolean(h.correct) !== act) {
        h.correct = act;
        changed = true;
      }
    });

    const practice = {};
    let answered = 0;
    let correct = 0;
    let wrong = 0;
    hist.forEach((h) => {
      const q = byId[h.id];
      answered += 1;
      let act = Boolean(h.correct);
      if (q && q.type === "判断题") {
        act = isActuallyCorrect(q, h.selected);
        h.correct = act;
      }
      if (act) {
        correct += 1;
        if (practice[h.id]) {
          practice[h.id].lastCorrect = true;
          practice[h.id].lastCorrectAt = h.at;
        }
      } else {
        wrong += 1;
        const item = practice[h.id] || {
          count: 0,
          selectedHistory: [],
          lastCorrect: false,
        };
        item.count = Number(item.count || 0) + 1;
        item.lastCorrect = false;
        const sh = item.selectedHistory || [];
        sh.push({ at: h.at, selected: h.selected || [] });
        item.selectedHistory = sh.slice(-20);
        practice[h.id] = item;
      }
    });

    const oldPw = st.practiceWrongs || {};
    const oldStats = st.stats || {};
    if (
      Number(oldStats.answered || 0) !== answered ||
      Number(oldStats.correct || 0) !== correct ||
      Number(oldStats.wrong || 0) !== wrong ||
      JSON.stringify(Object.keys(oldPw).sort()) !== JSON.stringify(Object.keys(practice).sort())
    ) {
      changed = true;
    }
    // also if any practice count dropped
    Object.keys(oldPw).forEach((id) => {
      const o = Number((oldPw[id] && oldPw[id].count) || 0);
      const n = Number((practice[id] && practice[id].count) || 0);
      if (n !== o) changed = true;
    });

    const progress = { ...(st.progressByMode || {}) };
    Object.keys(progress).forEach((mode) => {
      const p = progress[mode] || {};
      const sess = { ...(p.session || {}) };
      const wids = Array.isArray(sess.wrongIds) ? sess.wrongIds.slice() : [];
      const kept = wids.filter((wid) => {
        const q = byId[wid];
        if (!q || q.type !== "判断题") return true;
        return hist.some((h) => h.id === wid && !isActuallyCorrect(q, h.selected));
      });
      if (kept.length !== wids.length) {
        const diff = wids.length - kept.length;
        sess.wrongIds = kept;
        sess.wrong = Math.max(0, Number(sess.wrong || 0) - diff);
        sess.correct = Number(sess.correct || 0) + diff;
        progress[mode] = { ...p, session: sess };
        changed = true;
      }
    });

    if (!changed) return false;

    const repaired = {
      choppedIds: st.choppedIds || [],
      choppedMeta: st.choppedMeta || {},
      practiceWrongs: practice,
      stats: {
        answered,
        correct,
        wrong,
        chopped: (st.choppedIds || []).length,
      },
      history: hist,
      progressByMode: progress,
    };
    try {
      await api("/api/state/restore", {
        method: "POST",
        body: JSON.stringify({ state: repaired }),
      });
      mirrorStateToLocal(repaired);
      if (state.bank) state.bank.state = {
        ...(state.bank.state || {}),
        stats: repaired.stats,
        practiceWrongs: repaired.practiceWrongs,
        choppedIds: repaired.choppedIds,
        choppedMeta: repaired.choppedMeta,
        progressByMode: repaired.progressByMode,
        history: repaired.history,
      };
      console.info("已修正判断题误判统计", oldStats, "->", repaired.stats);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  function normalizeQuestion(q) {
    if (!q || typeof q !== "object") return q;
    // 判断题：答案常为「正确/错误」，但选项是 A/B；补齐 answerKeys
    if (q.type === "判断题") {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2) {
        q.options = [
          { key: "A", text: "正确" },
          { key: "B", text: "错误" },
        ];
      }
      const keys = q.answerKeys || [];
      if (!keys.length) {
        const ans = String(q.answer || "").trim();
        if (ans === "正确" || ans === "对" || ans === "是" || ans === "A") {
          q.answerKeys = ["A"];
          if (ans === "A") q.answer = "正确";
        } else if (ans === "错误" || ans === "错" || ans === "否" || ans === "B") {
          q.answerKeys = ["B"];
          if (ans === "B") q.answer = "错误";
        } else {
          const hit = (q.options || []).find((o) => o && o.text === ans);
          if (hit && hit.key) q.answerKeys = [hit.key];
        }
      }
    }
    return q;
  }

  async function reloadBank() {
    state.bank = await api("/api/bank");
    (state.bank.questions || []).forEach(normalizeQuestion);
    cacheQuestions(state.bank.questions || []);
  }

  function bind() {
    $$(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => startMode(btn.dataset.mode));
    });
    $("#btnSubmit").addEventListener("click", submitAnswer);
    $("#btnPrev").addEventListener("click", prevQuestion);
    $("#btnNext").addEventListener("click", nextQuestion);
    $("#btnChop").addEventListener("click", chopCurrent);
    $("#btnBackHome").addEventListener("click", goHome);
    $("#btnToHome").addEventListener("click", goHome);
    $("#btnRetryWrong").addEventListener("click", () => {
      const ids = new Set(state.session.wrongIds);
      const list = state.queue.filter((q) => ids.has(q.id));
      if (!list.length) {
        startMode("practice-wrong");
        return;
      }
      startMode("retry", list, { forceRestart: true });
    });
    $("#btnReviewChopped").addEventListener("click", renderChopped);
    $("#btnBackFromChopped").addEventListener("click", goHome);
    $("#btnClearPracticeWrong").addEventListener("click", async () => {
      if (!confirm("确认清空练习错题记录？不会影响题库、斩题和各模式进度。")) return;
      await api("/api/reset-practice-wrongs", { method: "POST", body: "{}" });
      await reloadBank();
      await pullAndMirrorServerState();
      renderHome();
    });

    // save when page hidden / closed
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        mirrorBankState();
        if (!$("#quizView").classList.contains("hidden")) saveProgress();
      }
    });
    window.addEventListener("pagehide", () => {
      mirrorBankState();
      if (!$("#quizView").classList.contains("hidden")) saveProgress();
    });
  }

  async function init() {
    bind();
    await reloadBank();
    if (await maybeRestoreFromLocal()) {
      await reloadBank();
    }
    if (await repairJudgeFalseWrongs()) {
      await reloadBank();
    }
    await syncAllProgressWithBank();
    await pullAndMirrorServerState();
    renderHome();
    show("homeView");
  }

  init().catch((e) => {
    document.body.innerHTML = `<div style="padding:24px;font-family:sans-serif">加载失败：${escapeHtml(
      e.message
    )}<br>请用 start.bat 启动服务后再访问。</div>`;
  });
})();

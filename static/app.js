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
    session: { total: 0, correct: 0, wrong: 0, wrongIds: [] },
    mode: "all",
    shuffle: true,
  };

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

  function renderQuestion() {
    const q = currentQ();
    if (!q) {
      finishSession();
      return;
    }
    state.selected = new Set();
    state.answered = false;
    $("#btnSubmit").classList.remove("hidden");
    $("#btnNext").classList.add("hidden");
    $("#feedback").classList.add("hidden");

    const pct = (state.index / Math.max(state.queue.length, 1)) * 100;
    $("#progressFill").style.width = pct + "%";
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
    if (correct) state.session.correct += 1;
    else {
      state.session.wrong += 1;
      state.session.wrongIds.push(q.id);
    }

    $$("#optBox .opt").forEach((el) => {
      const key = el.dataset.key;
      el.disabled = true;
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
    $("#btnNext").classList.remove("hidden");
    $("#btnNext").textContent =
      state.index >= state.queue.length - 1 ? "完成本轮" : "下一题";

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
    // keep progress at current index until user goes next
    await saveProgress();
  }

  async function nextQuestion() {
    if (state.index >= state.queue.length - 1) {
      await finishSession();
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

  async function reloadBank() {
    state.bank = await api("/api/bank");
    cacheQuestions(state.bank.questions || []);
  }

  function bind() {
    $$(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => startMode(btn.dataset.mode));
    });
    $("#btnSubmit").addEventListener("click", submitAnswer);
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
      renderHome();
    });

    // save when page hidden / closed
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && !$("#quizView").classList.contains("hidden")) {
        saveProgress();
      }
    });
    window.addEventListener("pagehide", () => {
      if (!$("#quizView").classList.contains("hidden")) saveProgress();
    });
  }

  async function init() {
    bind();
    await reloadBank();
    await syncAllProgressWithBank();
    renderHome();
    show("homeView");
  }

  init().catch((e) => {
    document.body.innerHTML = `<div style="padding:24px;font-family:sans-serif">加载失败：${escapeHtml(
      e.message
    )}<br>请用 start.bat 启动服务后再访问。</div>`;
  });
})();

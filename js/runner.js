/* Participant UI for the static frozen listening experiment. */
(function () {
  "use strict";
  const config = globalThis.BEEP_EXPERIMENT_CONFIG;
  const core = globalThis.BeepExperiment;
  const byId = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let explicitSeed = "";
  try { if (params.has("seed")) explicitSeed = core.normalizeSeed(params.get("seed")); }
  catch (error) { alert("Invalid developer seed: " + error.message); }

  let loaded;
  try {
    loaded = core.loadOrCreateSession(localStorage, config, {seed: explicitSeed, crypto: globalThis.crypto});
  } catch (error) {
    document.body.textContent = "This browser cannot start the experiment: " + error.message;
    return;
  }
  let {key, session} = loaded;
  let currentIndex = 0;
  const players = {
    reference: byId("reference-audio"), A: byId("A-audio"), B: byId("B-audio"),
  };

  function persist() { core.persist(localStorage, key, session); }
  function firstUnanswered() {
    const index = session.plan.findIndex(item => !session.responses[item.neutral_trial_id]);
    return index < 0 ? session.plan.length : index;
  }
  function stopPlayers(except) {
    Object.entries(players).forEach(([name, player]) => { if (name !== except) player.pause(); });
  }
  function setView(name) {
    for (const id of ["introduction", "trial", "complete"]) byId(id).classList.toggle("hidden", id !== name);
  }
  function loadContext() {
    byId("equipment").value = session.context.listening_equipment || "";
    byId("familiarity").value = session.context.spectrum_familiarity || "";
    byId("equipment-description").value = session.context.equipment_description || "";
    byId("final-comment").value = session.final_comment || "";
  }
  function saveContext() {
    session.context = {
      listening_equipment: byId("equipment").value,
      spectrum_familiarity: byId("familiarity").value,
      equipment_description: byId("equipment-description").value.trim(),
    };
    persist();
  }
  function showTrial() {
    stopPlayers();
    const item = session.plan[currentIndex];
    byId("progress").textContent = `Trial ${currentIndex + 1} of ${session.plan.length}`;
    players.reference.src = `audio/${item.reference_id}.wav`;
    players.A.src = `audio/${item.A_audio_id}.wav`;
    players.B.src = `audio/${item.B_audio_id}.wav`;
    document.querySelectorAll('input[name="choice"]').forEach(input => { input.checked = false; });
    byId("strength").value = "";
    byId("response-error").textContent = "";
    setView("trial");
    byId("reference-audio").focus();
  }
  function showComplete() {
    stopPlayers();
    byId("final-comment").value = session.final_comment || "";
    setView("complete");
    byId("final-comment").focus();
  }

  for (const [name, player] of Object.entries(players)) {
    player.addEventListener("play", () => {
      stopPlayers(name);
      const item = session.plan[currentIndex];
      const counts = session.replay_counts[item.neutral_trial_id] ||= {reference: 0, A: 0, B: 0};
      counts[name] += 1;
      persist();
    });
  }

  byId("begin").addEventListener("click", () => {
    saveContext();
    currentIndex = firstUnanswered();
    if (currentIndex === session.plan.length) showComplete(); else showTrial();
  });
  for (const id of ["equipment", "familiarity", "equipment-description"]) {
    byId(id).addEventListener("change", saveContext);
  }
  byId("next").addEventListener("click", () => {
    const selected = document.querySelector('input[name="choice"]:checked');
    if (!selected) {
      byId("response-error").textContent = "Choose A, B, or No meaningful preference.";
      return;
    }
    const strength = byId("strength").value;
    if (selected.value === "no_preference" && strength) {
      byId("response-error").textContent = "Preference strength applies only when A or B is selected.";
      return;
    }
    const item = session.plan[currentIndex];
    session.responses[item.neutral_trial_id] = {
      choice: selected.value, preference_strength: strength,
    };
    persist();
    currentIndex += 1;
    if (currentIndex === session.plan.length) showComplete(); else showTrial();
  });
  byId("final-comment").addEventListener("input", () => {
    session.final_comment = byId("final-comment").value;
    persist();
  });
  byId("download").addEventListener("click", () => {
    session.final_comment = byId("final-comment").value.trim();
    persist();
    let result;
    try { result = core.buildResult(config, session); }
    catch (error) { alert(error.message); return; }
    const blob = new Blob([JSON.stringify(result, null, 2) + "\n"], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${config.experimentVersion}-${session.participant_id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  byId("start-over").addEventListener("click", () => {
    if (!confirm("Erase this local session and start over with a new anonymous participant ID and seed? This cannot be undone.")) return;
    localStorage.removeItem(key);
    // An explicit developer seed intentionally remains fixed; ordinary sessions get a new seed.
    loaded = core.loadOrCreateSession(localStorage, config, {seed: explicitSeed, crypto: globalThis.crypto});
    key = loaded.key;
    session = loaded.session;
    currentIndex = 0;
    loadContext();
    setView("introduction");
    byId("begin").focus();
  });

  loadContext();
  if (firstUnanswered() > 0) byId("begin").textContent = "Resume experiment";
})();

/* Frozen listening-test randomization and session logic; no model identities. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BeepExperiment = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const STORAGE_PREFIX = "beep-listening-session:";
  const MASK32 = 0xffffffff;

  function normalizeSeed(seed) {
    const value = String(seed || "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{1,64}$/.test(value)) throw new Error("Seed must contain 1-64 hexadecimal digits.");
    return value;
  }

  function randomHex(byteCount, cryptoObject) {
    if (!cryptoObject || typeof cryptoObject.getRandomValues !== "function") {
      throw new Error("Secure browser randomness is unavailable.");
    }
    const bytes = new Uint8Array(byteCount);
    cryptoObject.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  }

  function createRandomSeed(cryptoObject) { return randomHex(16, cryptoObject); }
  function createParticipantId(cryptoObject) { return "p-" + randomHex(16, cryptoObject); }

  function seedState(seed) {
    let hash = 0x811c9dc5;
    for (const character of normalizeSeed(seed)) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash || 0x6d2b79f5;
  }

  function makeRng(seed) {
    let state = seedState(seed);
    return function () {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(values, rng) {
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = Math.floor(rng() * (index + 1));
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }

  function orderScore(order) {
    let score = 0;
    const dimensions = ["machine", "frequency", "pair"];
    for (let index = 1; index < order.length; index++) {
      for (const dimension of dimensions) {
        if (order[index].strata[dimension] === order[index - 1].strata[dimension]) score += 1;
        if (index > 1 && order[index].strata[dimension] === order[index - 1].strata[dimension] &&
            order[index].strata[dimension] === order[index - 2].strata[dimension]) score += 8;
      }
    }
    return score;
  }

  function makePlan(config, seed) {
    if (!config || config.trials.length !== 18) throw new Error("Frozen experiment must contain 18 trials.");
    const rng = makeRng(seed);
    const groups = {};
    for (const trial of config.trials) (groups[trial.strata.pair] ||= []).push(trial.id);
    const groupNames = Object.keys(groups).sort();
    if (groupNames.length !== 2 || groupNames.some(name => groups[name].length !== 9)) {
      throw new Error("Expected two balanced nine-trial comparison groups.");
    }

    // Source index zero receives A five times in one pair and four in the other.
    // Thus each pair is as close as possible and the complete test is exactly 9/9.
    const fiveGroup = rng() < 0.5 ? groupNames[0] : groupNames[1];
    const sourceZeroAtA = new Set();
    for (const name of groupNames) {
      const ids = shuffle(groups[name], rng);
      const quota = name === fiveGroup ? 5 : 4;
      ids.slice(0, quota).forEach(id => sourceZeroAtA.add(id));
    }

    let best = null;
    let bestScore = Infinity;
    for (let attempt = 0; attempt < 256; attempt++) {
      const candidate = shuffle(config.trials, rng);
      const score = orderScore(candidate);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best.map((trial, index) => {
      const zeroAtA = sourceZeroAtA.has(trial.id);
      return {
        neutral_trial_id: trial.id,
        presentation_position: index + 1,
        reference_id: trial.reference,
        A_audio_id: trial.emulators[zeroAtA ? 0 : 1],
        B_audio_id: trial.emulators[zeroAtA ? 1 : 0],
      };
    });
  }

  function storageKey(config, explicitSeed) {
    return STORAGE_PREFIX + config.experimentVersion + (explicitSeed ? ":seed:" + explicitSeed : "");
  }

  function createSession(config, options) {
    const cryptoObject = options.crypto;
    const seed = options.seed ? normalizeSeed(options.seed) : createRandomSeed(cryptoObject);
    return {
      session_schema_version: 1,
      experiment_version: config.experimentVersion,
      participant_id: createParticipantId(cryptoObject),
      participant_seed: seed,
      stimulus_manifest_sha256: config.stimulusManifestSha256,
      started_utc: new Date().toISOString(),
      context: {listening_equipment: "", spectrum_familiarity: "", equipment_description: ""},
      final_comment: "",
      plan: makePlan(config, seed),
      responses: {},
      replay_counts: {},
    };
  }

  function loadOrCreateSession(storage, config, options) {
    options = options || {};
    const explicitSeed = options.seed ? normalizeSeed(options.seed) : "";
    const key = storageKey(config, explicitSeed);
    const saved = storage.getItem(key);
    if (saved) {
      try {
        const session = JSON.parse(saved);
        const expected = makePlan(config, session.participant_seed);
        if (session.experiment_version === config.experimentVersion &&
            JSON.stringify(session.plan) === JSON.stringify(expected)) return {key, session, resumed: true};
      } catch (_) { /* Replace an unreadable local session. */ }
    }
    const session = createSession(config, {seed: explicitSeed, crypto: options.crypto});
    storage.setItem(key, JSON.stringify(session));
    return {key, session, resumed: false};
  }

  function persist(storage, key, session) { storage.setItem(key, JSON.stringify(session)); }

  function buildResult(config, session, completedUtc) {
    const responses = session.plan.map(item => {
      const response = session.responses[item.neutral_trial_id];
      if (!response) throw new Error("All 18 trials must be answered before export.");
      return Object.assign({}, item, {
        choice: response.choice,
        preference_strength: response.preference_strength || "",
        replay_counts: session.replay_counts[item.neutral_trial_id] || {reference: 0, A: 0, B: 0},
      });
    });
    return {
      schema_version: config.schemaVersion,
      experiment_version: config.experimentVersion,
      stimulus_manifest_sha256: config.stimulusManifestSha256,
      participant_id: session.participant_id,
      participant_randomization_seed: session.participant_seed,
      started_utc: session.started_utc,
      completed_utc: completedUtc || new Date().toISOString(),
      participant_context: Object.assign({}, session.context),
      final_comment: session.final_comment || "",
      responses,
    };
  }

  return {
    normalizeSeed, createRandomSeed, createParticipantId, makeRng, makePlan,
    storageKey, createSession, loadOrCreateSession, persist, buildResult,
  };
});

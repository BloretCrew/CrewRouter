// ../../tmp/crewrouter-lm-detector/shared/fingerprint-core.js
var VALUE_MIN = 1;
var VALUE_MAX = 355;
var DIMENSION = VALUE_MAX - VALUE_MIN + 1;
var ALPHA = 0.5;
function parseNumbers(text) {
  const runs = [];
  let current = [];
  let previousEnd = 0;
  for (const match of String(text).matchAll(/\d+/g)) {
    const separator = String(text).slice(previousEnd, match.index);
    const value = Number(match[0]);
    if (current.length && /\p{L}/u.test(separator)) {
      runs.push(current);
      current = [];
    }
    if (value >= VALUE_MIN && value <= VALUE_MAX) current.push(value);
    previousEnd = match.index + match[0].length;
  }
  if (current.length) runs.push(current);
  return runs.reduce((best, run) => run.length > best.length ? run : best, []);
}
function countNumbers(numbers) {
  const counts = Array(DIMENSION).fill(0);
  numbers.forEach((number) => {
    counts[number - VALUE_MIN] += 1;
  });
  return counts;
}
function hellingerFeature(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0) + ALPHA * DIMENSION;
  return counts.map((value) => Math.sqrt((value + ALPHA) / total));
}
function splitIntoFour(values) {
  const base = Math.floor(values.length / 4);
  const remainder = values.length % 4;
  const chunks = [];
  let start = 0;
  for (let index = 0; index < 4; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    chunks.push(values.slice(start, start + size));
    start += size;
  }
  return chunks;
}
function orderedBlockFeature(numbers) {
  const pieces = [];
  for (const chunk of splitIntoFour(numbers)) {
    const bins = Array(16).fill(0.5);
    for (const value of chunk) {
      const index = Math.min(15, Math.floor((value - 1) / 355 * 16));
      bins[index] += 1;
    }
    const total = bins.reduce((sum, value) => sum + value, 0);
    pieces.push(...bins.map((value) => Math.sqrt(value / total)));
  }
  const lastDigits = Array(10).fill(0.5);
  numbers.forEach((value) => {
    lastDigits[value % 10] += 1;
  });
  const lastTotal = lastDigits.reduce((sum, value) => sum + value, 0);
  pieces.push(...lastDigits.map((value) => Math.sqrt(value / lastTotal)));
  return pieces;
}

// ../../tmp/crewrouter-lm-detector/shared/detector-codec.ts
function decodeDetector(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(0, true), start = Math.ceil((4 + headerLength) / 4) * 4;
  const count = (data.length - start) / 4;
  const raw = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) for (let b = 0; b < 4; b++) raw[i * 4 + b] = data[start + b * count + i];
  const little = new DataView(raw.buffer), floats = new Float32Array(count);
  for (let i = 0; i < count; i++) floats[i] = little.getFloat32(i * 4, true);
  return JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + headerLength)), (_, value) => value && typeof value === "object" && "$f32" in value ? Array.from(floats.subarray(value.$f32, value.$f32 + value.n)) : value);
}

// ../../tmp/crewrouter-lm-detector/shared/positional.ts
var WEIGHTS = [0.6, 0.15, 0.125, 0.125];
var CENTRES = Array.from({ length: 24 }, (_, i) => 1 + i * 354 / 23);
var LAGS = [1, 2, 3, 5, 8, 13, 21, 34];
var mean = (values) => values.reduce((sum, x) => sum + x, 0) / values.length;
var fraction = (length, test) => {
  let hits = 0;
  for (let i = 0; i < length; i++) if (test(i)) hits++;
  return hits / length;
};
function positionKernel(x) {
  const n = x.length, out = Array(34 * 3).fill(0);
  x.forEach((value, position) => {
    const t = (position + 0.5) * 2 / n - 1, basis = [t, 0.5 * (3 * t * t - 1), 0.5 * (5 * t ** 3 - 3 * t)];
    const features = [
      ...CENTRES.map((centre) => Math.exp(-0.5 * ((value - centre) / 20) ** 2)),
      ...Array.from({ length: 10 }, (_, digit) => digit === value % 10 ? 1 : 0)
    ];
    features.forEach((weight, k) => basis.forEach((b, j) => {
      out[k * 3 + j] += weight * b / n;
    }));
  });
  return out;
}
function centredTransitions(symbols, bins) {
  const joint = Array(bins * bins).fill(0.5), total = symbols.length - 1 + 0.5 * bins * bins;
  for (let i = 1; i < symbols.length; i++) joint[symbols[i - 1] * bins + symbols[i]] += 1;
  for (let i = 0; i < joint.length; i++) joint[i] /= total;
  const rows = Array.from({ length: bins }, (_, a) => joint.slice(a * bins, a * bins + bins).reduce((s, v) => s + v, 0));
  const columns = Array.from({ length: bins }, (_, b) => rows.reduce((s, _2, a) => s + joint[a * bins + b], 0));
  return joint.map((value, i) => value - rows[Math.floor(i / bins)] * columns[i % bins]);
}
function sequenceFeatures(x) {
  const n = x.length, m = mean(x), sd = Math.max(Math.sqrt(mean(x.map((v) => (v - m) ** 2))), 1);
  const s = x.map((v) => (v - m) / sd), out = [];
  for (const lag of LAGS) {
    const count = n - lag, d = Array.from({ length: count }, (_, i) => x[i + lag] - x[i]);
    out.push(
      mean(d.map((_, i) => s[i + lag] * s[i])),
      mean(d.map(Math.abs)) / 355,
      fraction(count, (i) => d[i] > 0),
      fraction(count, (i) => d[i] === 0),
      fraction(count, (i) => Math.abs(d[i]) <= 5),
      fraction(count, (i) => Math.abs(d[i]) <= 20)
    );
  }
  out.push(...centredTransitions(x.map((v) => Math.min(7, Math.floor((v - 1) * 8 / 355))), 8));
  out.push(...centredTransitions(x.map((v) => v % 10), 10));
  const difference = Array.from({ length: n - 1 }, (_, i) => x[i + 1] - x[i]);
  const zStep = Array.from({ length: n - 1 }, (_, i) => Math.abs(s[i + 1] - s[i]));
  out.push(
    fraction(n - 2, (i) => Math.sign(difference[i + 1]) === Math.sign(difference[i])),
    fraction(n - 2, (i) => difference[i + 1] === difference[i]),
    fraction(n - 1, (i) => x[i] % 10 === x[i + 1] % 10),
    fraction(n - 1, (i) => zStep[i] > 1),
    fraction(n - 1, (i) => zStep[i] > 2)
  );
  const buckets = x.map((v) => Math.min(15, Math.floor((v - 1) * 16 / 355)));
  for (const width of [4, 8, 16]) {
    let sum = 0;
    for (let i = 0; i + width <= n; i++) sum += new Set(buckets.slice(i, i + width)).size / width;
    out.push(sum / (n - width + 1));
  }
  return out;
}
function positionalDecision(numbers, head) {
  const parts = [hellingerFeature(countNumbers(numbers)), orderedBlockFeature(numbers), positionKernel(numbers), sequenceFeatures(numbers)];
  const x = parts.flatMap((block, j) => {
    const p = head.params[j], scaled = block.map((v, i) => (v - p.mean[i]) / p.scale[i]);
    const length = Math.max(Math.sqrt(scaled.reduce((sum, v) => sum + v * v, 0)), 1e-12);
    return scaled.map((v) => v / length * Math.sqrt(WEIGHTS[j]));
  });
  return head.weights.map((row, k) => row.reduce((sum, w, i) => sum + w * x[i], head.bias[k]));
}

// ../../tmp/crewrouter-lm-detector/shared/shared-detector.ts
var dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
var mean2 = (a) => a.reduce((sum, x) => sum + x, 0) / a.length;
var norm = (a) => {
  const n = Math.max(Math.sqrt(dot(a, a)), 1e-12);
  return a.map((x) => x / n);
};
var z = (a) => {
  const m = mean2(a), s = Math.max(Math.sqrt(mean2(a.map((x) => (x - m) ** 2))), 1e-12);
  return a.map((x) => (x - m) / s);
};
var columnMean = (a) => a[0].map((_, i) => mean2(a.map((r) => r[i])));
var median = (a) => {
  const v = [...a].sort((x, y) => x - y), i = Math.floor(v.length / 2);
  return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
};
var blocks = (n) => [hellingerFeature(countNumbers(n)), orderedBlockFeature(n)];
var transform = (b, p) => b.flatMap((v, j) => norm(v.map((x, i) => (x - p[j].mean[i]) / p[j].scale[i])).map((x) => x * Math.sqrt(j === 0 ? 0.75 : 0.25)));
var centered = (v, p) => v.map((x, i) => (x - p.feature_mean[i]) / p.feature_scale[i]);
var subtract = (v, b) => {
  const coefficients = b.map((row) => dot(v, row));
  return v.map((x, i) => x - b.reduce((sum, row, j) => sum + coefficients[j] * row[i], 0));
};
var referenceNorms = /* @__PURE__ */ new WeakMap();
function nearest(x, references) {
  let norms = referenceNorms.get(references);
  if (!norms) {
    norms = references.map((r) => dot(r, r));
    referenceNorms.set(references, norms);
  }
  const xx = dot(x, x);
  return mean2(references.map((r, i) => Math.max(0, xx + norms[i] - 2 * dot(x, r))).sort((a, b) => a - b).slice(0, 7));
}
function baseline(b, bank) {
  const h = bank.hellinger, o = bank.ordered_blocks;
  const hUnit = norm(subtract(centered(b[0], h), h.nuisance_basis));
  const marginal = h.centroids.map((row) => dot(hUnit, row));
  const oCentered = centered(b[1], o), raw = norm(oCentered), projected = norm(subtract(oCentered, o.nuisance_basis));
  const templates = o.centroids.map((_, i) => Math.max(...o.environment_centroids.map((rows) => dot(raw, rows[i]))));
  const nuisance = o.centroids.map((row) => dot(projected, row));
  const tz = z(templates), nz = z(nuisance), ordered = z(tz.map((v, i) => 0.5 * v + 0.5 * nz[i])), mz = z(marginal);
  return mz.map((v, i) => 0.5 * v + 0.5 * ordered[i]);
}
function supportsSharedDetector(bank, artifact) {
  return artifact.schema === "shared-detector-v2" && bank.built_at === artifact.bank_built_at && bank.models.length === artifact.model_ids.length && bank.models.every((m, i) => m.id === artifact.model_ids[i] && m.response_count === artifact.response_counts[i]);
}
function calibrateRanking(ranking, artifact) {
  const head = artifact.calibration, binding = head?.binding;
  if (!head || !binding || head.schema !== "shared-confidence-v2" || head.method !== "ranking-temperature" || !Number.isFinite(head.tau) || head.tau < 1e-3 || head.tau > 1e3 || binding.base_sha256 !== artifact.base_sha256 || binding.reference_sha256 !== artifact.source_reference_sha256 || binding.model_ids.length !== ranking.length || ranking.length !== artifact.model_ids.length || !ranking.every(Number.isFinite) || !binding.model_ids.every((id, i) => id === artifact.model_ids[i])) return null;
  const logits = ranking.map((score) => head.tau * score);
  const maximum = Math.max(...logits), weights = logits.map((value) => Math.exp(value - maximum)), sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((value) => value / sum);
}
function rankSharedNumbers(numbers, artifact) {
  const a = artifact.ranker, full = numbers.map(blocks);
  const ax = full.map((b) => transform(b, a.full_params));
  const lda = numbers.map((n) => {
    const x = transform(blocks(n.slice(0, 128)), a.head_params);
    return z(a.lda_weights.map((row, i) => dot(row, x) + a.lda_bias[i]));
  });
  const l = z(columnMean(lda)), near = z(a.references.map((ref) => median(ax.map((x) => -nearest(x, ref)))));
  const base = z(columnMean(full.map((b) => baseline(b, a.bank))));
  const frequency = z(l.map((x, i) => 0.5 * x + 0.25 * near[i] + 0.25 * base[i]));
  const positional = z(columnMean(numbers.map((n) => z(positionalDecision(n, a.positional)))));
  const ranking = frequency.map((x, i) => a.blend.frequency * x + a.blend.positional * positional[i]);
  if (!ranking.every(Number.isFinite)) throw new Error("\u6392\u540D\u8BA1\u7B97\u4EA7\u751F\u65E0\u6548\u6570\u503C\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
  return ranking;
}
var SEQUENCE_LIMITS = { autocorrelation: -0.23, small_step_share: 0.05 };
function sequenceShape(numbers) {
  const shapes = numbers.map((n) => {
    const m = mean2(n), variance = mean2(n.map((x) => (x - m) ** 2)), steps = n.slice(1).map((x, i) => x - n[i]);
    return {
      autocorrelation: variance ? mean2(steps.map((_, i) => (n[i + 1] - m) * (n[i] - m))) / variance : 1,
      small_step_share: mean2(steps.map((d) => Math.abs(d) <= 20 ? 1 : 0))
    };
  });
  const autocorrelation = median(shapes.map((s) => s.autocorrelation)), small_step_share = median(shapes.map((s) => s.small_step_share));
  return {
    autocorrelation,
    small_step_share,
    model_like: autocorrelation <= SEQUENCE_LIMITS.autocorrelation && small_step_share <= SEQUENCE_LIMITS.small_step_share
  };
}
function analyzeSharedOutputs(outputs, bank, artifact, options = {}) {
  if (!supportsSharedDetector(bank, artifact))
    throw new Error("The reference bank does not match the detector. Run fpd retrain --data-dir DIR for this bank.");
  const parsed = outputs.map((o) => parseNumbers(o.text));
  const diagnostics = outputs.map((o, index) => {
    const minimum = Math.max(80, Math.ceil((o.expected_count || 0) * 0.55));
    const raw = Array.from(o.text.matchAll(/-?\d+/g), (m) => Number(m[0]));
    return {
      index,
      parsed_numbers: parsed[index].length,
      minimum_numbers: minimum,
      accepted: parsed[index].length >= minimum,
      raw_out_of_range_count: raw.filter((n) => n < 1 || n > 355).length
    };
  });
  const used = diagnostics.filter((d) => d.accepted).length;
  const accepted = parsed.filter((_, i) => diagnostics[i].accepted);
  const sequence = used ? sequenceShape(accepted) : null;
  const common = {
    probability: null,
    probability_status: "unavailable",
    used_outputs: used,
    diagnostics,
    sequence,
    method: "shared-detector-v2",
    model_version: { base_sha256: artifact.base_sha256 }
  };
  const notModel = {
    ...common,
    prediction: "",
    prediction_name: "\u4E0D\u50CF\u8BED\u8A00\u6A21\u578B\u56DE\u7B54",
    family_prediction_name: "",
    results: [],
    decision: "not_model",
    evidence: {
      insufficient: true,
      label: "\u4E0D\u50CF\u8BED\u8A00\u6A21\u578B\u56DE\u7B54",
      reason: "\u76F8\u90BB\u6570\u5B57\u7684\u53D8\u5316\u65B9\u5F0F\u4E0E\u53C2\u8003\u5E93\u4E2D\u7684\u8BED\u8A00\u6A21\u578B\u56DE\u7B54\u4E0D\u540C\uFF0C\u5E38\u89C1\u4E8E\u7A0B\u5E8F\u751F\u6210\u3001\u6392\u5E8F\u6216\u6253\u4E71\u987A\u5E8F\u7684\u6570\u5B57\u3002\u672A\u751F\u6210\u6392\u540D\u3002",
      threshold: null,
      method: "sequence-shape"
    }
  };
  if (options.allowPartial && used > 0 && used < 3 && outputs.length <= 3) {
    if (!sequence.model_like) return notModel;
    const ranking2 = rankSharedNumbers(accepted, artifact);
    const order2 = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking2[j] - ranking2[i]);
    const results2 = order2.map((i) => ({
      model: artifact.model_ids[i],
      display_name: bank.models[i].display_name,
      family: bank.models[i].family,
      family_name: bank.models[i].family_name,
      score: ranking2[i],
      probability: null
    }));
    const first2 = order2[0];
    return {
      ...common,
      method: "shared-ranker-partial-v1",
      decision: "partial",
      prediction: results2[0].model,
      prediction_name: results2[0].display_name,
      family_prediction: bank.models[first2].family,
      family_prediction_name: bank.models[first2].family_name,
      results: results2,
      ranking_score: ranking2[first2],
      calibration: null,
      evidence: {
        insufficient: true,
        label: "\u90E8\u5206\u6837\u672C\u6392\u540D",
        reason: `\u4F7F\u7528 ${used}/3 \u6761\u6709\u6548\u56DE\u7B54\u751F\u6210\u6392\u540D\u3002\u8865\u9F50\u4E09\u6761\u6709\u6548\u56DE\u7B54\u540E\u624D\u80FD\u8BA1\u7B97\u7F6E\u4FE1\u5EA6\u3002`,
        threshold: null,
        method: "partial-sample-ranking"
      }
    };
  }
  if (outputs.length !== 3 || used !== 3) return {
    ...common,
    prediction: "",
    prediction_name: "\u6682\u4E0D\u53EF\u8BC4\u5206",
    family_prediction_name: "",
    results: [],
    decision: "unscorable",
    evidence: {
      insufficient: true,
      label: "\u9700\u8981\u4E09\u6761\u5B8C\u6574\u56DE\u7B54",
      reason: `\u5F53\u524D\u6709 ${used}/${outputs.length} \u6761\u6709\u6548\u56DE\u7B54\u3002\u8BF7\u8865\u9F50\u539F\u6765\u7684\u4E09\u6761\u56DE\u7B54\u540E\u91CD\u65B0\u68C0\u6D4B\u3002`,
      threshold: null,
      method: "complete-three-answers"
    }
  };
  if (!sequence.model_like) return notModel;
  const ranking = rankSharedNumbers(parsed, artifact);
  const probabilities = calibrateRanking(ranking, artifact);
  const order = artifact.model_ids.map((_, i) => i).sort((i, j) => ranking[j] - ranking[i]);
  const results = order.map((i) => ({
    model: artifact.model_ids[i],
    display_name: bank.models[i].display_name,
    family: bank.models[i].family,
    family_name: bank.models[i].family_name,
    score: ranking[i],
    probability: probabilities?.[i] ?? null
  }));
  const first = order[0];
  return {
    ...common,
    prediction: results[0].model,
    prediction_name: results[0].display_name,
    family_prediction: bank.models[first].family,
    family_prediction_name: bank.models[first].family_name,
    results,
    ranking_score: ranking[first],
    probability: results[0].probability,
    probability_status: probabilities ? "reference_calibrated" : "unavailable",
    probability_scope: probabilities ? "reference-closed-set" : null,
    calibration: probabilities ? {
      method: artifact.calibration.method,
      run: artifact.calibration.calibration_run,
      tau: artifact.calibration.tau,
      sha256: artifact.calibration_sha256 ?? null
    } : null,
    evidence: {
      insufficient: true,
      label: probabilities ? "\u5E93\u5185\u6821\u51C6\u6392\u540D" : "\u672A\u6821\u51C6\u6392\u540D",
      reason: probabilities ? "\u7F6E\u4FE1\u5EA6\u662F\u53C2\u8003\u5E93\u5185\u7684\u95ED\u96C6\u76F8\u5BF9\u6982\u7387\uFF0C\u4E0D\u5305\u542B\u5E93\u5916\u6A21\u578B\u3002" : "\u6821\u51C6\u53C2\u6570\u4E0E\u5F53\u524D\u68C0\u6D4B\u5668\u4E0D\u5339\u914D\uFF0C\u7F6E\u4FE1\u5EA6\u4E0D\u53EF\u7528\u3002\u5019\u9009\u987A\u5E8F\u7531\u6392\u540D\u5206\u6570\u51B3\u5B9A\u3002",
      threshold: null,
      method: probabilities ? "reference-calibrated-ranking" : "uncalibrated-ranking"
    }
  };
}

// <stdin>
var LIMITS = Object.freeze({ maxTextChars: 65536, maxBankBytes: 262144, maxDetectorBytes: 8388608 });
var detectors = /* @__PURE__ */ new WeakMap();
function parseNumbers2(text) {
  if (typeof text !== "string" || text.length > LIMITS.maxTextChars) throw new TypeError("\u56DE\u7B54\u5FC5\u987B\u662F\u6709\u754C\u5B57\u7B26\u4E32");
  return parseNumbers(text);
}
function validateBank(bank) {
  if (!bank || bank.schema !== "crewrouter-lm-detector-bank-v1" || typeof bank.built_at !== "string" || !Array.isArray(bank.models) || !bank.models.length || bank.models.length > 512) throw new Error("\u65E0\u6548\u6307\u7EB9\u5E93 schema");
  const ids = /* @__PURE__ */ new Set();
  for (const model of bank.models) {
    if (!model || typeof model.id !== "string" || !model.id || model.id.length > 256 || ids.has(model.id) || typeof model.display_name !== "string" || model.display_name.length > 256 || typeof model.family !== "string" || !Number.isSafeInteger(model.response_count) || model.response_count < 1) throw new Error("\u65E0\u6548\u6307\u7EB9\u5E93\u5019\u9009");
    ids.add(model.id);
  }
  return bank;
}
function parseBankJson(text) {
  if (typeof text !== "string" || text.length > LIMITS.maxBankBytes) throw new Error("bank bytes \u8D85\u51FA\u9650\u5236");
  return validateBank(JSON.parse(text));
}
function attachDetector(bank, bytes) {
  validateBank(bank);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > LIMITS.maxDetectorBytes) throw new Error("\u65E0\u6548\u68C0\u6D4B\u5668\u5927\u5C0F");
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const start = Math.ceil((4 + headerLength) / 4) * 4;
  if (!headerLength || start >= bytes.length || (bytes.length - start) % 4) throw new Error("\u65E0\u6548\u68C0\u6D4B\u5668\u5934\u90E8");
  const detector = decodeDetector(bytes);
  if (!supportsSharedDetector(bank, detector)) throw new Error("\u6307\u7EB9\u5E93\u4E0E\u68C0\u6D4B\u5668\u7248\u672C\u4E0D\u5339\u914D");
  detectors.set(bank, detector);
  return bank;
}
function analyzeGlobalOutputs(outputs, bank) {
  if (!detectors.has(bank) || !Array.isArray(outputs) || !outputs.length || outputs.length > 3) throw new Error("\u65E0\u6548\u6307\u7EB9\u5E93\u6216\u8F93\u5165");
  for (const output of outputs) {
    if (!output || typeof output.text !== "string" || output.text.length > LIMITS.maxTextChars || output.expected_count !== void 0 && (!Number.isInteger(output.expected_count) || output.expected_count < 1 || output.expected_count > 4096)) throw new Error("\u65E0\u6548\u6307\u7EB9\u5E93\u6216\u8F93\u5165");
  }
  return analyzeSharedOutputs(outputs, bank, detectors.get(bank), { allowPartial: true });
}
export {
  LIMITS,
  analyzeGlobalOutputs,
  attachDetector,
  parseBankJson,
  parseNumbers2 as parseNumbers,
  validateBank
};

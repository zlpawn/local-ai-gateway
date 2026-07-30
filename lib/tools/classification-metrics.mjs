function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export function normalizeConfusion({ tp = 0, fp = 0, fn = 0, tn = 0 } = {}) {
  const values = {
    tp: toCount(tp),
    fp: toCount(fp),
    fn: toCount(fn),
    tn: toCount(tn),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value == null) {
      const error = new Error(`${key.toUpperCase()} must be a non-negative integer`);
      error.code = "invalid_count";
      error.field = key;
      throw error;
    }
  }
  return values;
}

function ratio(numerator, denominator) {
  if (denominator === 0) {
    return { value: null, unavailable: true, reason: "denominator_zero" };
  }
  return {
    value: Number((numerator / denominator).toFixed(6)),
    unavailable: false,
    reason: null,
  };
}

export function computeConfusionMetrics(input) {
  const { tp, fp, fn, tn } = normalizeConfusion(input);
  const total = tp + fp + fn + tn;
  const actualPos = tp + fn;
  const actualNeg = fp + tn;
  const predictedPos = tp + fp;
  const predictedNeg = fn + tn;

  const accuracy = ratio(tp + tn, total);
  const precision = ratio(tp, predictedPos);
  const recall = ratio(tp, actualPos);
  const specificity = ratio(tn, actualNeg);
  const fpr = ratio(fp, actualNeg);
  const f1 = (() => {
    if (precision.value == null || recall.value == null) {
      return { value: null, unavailable: true, reason: "precision_or_recall_unavailable" };
    }
    const denom = precision.value + recall.value;
    if (denom === 0) {
      return { value: null, unavailable: true, reason: "denominator_zero" };
    }
    return {
      value: Number(((2 * precision.value * recall.value) / denom).toFixed(6)),
      unavailable: false,
      reason: null,
    };
  })();

  return {
    counts: { tp, fp, fn, tn },
    totals: {
      total,
      actual_positive: actualPos,
      actual_negative: actualNeg,
      predicted_positive: predictedPos,
      predicted_negative: predictedNeg,
    },
    metrics: {
      accuracy,
      precision,
      recall,
      specificity,
      fpr,
      f1,
    },
  };
}

export function formatPercent(metric, digits = 1) {
  if (!metric || metric.value == null) return "N/A";
  return `${(metric.value * 100).toFixed(digits)}%`;
}

export function buildMetricsNarrative(result) {
  const { counts, totals, metrics } = result;
  const lines = [];
  lines.push(`一共 ${totals.total} 条样本：实际正例 ${totals.actual_positive}，实际负例 ${totals.actual_negative}。`);
  lines.push(`模型报出 ${totals.predicted_positive} 个正例：TP ${counts.tp}，FP ${counts.fp}（误报）。`);
  lines.push(`真实正例里抓回 ${counts.tp} 个，漏掉 ${counts.fn} 个（FN）。`);

  if (metrics.precision.value == null) {
    lines.push("精准率无法计算：模型没有预测出任何正例。");
  } else {
    lines.push(`精准率 ${formatPercent(metrics.precision)}：报出来的正例里，约 ${formatPercent(metrics.precision)} 是真的。`);
  }

  if (metrics.recall.value == null) {
    lines.push("召回率无法计算：数据里没有真实正例。");
  } else {
    lines.push(`召回率 ${formatPercent(metrics.recall)}：真实正例里，约 ${formatPercent(metrics.recall)} 被找回来了。`);
  }

  if (metrics.accuracy.value != null) {
    lines.push(`准确率 ${formatPercent(metrics.accuracy)}：所有判断里，对了 ${formatPercent(metrics.accuracy)}。`);
  }

  if (
    totals.total > 0
    && totals.actual_positive > 0
    && totals.actual_positive / totals.total <= 0.1
    && metrics.accuracy.value != null
    && metrics.accuracy.value >= 0.9
    && (metrics.recall.value == null || metrics.recall.value < 0.5)
  ) {
    lines.push("注意：正例很少时，准确率容易虚高。即使漏掉大量正例，准确率也可能看起来不错。");
  } else if (metrics.precision.value != null && metrics.recall.value != null) {
    if (metrics.precision.value - metrics.recall.value >= 0.15) {
      lines.push("当前更偏“报得准，但抓得不全”：误报少，漏报更多。");
    } else if (metrics.recall.value - metrics.precision.value >= 0.15) {
      lines.push("当前更偏“抓得全，但水分更大”：漏报少，误报更多。");
    } else {
      lines.push("当前精准率和召回率比较接近，没有明显偏向某一侧。");
    }
  }

  return lines;
}

export const METRIC_SCENARIOS = {
  spam: {
    id: "spam",
    title: "垃圾邮件拦截",
    summary: "拦垃圾邮件时，误伤正常邮件和漏拦垃圾邮件都很常见。",
    counts: { tp: 40, fp: 10, fn: 20, tn: 130 },
    lesson: "精准率低=正常邮件被误伤；召回率低=垃圾邮件漏进来。",
  },
  disease: {
    id: "disease",
    title: "疾病筛查",
    summary: "筛查场景通常更害怕漏诊，所以会更关注召回率。",
    counts: { tp: 18, fp: 30, fn: 2, tn: 150 },
    lesson: "召回高但精准低，意味着少漏诊，但会有更多人被误报。",
  },
  imbalance: {
    id: "imbalance",
    title: "类别不平衡陷阱",
    summary: "正例很少时，全预测成负例也可能得到很高准确率。",
    counts: { tp: 0, fp: 0, fn: 10, tn: 990 },
    lesson: "准确率 99% 也可能完全没用，因为真实正例一个都没抓到。",
  },
};

export function getScenario(id = "spam") {
  return METRIC_SCENARIOS[id] || METRIC_SCENARIOS.spam;
}

export function confusionFromGuidedInput({
  total = 0,
  selected = 0,
  selectedWrong = 0,
  missedActual = 0,
} = {}) {
  const values = {
    total: toCount(total),
    selected: toCount(selected),
    selectedWrong: toCount(selectedWrong),
    missedActual: toCount(missedActual),
  };

  for (const [key, value] of Object.entries(values)) {
    if (value == null) {
      const error = new Error(`${key} must be a non-negative integer`);
      error.code = "invalid_count";
      error.field = key;
      throw error;
    }
  }

  const { total: totalCount, selected: selectedCount, selectedWrong: selectedWrongCount, missedActual: missedActualCount } = values;
  const notSelected = totalCount - selectedCount;
  const selectedCorrect = selectedCount - selectedWrongCount;

  if (selectedCount > totalCount) {
    const error = new Error("selected cannot exceed total");
    error.code = "invalid_guided_input";
    error.field = "selected";
    throw error;
  }
  if (selectedWrongCount > selectedCount) {
    const error = new Error("selectedWrong cannot exceed selected");
    error.code = "invalid_guided_input";
    error.field = "selectedWrong";
    throw error;
  }
  if (missedActualCount > notSelected) {
    const error = new Error("missedActual cannot exceed not selected samples");
    error.code = "invalid_guided_input";
    error.field = "missedActual";
    throw error;
  }
  if (selectedCorrect < 0) {
    const error = new Error("selectedCorrect must be non-negative");
    error.code = "invalid_guided_input";
    error.field = "selectedWrong";
    throw error;
  }

  return {
    guided: {
      total: totalCount,
      selected: selectedCount,
      notSelected,
      selectedCorrect,
      selectedWrong: selectedWrongCount,
      missedActual: missedActualCount,
    },
    counts: {
      tp: selectedCorrect,
      fp: selectedWrongCount,
      fn: missedActualCount,
      tn: notSelected - missedActualCount,
    },
  };
}

export function guidedFromConfusion({ tp = 0, fp = 0, fn = 0, tn = 0 } = {}) {
  const counts = normalizeConfusion({ tp, fp, fn, tn });
  const selected = counts.tp + counts.fp;
  const total = counts.tp + counts.fp + counts.fn + counts.tn;
  return {
    total,
    selected,
    notSelected: total - selected,
    selectedCorrect: counts.tp,
    selectedWrong: counts.fp,
    missedActual: counts.fn,
  };
}

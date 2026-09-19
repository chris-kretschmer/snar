// Math and markup helpers for the clicks line chart on the link detail page.
//
// One file for both sides, so they can't drift apart: the server require()s it
// (src/views.js renders the chart for the initial, works-without-JS page) and
// the browser loads it as /static/chart-shared.js before app.js, which redraws
// the chart when a time-range chip is clicked. No DOM access, no globals – the
// callers pass in what differs: the number formatter (server: fmtNum, browser:
// Intl.NumberFormat 'de-DE', same output).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnarChart = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const CHART_W = 800, CHART_H = 190, CHART_TOP = 15, CHART_BASE = 185;

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Round y-axis: whole-number step of 1/2/5 x 10^n, at most ~4 intervals, and
  // never below 0..4 (a link with 1 click shouldn't fill the whole height).
  // The top tick is >= the real maximum, so the curve always stays under it.
  function niceScale(max) {
    const raw = Math.max(max, 1) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw));
    const axisMax = Math.max(4, Math.ceil(max / step) * step);
    const ticks = [];
    for (let v = 0; v <= axisMax; v += step) ticks.push(v);
    return { axisMax, ticks };
  }

  // Width of the y-label column: just as wide as the longest tick label plus a
  // small gap to the plot ("4" doesn't need the room "10.000" does).
  const axisWidthPx = (labels) => Math.round(Math.max(...labels.map((l) => l.length)) * 6.6 + 10);

  function chartGeometry(values, partialLast) {
    const max = Math.max(...values, 0);
    const { axisMax, ticks } = niceScale(max);
    const yOf = (v) => CHART_BASE - (v / axisMax) * (CHART_BASE - CHART_TOP);
    const n = values.length;
    const points = values.map((v, i) => ({
      x: n > 1 ? (i / (n - 1)) * CHART_W : CHART_W / 2,
      y: yOf(v),
    }));
    const path = (pts) => 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
    // Running bucket (e.g. the current month) is still incomplete: its
    // segment is drawn separately (dashed, see .chart-line-partial) so the
    // curve doesn't read as a real drop.
    const dashLast = partialLast && n >= 2;
    return {
      linePath: path(dashLast ? points.slice(0, -1) : points),
      partialPath: dashLast ? path(points.slice(-2)) : '',
      areaPath: `${path(points)} L${CHART_W},${CHART_BASE} L0,${CHART_BASE} Z`,
      points,
      ticks: ticks.map((v) => ({ value: v, y: yOf(v) })),
    };
  }

  // Grid lines (inside the SVG) and y labels (HTML, so the text isn't
  // stretched by preserveAspectRatio="none") both come from the same ticks –
  // they can't drift apart.
  function gridHtml(ticks, fmt) {
    const lines = ticks.map((t) => `<line x1="0" y1="${t.y.toFixed(1)}" x2="${CHART_W}" y2="${t.y.toFixed(1)}" class="chart-grid${t.value === 0 ? ' chart-grid-base' : ''}"/>`).join('');
    const labels = ticks.map((t) => `<span class="chart-label" style="top:${((t.y / CHART_H) * 100).toFixed(2)}%">${escapeHtml(fmt(t.value))}</span>`).join('');
    return { lines, labels };
  }

  // Invisible hover columns spanning the full chart height, one per data
  // point (not just a small circle around the line – this way you can hover
  // anywhere in the column, not only exactly on the point). Carries
  // label/value/point position as data attributes; app.js reads them for its
  // own styled tooltip (#chart-tooltip).
  function hoverBandsHtml(points, values, pointLabels) {
    const n = points.length;
    const spacing = n > 1 ? CHART_W / (n - 1) : CHART_W;
    return points.map((p, i) => {
      const left = Math.max(0, p.x - spacing / 2);
      const right = Math.min(CHART_W, p.x + spacing / 2);
      const label = pointLabels && pointLabels[i] != null ? pointLabels[i] : '';
      return `<rect class="chart-hover" x="${left.toFixed(1)}" y="0" width="${(right - left).toFixed(1)}" height="${CHART_H}" fill="transparent" data-label="${escapeHtml(label)}" data-value="${values[i]}" data-px="${p.x.toFixed(1)}" data-py="${p.y.toFixed(1)}"/>`;
    }).join('');
  }

  // Positions every axis label at its real data-point index (not evenly
  // spaced) – otherwise e.g. a forced last label (uneven spacing from the
  // second-to-last) would drift from the actual point.
  function xLabelsHtml(labels, n) {
    return labels.map(({ i, text }) => {
      const pct = n > 1 ? (i / (n - 1)) * 100 : 50;
      return `<span style="left:${pct.toFixed(2)}%">${escapeHtml(text)}</span>`;
    }).join('');
  }

  // Text alternative for the chart (the tooltip is mouse-only).
  function chartSummary(label, total, values, pointLabels, fmt) {
    if (!total) return `Klicks im Zeitverlauf, ${label}: keine Klicks`;
    const max = Math.max(...values);
    const peak = pointLabels && pointLabels[values.indexOf(max)] != null ? pointLabels[values.indexOf(max)] : '';
    return `Klicks im Zeitverlauf, ${label}: ${fmt(total)} ${total === 1 ? 'Klick' : 'Klicks'}, Höchstwert ${fmt(max)} (${peak})`;
  }

  return { CHART_W, CHART_H, niceScale, axisWidthPx, chartGeometry, gridHtml, hoverBandsHtml, xLabelsHtml, chartSummary };
}));

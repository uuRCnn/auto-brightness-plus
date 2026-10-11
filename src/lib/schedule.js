// Evening dimming: where in the day are we, and what should a monitor's
// brightness be right now. Pure functions, no timers (see Scheduler in
// displays.js), shared with the preferences.

import {sunTimes} from './sun.js';

const MIN = 60000;
const DAY = 1440 * MIN;

function midnight(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function smooth(p) {
    return p * p * (3 - 2 * p);
}

/**
 * Times of one day (ms since epoch) for one monitor.
 * @param {Date} day any time on that local day
 * @param {object} cfg monitor config {offset, start, duration}
 * @param {object} g global settings {mode, transition, morningOffset, morningTime, lat, lon}
 */
export function dayTimes(day, cfg, g) {
    const base = midnight(day);
    const T = g.transition * MIN;
    const E = (cfg.duration ?? g.transition) * MIN;
    let eveningStart, morningStart, sunset = null, sunrise = null;
    if (g.mode === 'sun')
        ({sunrise, sunset} = sunTimes(day, g.lat, g.lon));
    if (sunset && sunrise) {
        eveningStart = sunset.getTime() + cfg.offset * MIN;
        morningStart = sunrise.getTime() + g.morningOffset * MIN;
    } else {
        // fixed mode, or polar day/night: use the fixed times
        eveningStart = base + cfg.start * MIN;
        morningStart = base + g.morningTime * MIN;
    }
    // keep the order morning < day < evening sane
    const morningEnd = morningStart + T;
    if (eveningStart < morningEnd + MIN)
        eveningStart = morningEnd + MIN;
    return {morningStart, morningEnd, eveningStart, eveningEnd: eveningStart + E, sunset, sunrise};
}

/**
 * @returns {{phase: 'day'|'evening'|'night'|'morning', progress: number,
 *            next: number, start: number}}
 *   progress: 0 = day brightness, 1 = night brightness (already smoothed)
 *   next: time of the next phase change (ms)
 *   start: evening and night only, when this evening started (ms)
 */
export function phaseAt(now, cfg, g) {
    const t = now.getTime();
    const today = dayTimes(now, cfg, g);
    // a long evening that started yesterday may still be going on
    const yesterday = dayTimes(new Date(t - DAY), cfg, g);
    if (t < yesterday.eveningEnd && t < today.morningStart) {
        const p = (t - yesterday.eveningStart) / (yesterday.eveningEnd - yesterday.eveningStart);
        return {phase: 'evening', progress: smooth(p), next: yesterday.eveningEnd, start: yesterday.eveningStart};
    }
    if (t < today.morningStart)
        return {phase: 'night', progress: 1, next: today.morningStart, start: yesterday.eveningStart};
    if (t < today.morningEnd) {
        const p = (t - today.morningStart) / (today.morningEnd - today.morningStart);
        return {phase: 'morning', progress: 1 - smooth(p), next: today.morningEnd};
    }
    if (t < today.eveningStart)
        return {phase: 'day', progress: 0, next: today.eveningStart};
    if (t < today.eveningEnd) {
        const p = (t - today.eveningStart) / (today.eveningEnd - today.eveningStart);
        return {phase: 'evening', progress: smooth(p), next: today.eveningEnd, start: today.eveningStart};
    }
    const tomorrow = dayTimes(new Date(t + DAY), cfg, g);
    return {phase: 'night', progress: 1, next: Math.max(tomorrow.morningStart, t + MIN), start: today.eveningStart};
}

// ------------------------------------------------------------------ curves
/*
 * The evening as a curve the user shapes in the graph, one per layer
 * ('night' = brightness, 'extra' = extra dimming). Eight points, minutes
 * after the evening start:
 *   start (day value) · 3 points · main point (the night value, at the end
 *   of the duration) · 3 more points through the night, up to GRAPH_SPAN.
 * The 6 small points are stored in cfg.points[layer]; null = follow the
 * main point (a smooth ramp before it, flat after it). After the last point
 * the value holds until the morning, which goes back to the day value.
 */
export const GRAPH_SPAN = 540;       // 9 hours: from sunset to well after midnight

// Brightness, when its small points are not moved: like the light outside,
// most of the drop in the first part, then slower (the part of the way
// still left at 1/4, 1/2 and 3/4 of the duration).
const SUNSET_SHAPE = [0.33, 0.15, 0.06];

export function knotTimes(duration) {
    const after = GRAPH_SPAN - duration;
    return [0, duration / 4, duration / 2, duration * 3 / 4, duration,
        duration + after / 3, duration + after * 2 / 3, GRAPH_SPAN];
}

const clamp01 = v => Math.max(0, Math.min(1, v));

/** Start and main value of a layer. */
export function curveEnds(cfg, key) {
    const day = key === 'night' ? cfg.day ?? 1 : 0;
    const main = key === 'night' ? Math.min(day, cfg.night) : cfg.extra;
    return {day, main};
}

/** [[minutes, value] x 8] */
export function curveKnots(cfg, key) {
    const {day, main} = curveEnds(cfg, key);
    const own = cfg.points?.[key] ?? [];
    const times = knotTimes(cfg.duration);
    const values = [
        day,
        ...[1, 2, 3].map(i => own[i - 1] ?? (key === 'night'
            ? main + (day - main) * SUNSET_SHAPE[i - 1]
            : day + (main - day) * smooth(i / 4))),
        main,
        ...[0, 1, 2].map(j => own[3 + j] ?? main),
    ].map(clamp01);
    return times.map((t, i) => [t, values[i]]);
}

/** Smooth curve through the points that never overshoots (monotone cubic). */
export function curveAt(knots, min) {
    const n = knots.length;
    if (min <= knots[0][0])
        return knots[0][1];
    if (min >= knots[n - 1][0])
        return knots[n - 1][1];
    let i = 0;
    while (min > knots[i + 1][0])
        i++;
    const slope = k => {
        if (k <= 0 || k >= n - 1)
            return 0;
        const [t0, v0] = knots[k - 1], [t1, v1] = knots[k], [t2, v2] = knots[k + 1];
        const a = (v1 - v0) / (t1 - t0), b = (v2 - v1) / (t2 - t1);
        return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
    };
    const [t0, v0] = knots[i], [t1, v1] = knots[i + 1];
    const h = t1 - t0, s = (min - t0) / h;
    const m0 = slope(i) * h, m1 = slope(i + 1) * h;
    const s2 = s * s, s3 = s2 * s;
    return clamp01((2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * m1);
}

/** Value of a layer right now: day value by day, the curve in the evening and at night. */
export function curveValue(now, phase, cfg, key) {
    const {day} = curveEnds(cfg, key);
    if (!phase || phase.phase === 'day')
        return day;
    const knots = curveKnots(cfg, key);
    if (phase.phase === 'morning')
        return day + (knots[knots.length - 1][1] - day) * phase.progress;
    return curveAt(knots, (now.getTime() - phase.start) / MIN);
}

/** True while the curves are still changing (the evening and the shaped part of the night). */
export function curveMoving(now, phase) {
    if (!phase || phase.phase === 'day')
        return false;
    if (phase.phase === 'morning')
        return true;
    return (now.getTime() - phase.start) / MIN < GRAPH_SPAN;
}

/** Brightness a monitor should have now (0..1). */
export function scheduledValue(phase, cfg, now = new Date()) {
    return curveValue(now, phase, cfg, 'night');
}

/**
 * Extra dimming now (0..1). Without evening dimming it applies all day;
 * with it, it follows its curve.
 */
export function layerValues(phase, cfg, now = new Date()) {
    return {extra: cfg.schedule ? curveValue(now, phase, cfg, 'extra') : cfg.extra};
}

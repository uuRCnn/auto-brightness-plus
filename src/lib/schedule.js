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
 * @param {object} cfg monitor config {offset, start}
 * @param {object} g global settings {mode, transition, morningOffset, morningTime, lat, lon}
 */
export function dayTimes(day, cfg, g) {
    const base = midnight(day);
    const T = g.transition * MIN;
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
    return {morningStart, morningEnd, eveningStart, eveningEnd: eveningStart + T, sunset, sunrise};
}

/**
 * @returns {{phase: 'day'|'evening'|'night'|'morning', progress: number,
 *            next: number, rampStart: number}}
 *   progress: 0 = day brightness, 1 = night brightness (already smoothed)
 *   next: time of the next phase change (ms)
 */
export function phaseAt(now, cfg, g) {
    const t = now.getTime();
    const today = dayTimes(now, cfg, g);
    if (t < today.morningStart)
        return {phase: 'night', progress: 1, next: today.morningStart};
    if (t < today.morningEnd) {
        const p = (t - today.morningStart) / (today.morningEnd - today.morningStart);
        return {phase: 'morning', progress: 1 - smooth(p), next: today.morningEnd};
    }
    if (t < today.eveningStart)
        return {phase: 'day', progress: 0, next: today.eveningStart};
    if (t < today.eveningEnd) {
        const p = (t - today.eveningStart) / (today.eveningEnd - today.eveningStart);
        return {phase: 'evening', progress: smooth(p), next: today.eveningEnd};
    }
    const tomorrow = dayTimes(new Date(t + DAY), cfg, g);
    return {phase: 'night', progress: 1, next: Math.max(tomorrow.morningStart, t + MIN)};
}

/** Brightness a monitor should have now (0..1). */
export function scheduledValue(phase, cfg) {
    return cfg.day + (Math.min(cfg.day, cfg.night) - cfg.day) * phase.progress;
}

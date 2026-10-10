// Sunrise / sunset times (NOAA "Almanac for Computers" algorithm).
// Accurate to about a minute, which is plenty for dimming a monitor.
// Pure JavaScript: used by both the shell process and the preferences.

const RAD = Math.PI / 180;
const ZENITH = 90.833; // official sunrise/sunset (refraction + solar disc)

function mod(a, b) {
    return ((a % b) + b) % b;
}

function dayOfYear(date) {
    const start = Date.UTC(date.getFullYear(), 0, 0);
    const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round((now - start) / 86400000);
}

// UTC hour of the event, or NaN when the sun does not rise / set that day.
function eventUtcHours(n, lat, lon, rising) {
    const lngHour = lon / 15;
    const t = n + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    const L = mod(M + 1.916 * Math.sin(M * RAD) + 0.020 * Math.sin(2 * M * RAD) + 282.634, 360);
    let RA = mod(Math.atan(0.91764 * Math.tan(L * RAD)) / RAD, 360);
    RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * RAD);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(ZENITH * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));
    if (cosH > 1 || cosH < -1)
        return NaN;
    let H = Math.acos(cosH) / RAD;
    if (rising)
        H = 360 - H;
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return mod(T - lngHour, 24);
}

// Local Date of the event on the local calendar day of `date`.
function eventDate(date, lat, lon, rising) {
    const ut = eventUtcHours(dayOfYear(date), lat, lon, rising);
    if (Number.isNaN(ut))
        return null;
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
    let ms = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + ut * 3600000;
    // keep the result on the same local day as `date`
    while (ms - noon > 12 * 3600000)
        ms -= 86400000;
    while (noon - ms > 12 * 3600000)
        ms += 86400000;
    return new Date(ms);
}

/**
 * @param {Date} date any time on the wanted (local) day
 * @param {number} lat latitude in degrees
 * @param {number} lon longitude in degrees
 * @returns {{sunrise: Date|null, sunset: Date|null}} null on polar day / night
 */
export function sunTimes(date, lat, lon) {
    return {
        sunrise: eventDate(date, lat, lon, true),
        sunset: eventDate(date, lat, lon, false),
    };
}

/** Minutes after local midnight, e.g. for showing "18:52". */
export function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
}

export function formatMinutes(minutes) {
    const m = mod(Math.round(minutes), 1440);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** printf-like "%s" / "%d" replacement (String.prototype.format is shell-only). */
export function fmt(str, ...args) {
    let i = 0;
    return str.replace(/%[sd]/g, () => String(args[i++] ?? ''));
}

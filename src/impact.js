// What a commute costs the city (CO2e) and the commuter (PM2.5 exposure), so a swap can be explained in numbers.
// Factors are rough India-typical averages per passenger-km, meant for awareness rather than carbon accounting:
//   car: ~15 km/L petrol at 2.31 kg CO2/L, one rider. Two-wheeler: ~50 km/L. Bus: a diesel/CNG bus at ~1.1 kg/km
//   shared by ~35 riders. Metro: grid electricity on a busy line. Walking, cycling and working from home emit nothing.
// Exposure follows commuter studies in Indian cities: open vehicles in traffic breathe the most PM2.5, metro the least.
/** @import { CommuteMode, CommuteImpact, CommuteAlternative, CurrentCommute, Exposure, Profile } from './types.js' */
import { roundTo } from './util.js';

/** @satisfies {Record<string, { label: string, kgPerKm: number, exposure: Exposure }>} */
export const MODES = {
  car: { label: 'Car or cab', kgPerKm: 0.15, exposure: 'medium' },
  two_wheeler: { label: 'Two-wheeler', kgPerKm: 0.05, exposure: 'high' },
  bus: { label: 'Bus', kgPerKm: 0.03, exposure: 'medium' },
  metro: { label: 'Metro or train', kgPerKm: 0.03, exposure: 'low' },
  walk_cycle: { label: 'Walk or cycle', kgPerKm: 0, exposure: 'high' },
  wfh: { label: 'Work from home', kgPerKm: 0, exposure: 'low' },
};

/** A mature tree takes up roughly 21 kg of CO2 a year (widely quoted estimate), a scale people can picture. */
const TREE_KG_PER_YEAR = 21;
const WEEKS_PER_YEAR = 52;
/** Further than this one way, few people will actually walk or cycle it. */
const WALKABLE_KM = 5;

/**
 * A weekly saving, also per year and in trees.
 * @param {number} savedKgPerWeek
 */
function yearly(savedKgPerWeek) {
  const savedKgPerYear = Math.round(savedKgPerWeek * WEEKS_PER_YEAR);
  return { savedKgPerWeek, savedKgPerYear, trees: Math.round(savedKgPerYear / TREE_KG_PER_YEAR) };
}

/**
 * Weekly CO2e of the current commute and what each realistic alternative would save, biggest saving first.
 * @param {Profile['commute']} commute  mode, one-way distance in km and days a week
 * @returns {CommuteImpact}
 */
export function commuteImpact({ mode, km, days }) {
  const weeklyKm = km * 2 * days;
  /** @param {CommuteMode} option */
  const kgPerWeek = (option) => roundTo(MODES[option].kgPerKm * weeklyKm, 1);
  /** @type {CurrentCommute} */
  const current = {
    mode,
    label: MODES[mode].label,
    weeklyKm,
    kgPerWeek: kgPerWeek(mode),
    exposure: MODES[mode].exposure,
  };
  if (mode === 'wfh' || weeklyKm === 0) return { current, alternatives: [] };

  /** @type {CommuteMode[]} */
  const options = ['metro', 'bus'];
  if (km <= WALKABLE_KM) options.push('walk_cycle');
  if (mode === 'car') options.push('two_wheeler'); // lower CO2 but more exposure: a trade-off worth showing

  /** @type {CommuteAlternative[]} */
  const alternatives = options
    .filter((option) => option !== mode)
    .map((option) => ({
      mode: option,
      label: MODES[option].label,
      kgPerWeek: kgPerWeek(option),
      exposure: MODES[option].exposure,
      ...yearly(roundTo(current.kgPerWeek - kgPerWeek(option), 1)),
    }));

  // One extra work-from-home day on the smoggiest day of the week: often the easiest win.
  if (days > 1) {
    const saved = roundTo(current.kgPerWeek / days, 1);
    alternatives.push({
      mode: 'wfh',
      label: 'One more day working from home',
      kgPerWeek: roundTo(current.kgPerWeek - saved, 1),
      exposure: 'low',
      ...yearly(saved),
    });
  }
  return {
    current,
    alternatives: alternatives
      .filter((option) => option.savedKgPerWeek > 0)
      .sort((a, b) => b.savedKgPerWeek - a.savedKgPerWeek),
  };
}

// What a commute costs the city (CO2e) and the commuter (PM2.5 exposure), so a swap can be explained in numbers.
// Factors are rough India-typical averages per passenger-km, meant for awareness rather than carbon accounting:
//   car: ~15 km/L petrol at 2.31 kg CO2/L, one rider. Two-wheeler: ~50 km/L. Bus: a diesel/CNG bus at ~1.1 kg/km
//   shared by ~35 riders. Metro: grid electricity on a busy line. Walking, cycling and working from home emit nothing.
// Exposure follows commuter studies in Indian cities: open vehicles in traffic breathe the most PM2.5, metro the least.
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
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Weekly CO2e of the current commute and what each realistic alternative would save.
 * @param {{ mode: keyof MODES, km: number, days: number }} commute  one-way distance in km, days a week
 */
export function commuteImpact({ mode, km, days }) {
  const weeklyKm = km * 2 * days;
  const kgPerWeek = (m) => round1(MODES[m].kgPerKm * weeklyKm);
  const current = { mode, label: MODES[mode].label, weeklyKm, kgPerWeek: kgPerWeek(mode), exposure: MODES[mode].exposure };
  if (mode === 'wfh' || weeklyKm === 0) return { current, alternatives: [] };

  const options = ['metro', 'bus'];
  if (km <= 5) options.push('walk_cycle'); // further than this, few people will actually walk or cycle it
  if (mode === 'car') options.push('two_wheeler'); // lower CO2 but more exposure: a trade-off worth showing

  const alternatives = options
    .filter((m) => m !== mode)
    .map((m) => {
      const saved = round1(current.kgPerWeek - kgPerWeek(m));
      return { mode: m, label: MODES[m].label, kgPerWeek: kgPerWeek(m), exposure: MODES[m].exposure, ...yearly(saved) };
    });

  // One extra work-from-home day on the smoggiest day of the week: often the easiest win.
  if (days > 1) {
    const saved = round1(current.kgPerWeek / days);
    alternatives.push({ mode: 'wfh', label: 'One more day working from home', kgPerWeek: round1(current.kgPerWeek - saved), exposure: 'low', ...yearly(saved) });
  }
  return {
    current,
    alternatives: alternatives.filter((a) => a.savedKgPerWeek > 0).sort((a, b) => b.savedKgPerWeek - a.savedKgPerWeek),
  };
}

function yearly(savedKgPerWeek) {
  const savedKgPerYear = Math.round(savedKgPerWeek * WEEKS_PER_YEAR);
  return { savedKgPerWeek, savedKgPerYear, trees: Math.round(savedKgPerYear / TREE_KG_PER_YEAR) };
}

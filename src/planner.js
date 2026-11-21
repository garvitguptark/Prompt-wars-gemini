// Puts a plan together: live air + commute numbers + Gemini, with built-in guidance when Gemini can't answer,
// so a family always gets something useful and the page says honestly which one they got.
import { commuteImpact } from './impact.js';
import { rangeLabel, hourLabel } from './aqi.js';
import { ttlCache } from './cache.js';
import { log as defaultLog } from './log.js';

export function createPlanner({ air, gemini, log = defaultLog, now = Date.now }) {
  const plans = ttlCache({ ttlMs: 30 * 60_000, max: 300, now }); // same household, same reading: same plan, no new tokens

  async function context(place, profile) {
    return { place, air: await air.lookup(place), profile, commute: commuteImpact(profile.commute) };
  }

  return {
    async plan(place, profile) {
      const ctx = await context(place, profile);
      const base = { air: ctx.air, commute: ctx.commute };
      if (gemini.enabled) {
        try {
          const key = JSON.stringify([place, ctx.air.updated, profile]);
          const { plan, model } = await plans.remember(key, () => gemini.plan(ctx));
          return { ...base, source: 'gemini', model, plan };
        } catch (err) {
          log('WARNING', 'Gemini plan failed, using built-in guidance', { error: err.message, status: err.status });
        }
      }
      return { ...base, source: 'rules', plan: rulesPlan(ctx) };
    },

    async ask(place, profile, question) {
      if (!gemini.enabled) throw offline();
      const ctx = await context(place, profile);
      try {
        return await gemini.ask(ctx, question);
      } catch (err) {
        log('WARNING', 'Gemini answer failed', { error: err.message, status: err.status });
        throw offline();
      }
    },
  };
}

const offline = () =>
  Object.assign(new Error('The assistant is offline right now. Your plan still applies; try asking again in a few minutes.'), { status: 503 });

const WHO_FOR = { children: 'your child', elderly: 'older family members', respiratory: 'anyone with asthma or a heart condition', pregnant: 'anyone pregnant' };
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const item = (title, action, why, impact, impactType, time) => ({ ...(time ? { time } : {}), title, action, why, impact, impactType });
const N95 = 'A well-fitted N95 cuts the PM2.5 you inhale by roughly 60–90%.';
const SWAP = {
  metro: { title: 'Take the metro', how: 'the metro or train', transit: true },
  bus: { title: 'Take the bus', how: 'the bus', transit: true },
  walk_cycle: { title: 'Walk or cycle it', how: 'walking or cycling', transit: true },
  wfh: { title: 'Work from home once more' },
};

/** Deterministic plan from the same inputs Gemini gets. English only; used when Gemini is unavailable. */
export function rulesPlan({ place, air, profile, commute }) {
  const tz = place.tz;
  const { aqi, band, windows } = air;
  const unhealthy = aqi > 100;
  const { cleanest: clean, worst } = windows ?? {};
  const cleanAt = clean && rangeLabel(clean, tz);
  const cleanOk = clean && clean.avgAqi <= 150; // worth opening up for: no worse than "unhealthy for sensitive groups"
  const sensitive = profile.household.map((h) => WHO_FOR[h]);

  const routine = [
    unhealthy
      ? item('Keep the smog outside', `Keep windows and doors shut ${cleanOk ? `until ${hourLabel(clean.start, tz)}` : 'today'}, and dry laundry indoors.`,
        'Outdoor PM2.5 seeps in through open windows and gaps; closing up keeps the cleaner indoor air in.', 'Keeps most outdoor PM2.5 out of your rooms.', 'exposure', 'Morning')
      : item('Air the house', 'Open windows on opposite sides for 10–15 minutes.',
        'A cross-breeze flushes out cooking fumes and stale air while the outdoor air is acceptable.', 'Lowers the pollution that builds up indoors overnight.', 'exposure', 'Morning'),
  ];
  if (profile.commute.mode !== 'wfh') routine.push(commuteItem(profile.commute.mode, unhealthy));
  if (profile.exercise !== 'none') {
    const outside = cleanOk && unhealthy;
    routine.push(!unhealthy
      ? item('Enjoy your workout', 'Exercise outdoors as usual, on paths away from busy roads.', 'Pollution drops quickly a street or two away from heavy traffic.', 'Keeps your exercise dose of exhaust low.', 'exposure', profile.exercise === 'morning' ? 'Morning' : 'Evening')
      : outside
        ? item('Move your workout', `Exercise outdoors at ${cleanAt} instead, away from busy roads.`, 'You breathe several times more air while exercising, so bad air multiplies the dose.',
          `The air then averages AQI ${clean.avgAqi}, against ${aqi} now.`, 'exposure', cleanAt)
        : item('Exercise indoors today', 'Swap the outdoor session for indoor exercise, yoga or stretching with the windows shut.',
          'You breathe several times more air while exercising, so bad air multiplies the dose.', `Avoids a heavy dose of air that is ${band.label.toLowerCase()} right now.`, 'exposure',
          profile.exercise === 'morning' ? 'Morning' : 'Evening'));
  }
  if (clean && unhealthy) {
    routine.push(cleanOk
      ? item('Ventilate in the clean window', `Open the windows for 10–15 minutes at ${cleanAt}, then shut them again.`,
        'Homes need fresh air to clear cooking fumes; this is when the outdoor air is least bad.', `The air then averages AQI ${clean.avgAqi} (${clean.band.label.toLowerCase()}).`, 'exposure', cleanAt)
      : item('Skip airing out today', 'Ventilate only the kitchen, with the exhaust fan, while cooking; keep other windows shut.',
        `Even the best hours today average AQI ${clean.avgAqi}, so opening up lets smog in.`, 'Keeps indoor PM2.5 below the outdoor level all day.', 'exposure', cleanAt));
  }
  if (worst && worst.avgAqi > 100) {
    routine.push(item('Seal up for the worst hours', `Stay in with windows shut from ${hourLabel(worst.start, tz)} to ${hourLabel(worst.end, tz)}${profile.purifier ? ', purifier on high' : ''}.`,
      `Smog peaks then, at an average AQI of ${worst.avgAqi}.`, "Avoids the day's heaviest exposure.", 'exposure', rangeLabel(worst, tz)));
  }

  const indoor = [
    profile.purifier
      ? item('Run the purifier right', `Run it on high in the room where ${sensitive[0] ?? 'the family'} sleeps, door shut, and check the filter.`,
        'A HEPA filter cleans the closed room it is in; a clogged filter moves little air.', 'Typically cuts indoor PM2.5 by 50–80% in that room.', 'exposure')
      : item('Build a box-fan filter', 'Strap a MERV-13 filter to the back of a box fan and run it in the bedroom with the door shut.',
        'The fan pulls room air through the filter, which traps fine particles, for a fraction of the cost of a purifier.', 'Substantially cuts PM2.5 in one room.', 'exposure'),
    cookingItem(profile.cooking),
    item('No incense or mosquito coils', 'Skip incense, mosquito coils and candles; use a net or a plug-in repellent instead.',
      'Burning them releases fine particles straight into the room.', 'One mosquito coil can give off as much PM2.5 as dozens of cigarettes.', 'exposure'),
    item("Mop, don't sweep", 'Clean floors with a damp mop and dust with a damp cloth.', 'Sweeping throws settled dust back into the air; water holds it down.',
      'Keeps settled particles out of the air you breathe.', 'exposure'),
  ];

  // The best low-exposure switch plus the extra home day; a two-wheeler cuts CO2 but raises exposure, so it isn't offered here.
  const picks = [commute.alternatives.find((a) => SWAP[a.mode]?.transit), commute.alternatives.find((a) => a.mode === 'wfh')].filter(Boolean);
  const swaps = picks.map((a) => item(SWAP[a.mode].title,
    a.mode === 'wfh' ? 'Work from home on the smoggiest day of the week.' : `Switch to ${SWAP[a.mode].how} for your ${profile.commute.km} km commute, even 2–3 days a week.`,
    `Your commute emits about ${commute.current.kgPerWeek} kg CO2e a week; this brings it to ${a.kgPerWeek} kg.`,
    `Saves ${a.savedKgPerWeek} kg a week and ${a.savedKgPerYear} kg a year, what ${a.trees} trees absorb in a year.`,
    a.exposure === 'low' ? 'both' : 'emissions'));
  if (['car', 'two_wheeler'].includes(profile.commute.mode)) {
    swaps.push(item('Engine off at long signals', 'Switch the engine off at red lights longer than about 10 seconds.',
      'An idling engine burns fuel and pumps out exhaust while going nowhere.', 'Saves fuel and cuts the exhaust your street breathes.', 'emissions'));
  }
  swaps.push(item('Never burn rubbish or leaves', 'Bag waste for collection and report open burning to local authorities.',
    'Open burning is a major local source of winter smog.', 'Removes one of the biggest neighbourhood sources of PM2.5.', 'emissions'));

  const alerts = [];
  if (unhealthy && sensitive.length) alerts.push(`The air is ${band.label.toLowerCase()}: keep outdoor time short for ${list(sensitive)}, with a well-fitted N95 outside.`);
  if (aqi > 200) alerts.push('Watch for breathlessness, chest pain or dizziness, and contact a doctor if they appear.');

  const summary = `The air in ${place.name} is ${band.label.toLowerCase()} right now (US AQI ${aqi}), with PM2.5 at ${air.whoMultiple}× the WHO daily guideline. ` +
    (cleanAt ? `The cleanest stretch today is ${cleanAt}. ` : '') +
    (unhealthy ? 'Keep the air inside cleaner than the air outside: windows shut and no smoke indoors.' : 'A good day to air out the house and get outside.');

  return { summary, alerts, routine, indoor, swaps: swaps.slice(0, 4) };
}

function commuteItem(mode, unhealthy) {
  if (mode === 'car') {
    return item('Recirculate in the car', 'Drive with windows up and the AC on recirculate; replace the cabin filter if it looks grey.',
      'Recirculation stops the car pulling in exhaust from the vehicles around you.', 'Cuts the traffic fumes you breathe on the way.', 'exposure', 'Commute');
  }
  if (mode === 'two_wheeler' || mode === 'walk_cycle') {
    return unhealthy
      ? item('Mask up for the ride', 'Wear a well-fitted N95 and take roads away from heavy traffic.',
        'Open-air commuters breathe exhaust directly, and pollution drops sharply a street or two from main roads.', N95, 'exposure', 'Commute')
      : item('Pick the quieter route', 'Take roads away from heavy traffic, even if slightly longer.',
        'Pollution drops sharply a street or two from main roads.', 'Cuts the exhaust you breathe on the way.', 'exposure', 'Commute');
  }
  return item('Mask up on the way', 'Wear a well-fitted N95 to the stop and on the platform, and wait indoors when you can.',
    'Stops and platforms by busy roads sit in exhaust; an N95 filters fine particles.', N95, 'exposure', 'Commute');
}

function cookingItem(cooking) {
  if (cooking === 'biomass') {
    return item('Get cooking smoke out', 'Cook where smoke can escape, under a chimney or by an open door, and switch to LPG or induction if you can.',
      'Wood, coal and dung smoke is one of the biggest sources of indoor PM2.5.', 'Switching fuel removes most of that smoke, for the cook and the neighbours.', 'both');
  }
  if (cooking === 'gas') {
    return item('Lid on, exhaust on', 'Cook with lids on and the chimney or exhaust fan running, and keep it on 10 minutes after.',
      'Gas flames give off NO2 and frying releases fine particles; the exhaust carries both outside.', 'Cuts the NO2 and smoke that build up in the kitchen.', 'exposure');
  }
  return item('Exhaust on when frying', 'Run the chimney or exhaust fan whenever you fry or grill.',
    'Frying releases fine particles even on induction; the exhaust carries them outside.', 'Keeps cooking smoke from spreading through the home.', 'exposure');
}

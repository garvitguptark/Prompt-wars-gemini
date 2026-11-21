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
  Object.assign(
    new Error('The assistant is offline right now. Your plan still applies; try asking again in a few minutes.'),
    { status: 503 },
  );

const WHO_FOR = {
  children: 'your child',
  elderly: 'older family members',
  respiratory: 'anyone with asthma or a heart condition',
  pregnant: 'anyone pregnant',
};
const N95 = 'A well-fitted N95 cuts the PM2.5 you inhale by roughly 60–90%.';
const EXERCISE_DOSE = 'You breathe several times more air while exercising, so bad air multiplies the dose.';
const SWAP = {
  metro: { title: 'Take the metro', how: 'the metro or train', transit: true },
  bus: { title: 'Take the bus', how: 'the bus', transit: true },
  walk_cycle: { title: 'Walk or cycle it', how: 'walking or cycling', transit: true },
  wfh: { title: 'Work from home once more' },
};

/** One plan item. `type` is what it reduces: 'exposure', 'emissions' or 'both'. */
const item = (title, { action, why, impact, type = 'exposure', time }) => ({
  ...(time ? { time } : {}),
  title,
  action,
  why,
  impact,
  impactType: type,
});
const joinNames = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** What today's readings mean for planning, worked out once. */
function readDay({ place, air }) {
  const { cleanest: clean, worst } = air.windows ?? {};
  return {
    tz: place.tz,
    air,
    unhealthy: air.aqi > 100,
    clean,
    worst,
    cleanAt: clean && rangeLabel(clean, place.tz),
    cleanOk: Boolean(clean && clean.avgAqi <= 150), // worth opening up for: no worse than "unhealthy for sensitive groups"
  };
}

function morningItem({ unhealthy, cleanOk, clean, tz }) {
  if (!unhealthy) {
    return item('Air the house', {
      action: 'Open windows on opposite sides for 10–15 minutes.',
      why: 'A cross-breeze flushes out cooking fumes and stale air while the outdoor air is acceptable.',
      impact: 'Lowers the pollution that builds up indoors overnight.',
      time: 'Morning',
    });
  }
  return item('Keep the smog outside', {
    action: `Keep windows and doors shut ${cleanOk ? `until ${hourLabel(clean.start, tz)}` : 'today'}, and dry laundry indoors.`,
    why: 'Outdoor PM2.5 seeps in through open windows and gaps; closing up keeps the cleaner indoor air in.',
    impact: 'Keeps most outdoor PM2.5 out of your rooms.',
    time: 'Morning',
  });
}

function exerciseItem({ unhealthy, cleanOk, clean, cleanAt, air }, exercise) {
  const usual = exercise === 'morning' ? 'Morning' : 'Evening';
  if (!unhealthy) {
    return item('Enjoy your workout', {
      action: 'Exercise outdoors as usual, on paths away from busy roads.',
      why: 'Pollution drops quickly a street or two away from heavy traffic.',
      impact: 'Keeps your exercise dose of exhaust low.',
      time: usual,
    });
  }
  if (cleanOk) {
    return item('Move your workout', {
      action: `Exercise outdoors at ${cleanAt} instead, away from busy roads.`,
      why: EXERCISE_DOSE,
      impact: `The air then averages AQI ${clean.avgAqi}, against ${air.aqi} now.`,
      time: cleanAt,
    });
  }
  return item('Exercise indoors today', {
    action: 'Swap the outdoor session for indoor exercise, yoga or stretching with the windows shut.',
    why: EXERCISE_DOSE,
    impact: `Avoids a heavy dose of air that is ${air.band.label.toLowerCase()} right now.`,
    time: usual,
  });
}

function ventilationItem({ cleanOk, clean, cleanAt }) {
  if (cleanOk) {
    return item('Ventilate in the clean window', {
      action: `Open the windows for 10–15 minutes at ${cleanAt}, then shut them again.`,
      why: 'Homes need fresh air to clear cooking fumes; this is when the outdoor air is least bad.',
      impact: `The air then averages AQI ${clean.avgAqi} (${clean.band.label.toLowerCase()}).`,
      time: cleanAt,
    });
  }
  return item('Skip airing out today', {
    action: 'Ventilate only the kitchen, with the exhaust fan, while cooking; keep other windows shut.',
    why: `Even the best hours today average AQI ${clean.avgAqi}, so opening up lets smog in.`,
    impact: 'Keeps indoor PM2.5 below the outdoor level all day.',
    time: cleanAt,
  });
}

function worstHoursItem({ worst, tz }, purifier) {
  return item('Seal up for the worst hours', {
    action: `Stay in with windows shut from ${hourLabel(worst.start, tz)} to ${hourLabel(worst.end, tz)}${purifier ? ', purifier on high' : ''}.`,
    why: `Smog peaks then, at an average AQI of ${worst.avgAqi}.`,
    impact: "Avoids the day's heaviest exposure.",
    time: rangeLabel(worst, tz),
  });
}

function commuteItem(mode, unhealthy) {
  if (mode === 'car') {
    return item('Recirculate in the car', {
      action: 'Drive with windows up and the AC on recirculate; replace the cabin filter if it looks grey.',
      why: 'Recirculation stops the car pulling in exhaust from the vehicles around you.',
      impact: 'Cuts the traffic fumes you breathe on the way.',
      time: 'Commute',
    });
  }
  if (mode !== 'two_wheeler' && mode !== 'walk_cycle') {
    return item('Mask up on the way', {
      action: 'Wear a well-fitted N95 to the stop and on the platform, and wait indoors when you can.',
      why: 'Stops and platforms by busy roads sit in exhaust; an N95 filters fine particles.',
      impact: N95,
      time: 'Commute',
    });
  }
  if (!unhealthy) {
    return item('Pick the quieter route', {
      action: 'Take roads away from heavy traffic, even if slightly longer.',
      why: 'Pollution drops sharply a street or two from main roads.',
      impact: 'Cuts the exhaust you breathe on the way.',
      time: 'Commute',
    });
  }
  return item('Mask up for the ride', {
    action: 'Wear a well-fitted N95 and take roads away from heavy traffic.',
    why: 'Open-air commuters breathe exhaust directly, and pollution drops sharply a street or two from main roads.',
    impact: N95,
    time: 'Commute',
  });
}

/** The day in time order: morning, commute, exercise, the clean window, the worst hours. */
function routineFor(day, profile) {
  return [
    morningItem(day),
    profile.commute.mode !== 'wfh' && commuteItem(profile.commute.mode, day.unhealthy),
    profile.exercise !== 'none' && exerciseItem(day, profile.exercise),
    day.clean && day.unhealthy && ventilationItem(day),
    day.worst && day.worst.avgAqi > 100 && worstHoursItem(day, profile.purifier),
  ].filter(Boolean);
}

function cookingItem(cooking) {
  if (cooking === 'biomass') {
    return item('Get cooking smoke out', {
      action:
        'Cook where smoke can escape, under a chimney or by an open door, and switch to LPG or induction if you can.',
      why: 'Wood, coal and dung smoke is one of the biggest sources of indoor PM2.5.',
      impact: 'Switching fuel removes most of that smoke, for the cook and the neighbours.',
      type: 'both',
    });
  }
  if (cooking === 'gas') {
    return item('Lid on, exhaust on', {
      action: 'Cook with lids on and the chimney or exhaust fan running, and keep it on 10 minutes after.',
      why: 'Gas flames give off NO2 and frying releases fine particles; the exhaust carries both outside.',
      impact: 'Cuts the NO2 and smoke that build up in the kitchen.',
    });
  }
  return item('Exhaust on when frying', {
    action: 'Run the chimney or exhaust fan whenever you fry or grill.',
    why: 'Frying releases fine particles even on induction; the exhaust carries them outside.',
    impact: 'Keeps cooking smoke from spreading through the home.',
  });
}

function indoorFor(profile, sensitive) {
  const filter = profile.purifier
    ? item('Run the purifier right', {
        action: `Run it on high in the room where ${sensitive[0] ?? 'the family'} sleeps, door shut, and check the filter.`,
        why: 'A HEPA filter cleans the closed room it is in; a clogged filter moves little air.',
        impact: 'Typically cuts indoor PM2.5 by 50–80% in that room.',
      })
    : item('Build a box-fan filter', {
        action: 'Strap a MERV-13 filter to the back of a box fan and run it in the bedroom with the door shut.',
        why: 'The fan pulls room air through the filter, which traps fine particles, for a fraction of the cost of a purifier.',
        impact: 'Substantially cuts PM2.5 in one room.',
      });
  return [
    filter,
    cookingItem(profile.cooking),
    item('No incense or mosquito coils', {
      action: 'Skip incense, mosquito coils and candles; use a net or a plug-in repellent instead.',
      why: 'Burning them releases fine particles straight into the room.',
      impact: 'One mosquito coil can give off as much PM2.5 as dozens of cigarettes.',
    }),
    item("Mop, don't sweep", {
      action: 'Clean floors with a damp mop and dust with a damp cloth.',
      why: 'Sweeping throws settled dust back into the air; water holds it down.',
      impact: 'Keeps settled particles out of the air you breathe.',
    }),
  ];
}

/**
 * The best low-exposure commute switch and the extra home day, with their computed savings, then two habits that
 * cut local smog. A two-wheeler cuts CO2 but raises exposure, so it isn't offered here.
 */
function swapsFor(profile, commute) {
  const picks = [
    commute.alternatives.find((a) => SWAP[a.mode]?.transit),
    commute.alternatives.find((a) => a.mode === 'wfh'),
  ].filter(Boolean);
  const swaps = picks.map((a) =>
    item(SWAP[a.mode].title, {
      action:
        a.mode === 'wfh'
          ? 'Work from home on the smoggiest day of the week.'
          : `Switch to ${SWAP[a.mode].how} for your ${profile.commute.km} km commute, even 2–3 days a week.`,
      why: `Your commute emits about ${commute.current.kgPerWeek} kg CO2e a week; this brings it to ${a.kgPerWeek} kg.`,
      impact: `Saves ${a.savedKgPerWeek} kg a week and ${a.savedKgPerYear} kg a year, what ${a.trees} trees absorb in a year.`,
      type: a.exposure === 'low' ? 'both' : 'emissions',
    }),
  );
  if (['car', 'two_wheeler'].includes(profile.commute.mode)) {
    swaps.push(
      item('Engine off at long signals', {
        action: 'Switch the engine off at red lights longer than about 10 seconds.',
        why: 'An idling engine burns fuel and pumps out exhaust while going nowhere.',
        impact: 'Saves fuel and cuts the exhaust your street breathes.',
        type: 'emissions',
      }),
    );
  }
  swaps.push(
    item('Never burn rubbish or leaves', {
      action: 'Bag waste for collection and report open burning to local authorities.',
      why: 'Open burning is a major local source of winter smog.',
      impact: 'Removes one of the biggest neighbourhood sources of PM2.5.',
      type: 'emissions',
    }),
  );
  return swaps.slice(0, 4);
}

function alertsFor({ unhealthy, air }, sensitive) {
  const alerts = [];
  if (unhealthy && sensitive.length) {
    alerts.push(
      `The air is ${air.band.label.toLowerCase()}: keep outdoor time short for ${joinNames(sensitive)}, with a well-fitted N95 outside.`,
    );
  }
  if (air.aqi > 200)
    alerts.push('Watch for breathlessness, chest pain or dizziness, and contact a doctor if they appear.');
  return alerts;
}

function summaryFor({ air, cleanAt, unhealthy }, place) {
  return [
    `The air in ${place.name} is ${air.band.label.toLowerCase()} right now (US AQI ${air.aqi}), with PM2.5 at ${air.whoMultiple}× the WHO daily guideline.`,
    cleanAt && `The cleanest stretch today is ${cleanAt}.`,
    unhealthy
      ? 'Keep the air inside cleaner than the air outside: windows shut and no smoke indoors.'
      : 'A good day to air out the house and get outside.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Deterministic plan from the same inputs Gemini gets. English only; used when Gemini is unavailable. */
export function rulesPlan({ place, air, profile, commute }) {
  const day = readDay({ place, air });
  const sensitive = profile.household.map((member) => WHO_FOR[member]);
  return {
    summary: summaryFor(day, place),
    alerts: alertsFor(day, sensitive),
    routine: routineFor(day, profile),
    indoor: indoorFor(profile, sensitive),
    swaps: swapsFor(profile, commute),
  };
}

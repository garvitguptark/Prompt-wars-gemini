// The built-in plan: fixed rules over the same inputs Gemini gets, used when Gemini can't answer, so a family
// always gets something useful. Every item is timed with the forecast windows and fitted to the household.
/**
 * @import { AirSummary, AqiWindow, CommuteAlternative, CommuteImpact, CommuteMode, CookingFuel, ExerciseTime,
 *   HouseholdMember, ImpactType, Place, Plan, PlanContext, PlanItem, Profile } from './types.js'
 */
import { rangeLabel, hourLabel } from './aqi.js';
import { PLAN_ITEMS } from './plan-schema.js';

/** Above this US AQI the air is unhealthy, at least for sensitive groups. */
const UNHEALTHY_ABOVE = 100;
/** A window is worth opening up for when it averages no worse than "unhealthy for sensitive groups". */
const AIRABLE_MAX = 150;
/** Above this US AQI everyone should watch for symptoms. */
const SYMPTOMS_ABOVE = 200;

/** @type {Record<HouseholdMember, string>} */
const WHO_FOR = {
  children: 'your child',
  elderly: 'older family members',
  respiratory: 'anyone with asthma or a heart condition',
  pregnant: 'anyone pregnant',
};
const N95 = 'A well-fitted N95 cuts the PM2.5 you inhale by roughly 60–90%.';
const EXERCISE_DOSE = 'You breathe several times more air while exercising, so bad air multiplies the dose.';
/**
 * Low-exposure switches worth suggesting, with how to say them. A two-wheeler cuts CO2 but raises exposure, so it
 * isn't one of them.
 * @type {Partial<Record<CommuteMode, { title: string, how: string }>>}
 */
const TRANSIT_SWAPS = {
  metro: { title: 'Take the metro', how: 'the metro or train' },
  bus: { title: 'Take the bus', how: 'the bus' },
  walk_cycle: { title: 'Walk or cycle it', how: 'walking or cycling' },
};

/**
 * One plan item. `type` is what it reduces.
 * @param {string} title
 * @param {{ action: string, why: string, impact: string, type?: ImpactType, time?: string }} details
 * @returns {PlanItem}
 */
const item = (title, { action, why, impact, type = 'exposure', time }) => ({
  ...(time ? { time } : {}),
  title,
  action,
  why,
  impact,
  impactType: type,
});

/**
 * "a, b and c".
 * @param {string[]} names
 */
const joinNames = (names) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * What today's readings mean for planning, worked out once.
 * @typedef {object} Day
 * @property {string} tz  the place's time zone
 * @property {AirSummary} air
 * @property {boolean} unhealthy  the air now is unhealthy, at least for sensitive groups
 * @property {AqiWindow | null} clean  the cleanest waking stretch
 * @property {AqiWindow | null} worst  the worst stretch
 * @property {AqiWindow | null} airable  the cleanest stretch, when it is good enough to open the windows
 * @property {string} cleanAt  the cleanest stretch as "2 pm–5 pm", or '' without a forecast
 */

/**
 * @param {Place} place
 * @param {AirSummary} air
 * @returns {Day}
 */
function readDay(place, air) {
  const clean = air.windows?.cleanest ?? null;
  return {
    tz: place.tz,
    air,
    unhealthy: air.aqi > UNHEALTHY_ABOVE,
    clean,
    worst: air.windows?.worst ?? null,
    airable: clean && clean.avgAqi <= AIRABLE_MAX ? clean : null,
    cleanAt: clean ? rangeLabel(clean, place.tz) : '',
  };
}

/** @param {Day} day */
function morningItem({ unhealthy, airable, tz }) {
  if (!unhealthy) {
    return item('Air the house', {
      action: 'Open windows on opposite sides for 10–15 minutes.',
      why: 'A cross-breeze flushes out cooking fumes and stale air while the outdoor air is acceptable.',
      impact: 'Lowers the pollution that builds up indoors overnight.',
      time: 'Morning',
    });
  }
  return item('Keep the smog outside', {
    action: `Keep windows and doors shut ${airable ? `until ${hourLabel(airable.start, tz)}` : 'today'}, and dry laundry indoors.`,
    why: 'Outdoor PM2.5 seeps in through open windows and gaps; closing up keeps the cleaner indoor air in.',
    impact: 'Keeps most outdoor PM2.5 out of your rooms.',
    time: 'Morning',
  });
}

/**
 * @param {Day} day
 * @param {ExerciseTime} exercise
 */
function exerciseItem({ unhealthy, airable, cleanAt, air }, exercise) {
  const usual = exercise === 'morning' ? 'Morning' : 'Evening';
  if (!unhealthy) {
    return item('Enjoy your workout', {
      action: 'Exercise outdoors as usual, on paths away from busy roads.',
      why: 'Pollution drops quickly a street or two away from heavy traffic.',
      impact: 'Keeps your exercise dose of exhaust low.',
      time: usual,
    });
  }
  if (airable) {
    return item('Move your workout', {
      action: `Exercise outdoors at ${cleanAt} instead, away from busy roads.`,
      why: EXERCISE_DOSE,
      impact: `The air then averages AQI ${airable.avgAqi}, against ${air.aqi} now.`,
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

/**
 * Air the house in the clean window, or skip it when even that window is too smoggy.
 * @param {AqiWindow} clean
 * @param {string} cleanAt
 */
function ventilationItem(clean, cleanAt) {
  if (clean.avgAqi <= AIRABLE_MAX) {
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

/**
 * @param {AqiWindow} worst
 * @param {string} tz
 * @param {boolean} purifier
 */
function worstHoursItem(worst, tz, purifier) {
  return item('Seal up for the worst hours', {
    action: `Stay in with windows shut from ${hourLabel(worst.start, tz)} to ${hourLabel(worst.end, tz)}${purifier ? ', purifier on high' : ''}.`,
    why: `Smog peaks then, at an average AQI of ${worst.avgAqi}.`,
    impact: "Avoids the day's heaviest exposure.",
    time: rangeLabel(worst, tz),
  });
}

/**
 * @param {CommuteMode} mode
 * @param {boolean} unhealthy
 */
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

/**
 * The day in time order: morning, commute, exercise, the clean window, the worst hours.
 * @param {Day} day
 * @param {Profile} profile
 */
function routineFor(day, profile) {
  const routine = [morningItem(day)];
  if (profile.commute.mode !== 'wfh') routine.push(commuteItem(profile.commute.mode, day.unhealthy));
  if (profile.exercise !== 'none') routine.push(exerciseItem(day, profile.exercise));
  if (day.clean && day.unhealthy) routine.push(ventilationItem(day.clean, day.cleanAt));
  if (day.worst && day.worst.avgAqi > UNHEALTHY_ABOVE)
    routine.push(worstHoursItem(day.worst, day.tz, profile.purifier));
  return routine;
}

/** @param {CookingFuel} cooking */
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

/**
 * @param {Profile} profile
 * @param {string[]} sensitive  who in the household is sensitive, in words
 */
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
 * A commute switch, with its computed savings.
 * @param {CommuteImpact} commute
 * @param {CommuteAlternative} option
 * @param {string} title
 * @param {string} action
 */
function savingItem(commute, option, title, action) {
  return item(title, {
    action,
    why: `Your commute emits about ${commute.current.kgPerWeek} kg CO2e a week; this brings it to ${option.kgPerWeek} kg.`,
    impact: `Saves ${option.savedKgPerWeek} kg a week and ${option.savedKgPerYear} kg a year, what ${option.trees} trees absorb in a year.`,
    type: option.exposure === 'low' ? 'both' : 'emissions',
  });
}

/**
 * The best low-exposure commute switch and the extra home day, with their computed savings, then habits that cut
 * local smog.
 * @param {Profile} profile
 * @param {CommuteImpact} commute
 */
function swapsFor(profile, commute) {
  const swaps = [];
  // Alternatives come sorted by saving, so the first transit switch is the best one.
  const transit = commute.alternatives.find((option) => TRANSIT_SWAPS[option.mode]);
  const wording = transit && TRANSIT_SWAPS[transit.mode];
  if (transit && wording) {
    const action = `Switch to ${wording.how} for your ${profile.commute.km} km commute, even 2–3 days a week.`;
    swaps.push(savingItem(commute, transit, wording.title, action));
  }
  const homeDay = commute.alternatives.find((option) => option.mode === 'wfh');
  if (homeDay) {
    const action = 'Work from home on the smoggiest day of the week.';
    swaps.push(savingItem(commute, homeDay, 'Work from home once more', action));
  }
  if (profile.commute.mode === 'car' || profile.commute.mode === 'two_wheeler') {
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
  return swaps.slice(0, PLAN_ITEMS.swaps.max);
}

/**
 * @param {Day} day
 * @param {string[]} sensitive
 */
function alertsFor({ unhealthy, air }, sensitive) {
  const alerts = [];
  if (unhealthy && sensitive.length > 0) {
    alerts.push(
      `The air is ${air.band.label.toLowerCase()}: keep outdoor time short for ${joinNames(sensitive)}, with a well-fitted N95 outside.`,
    );
  }
  if (air.aqi > SYMPTOMS_ABOVE) {
    alerts.push('Watch for breathlessness, chest pain or dizziness, and contact a doctor if they appear.');
  }
  return alerts;
}

/**
 * @param {Day} day
 * @param {Place} place
 */
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

/**
 * Deterministic plan from the same inputs Gemini gets. English only; used when Gemini is unavailable.
 * @param {PlanContext} context
 * @returns {Plan}
 */
export function rulesPlan({ place, air, profile, commute }) {
  const day = readDay(place, air);
  const sensitive = profile.household.map((member) => WHO_FOR[member]);
  return {
    summary: summaryFor(day, place),
    alerts: alertsFor(day, sensitive),
    routine: routineFor(day, profile),
    indoor: indoorFor(profile, sensitive),
    swaps: swapsFor(profile, commute),
  };
}

// The shapes that travel between modules, written once as JSDoc types. `npm run typecheck` checks every module
// against them with the TypeScript compiler. This file has no runtime code.
/** @import { HOUSEHOLD, EXERCISE, COOKING, LANGUAGES } from './profile.js' */
/** @import { MODES } from './impact.js' */
/** @import { ThinkingLevel } from '@google/genai' */

// The household

/**
 * Where a reading or a plan is for.
 * @typedef {object} Place
 * @property {number} lat  latitude, rounded to about 1 km
 * @property {number} lon  longitude, rounded to about 1 km
 * @property {string} tz  IANA time zone, such as "Asia/Kolkata"
 * @property {string} name  display name
 */

/** @typedef {keyof typeof HOUSEHOLD} HouseholdMember */
/** @typedef {keyof typeof MODES} CommuteMode */
/** @typedef {keyof typeof EXERCISE} ExerciseTime */
/** @typedef {keyof typeof COOKING} CookingFuel */
/** @typedef {keyof typeof LANGUAGES} Language */
/** @typedef {'low' | 'medium' | 'high'} Exposure  how much traffic smog a commuter breathes */

/**
 * A household profile, as validated by readProfile().
 * @typedef {object} Profile
 * @property {HouseholdMember[]} household  sensitive groups living there
 * @property {{ mode: CommuteMode, km: number, days: number }} commute  one-way distance and days a week
 * @property {ExerciseTime} exercise
 * @property {boolean} purifier
 * @property {CookingFuel} cooking
 * @property {string} notes  free text, already cleaned
 * @property {Language} language  language of the plan and answers
 */

// Air quality

/** @typedef {{ key: string, label: string }} Band  an AQI band: a key for styling and a label for people */

/**
 * @typedef {object} Pollutant
 * @property {string} code  such as "pm25"
 * @property {string} name  such as "PM2.5"
 * @property {number} value
 * @property {string} units  "µg/m³" or "ppb"
 */

/** @typedef {{ name: string, aqi: number, category: string }} LocalIndex  an official national index */
/** @typedef {Record<string, string>} HealthAdvice  the provider's advice per population group */

/**
 * One provider's reading, before it is put on the common scale.
 * @typedef {object} AirReading
 * @property {string} source
 * @property {string} updated  ISO time of the reading
 * @property {number} pm25  µg/m³
 * @property {Pollutant[]} pollutants
 * @property {string | null} dominant
 * @property {LocalIndex | null} localIndex
 * @property {HealthAdvice | null} health
 * @property {{ time: string, pm25: number | undefined }[]} hourly
 */

/** @typedef {{ time: string, aqi: number, band: Band }} HourlyAqi */
/** @typedef {{ start: string, end: string, avgAqi: number, band: Band }} AqiWindow  a stretch of forecast hours */
/** @typedef {{ cleanest: AqiWindow, worst: AqiWindow }} ForecastWindows */

/**
 * A reading on the US EPA scale with its forecast windows: what the page and the prompts use.
 * @typedef {Omit<AirReading, 'hourly'> & {
 *   aqi: number,
 *   band: Band,
 *   whoMultiple: number,
 *   hourly: HourlyAqi[],
 *   windows: ForecastWindows | null,
 * }} AirSummary
 */

// Commute impact

/**
 * @typedef {object} CommuteOption
 * @property {CommuteMode} mode
 * @property {string} label
 * @property {number} kgPerWeek  kg CO2e a week
 * @property {Exposure} exposure
 */
/** @typedef {CommuteOption & { weeklyKm: number }} CurrentCommute */
/** @typedef {CommuteOption & { savedKgPerWeek: number, savedKgPerYear: number, trees: number }} CommuteAlternative */
/** @typedef {{ current: CurrentCommute, alternatives: CommuteAlternative[] }} CommuteImpact */

// Plans

/** @typedef {'exposure' | 'emissions' | 'both'} ImpactType  what an action reduces */

/**
 * @typedef {object} PlanItem
 * @property {string} [time]  routine items only
 * @property {string} title
 * @property {string} action  exactly what to do
 * @property {string} why  how it works
 * @property {string} impact  the effect, in one sentence
 * @property {ImpactType} impactType
 */

/**
 * @typedef {object} Plan
 * @property {string} summary
 * @property {string[]} alerts  urgent warnings for sensitive people
 * @property {PlanItem[]} routine  the day in time order
 * @property {PlanItem[]} indoor  indoor air hacks
 * @property {PlanItem[]} swaps  changes that cut the household's own emissions
 */

/** @typedef {{ place: Place, air: AirSummary, profile: Profile, commute: CommuteImpact }} PlanContext */

/**
 * What /api/plan returns besides the place: Gemini's plan with its model, or the built-in plan.
 * @typedef {{ air: AirSummary, commute: CommuteImpact } & (
 *   { source: 'gemini', model: string, plan: Plan } | { source: 'rules', plan: Plan }
 * )} PlanResult
 */

// Services

/** @typedef {'INFO' | 'WARNING' | 'ERROR'} Severity */
/** @typedef {(severity: Severity, message: string, fields?: object) => void} Logger */

/**
 * @typedef {object} AirService
 * @property {(place: Place) => Promise<AirSummary>} lookup  current air and the next 24 hours
 * @property {(query: string) => Promise<Place>} geocode  finds a city or area by name
 * @property {string} source  the primary data source
 */

/**
 * @typedef {object} GeminiService
 * @property {boolean} enabled
 * @property {string[]} models  model IDs, tried in order
 * @property {(context: PlanContext) => Promise<{ plan: Plan, model: string }>} plan
 * @property {(context: PlanContext, question: string) => Promise<{ answer: string, model: string }>} ask
 */

/**
 * @typedef {object} Planner
 * @property {(place: Place, profile: Profile) => Promise<PlanResult>} plan  Gemini's plan, or the built-in one
 * @property {(place: Place, profile: Profile, question: string) => Promise<{ answer: string, model: string }>} ask
 */

/**
 * The part of the GoogleGenAI client that AirWise uses, so tests can stand in for it.
 * @typedef {{ models: { generateContent(request: object): Promise<{ text?: string }> } }} GeminiClient
 */

/**
 * @typedef {object} GeminiOptions
 * @property {string[]} models  model IDs, fastest first
 * @property {number} timeoutMs  longest wait for one model
 * @property {number} budgetMs  longest wait for an answer from any model
 * @property {Logger} log
 * @property {() => number} now
 */

/** @typedef {{ contents: string, config: object, thinkingLevel: ThinkingLevel }} GenerateRequest */

export {};

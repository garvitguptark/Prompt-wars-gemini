// "Ask AirWise": follow-up questions answered by Gemini from the same live readings.
/** @import { Place, Profile } from '../src/types.js' */
import { byId, h, api, loadingLine } from './dom.js';

/** Shortest question the server accepts. */
const MIN_QUESTION_CHARS = 3;

const SUGGESTIONS = [
  'Is it safe for the kids to play outside today?',
  'Which mask should we buy, and how should it fit?',
  'How do I pick an air purifier for one room?',
];

/** Shows the ask box with suggested questions. */
export function showAsk() {
  byId('suggest').replaceChildren(
    ...SUGGESTIONS.map((q) =>
      h('button', {
        type: 'button',
        text: q,
        onclick: () => {
          byId('question', HTMLInputElement).value = q;
          byId('ask-form', HTMLFormElement).requestSubmit();
        },
      }),
    ),
  );
  byId('answer').replaceChildren();
  byId('ask').hidden = false;
}

/**
 * Wires the ask form.
 * @param {() => { place: Place | null, profile: Profile | null }} context  what the current plan was made for
 */
export function initAsk(context) {
  byId('ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const { place, profile } = context();
    if (!place || !profile) return; // the ask box only shows once there is a plan
    const question = byId('question', HTMLInputElement).value.trim();
    const answer = byId('answer');
    if (question.length < MIN_QUESTION_CHARS) {
      answer.replaceChildren(h('p', { class: 'error', text: 'Type a question first.' }));
      byId('question').focus();
      return;
    }
    const button = byId('ask-submit', HTMLButtonElement);
    button.disabled = true;
    answer.setAttribute('aria-busy', 'true');
    answer.replaceChildren(loadingLine('Thinking…'));
    try {
      const result = await api('/api/ask', { place, profile, question });
      answer.replaceChildren(
        h('p', { lang: profile.language, dir: profile.language === 'ur' ? 'rtl' : 'ltr', text: result.answer }),
        h('p', { class: 'by by-gemini', text: `Answered by Gemini (${result.model})` }),
      );
    } catch (err) {
      answer.replaceChildren(h('p', { class: 'error', text: /** @type {Error} */ (err).message }));
    } finally {
      button.disabled = false;
      answer.setAttribute('aria-busy', 'false');
    }
  });
}

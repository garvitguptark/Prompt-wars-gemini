// "Ask AirWise": follow-up questions answered by Gemini from the same live readings.
import { $, h, api, loadingLine } from './dom.js';

const SUGGESTIONS = [
  'Is it safe for the kids to play outside today?',
  'Which mask should we buy, and how should it fit?',
  'How do I pick an air purifier for one room?',
];

/** Shows the ask box with suggested questions. */
export function showAsk() {
  $('suggest').replaceChildren(
    ...SUGGESTIONS.map((q) =>
      h('button', {
        type: 'button',
        text: q,
        onclick: () => {
          $('question').value = q;
          $('ask-form').requestSubmit();
        },
      }),
    ),
  );
  $('answer').replaceChildren();
  $('ask').hidden = false;
}

/** Wires the ask form. `context()` returns the { place, profile } the current plan was made for. */
export function initAsk(context) {
  $('ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = $('question').value.trim();
    const answer = $('answer');
    if (question.length < 3) {
      answer.replaceChildren(h('p', { class: 'error', text: 'Type a question first.' }));
      $('question').focus();
      return;
    }
    const button = $('ask-submit');
    button.disabled = true;
    answer.setAttribute('aria-busy', 'true');
    answer.replaceChildren(loadingLine('Thinking…'));
    try {
      const { place, profile } = context();
      const result = await api('/api/ask', { place, profile, question });
      answer.replaceChildren(
        h('p', { lang: profile.language, dir: profile.language === 'ur' ? 'rtl' : 'ltr', text: result.answer }),
        h('p', { class: 'by by-gemini', text: `Answered by Gemini (${result.model})` }),
      );
    } catch (err) {
      answer.replaceChildren(h('p', { class: 'error', text: err.message }));
    } finally {
      button.disabled = false;
      answer.setAttribute('aria-busy', 'false');
    }
  });
}

// One roll on the original "No" answer; follow-ups never roll recursively.
// Small authored bank, no generated text, network requests or per-frame work.
export const MANAGER_SURVEY_CHANCE = 0.8;
export const MANAGER_FEEDBACK_QUESTIONS = Object.freeze([
  { text: 'What would make our aisles easier to shop?', choices: ['Clearer signs', 'More room for carts', 'Fewer surprise obstacles'] },
  { text: 'How could we improve the shelves?', choices: ['More readable price tags', 'Better-stocked shelves', 'Less mysterious organization'] },
  { text: 'What should we improve at checkout?', choices: ['Shorter queues', 'Friendlier service', 'Fewer unexpected charges'] },
  { text: 'Which part of the store needs the most attention?', choices: ['Cleanliness', 'Product quality', 'The manager himself'] },
  { text: 'What would make your next visit more pleasant?', choices: ['Quieter shopping', 'Better deals', 'Fewer customer surveys'] },
  { text: 'What should we improve about our cold section?', choices: ['Easier freezer doors', 'More frozen choices', 'Less questionable refrigeration'] }
]);

export function rollManagerSurvey(random = Math.random) {
  if (random() >= MANAGER_SURVEY_CHANCE) return null;
  const count = Math.min(3, 1 + Math.floor(random() * 3));
  const pool = [...MANAGER_FEEDBACK_QUESTIONS];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    questions.push(pool.splice(index, 1)[0]);
  }
  return { questions, index: 0 };
}

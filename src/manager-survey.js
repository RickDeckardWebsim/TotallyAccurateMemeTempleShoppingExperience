// One roll on the original "No" answer; follow-ups never roll recursively.
// Small authored bank, no generated text, network requests or per-frame work.
export const MANAGER_SURVEY_CHANCE = 0.8;
export const MANAGER_FEEDBACK_QUESTIONS = Object.freeze([
  { text: 'Two carts keep getting stuck side by side because boxes are blocking the aisle. What should we fix first?',
    choices: ['Clear the boxes out of the aisle', 'Put up a bigger aisle sign', 'Add another display in the aisle'],
    correctReply: 'Exactly. Clear the blockage. You were actually listening.',
    wrongReply: 'The aisle is blocked. A bigger sign or another display will not give those carts room.' },
  { text: 'The shelf still shows yesterday\'s sale price, but checkout charges today\'s price. How do we stop confusing shoppers?',
    choices: ['Make the shelf label match the checkout price', 'Leave the cheaper label to attract shoppers', 'Make the old price label larger'],
    correctReply: 'Matching prices. Good. That is how we avoid an argument at checkout.',
    wrongReply: 'I asked for matching prices, not a more convincing wrong price.' },
  { text: 'There is a spill in a busy aisle, and people are slipping. What is the safe first response?',
    choices: ['Block off the spill, then clean it up', 'Mop around shoppers without warning them', 'Move the warning sign to an empty aisle'],
    correctReply: 'Protect the shoppers, then clean it. Sensible. I can work with that.',
    wrongReply: 'People are already slipping. Keep them away from the spill before cleaning it.' },
  { text: 'One cashier is working flat out while customers wait in a long queue. Which change would directly shorten that queue?',
    choices: ['Open another staffed checkout', 'Print larger price tags', 'Give the same cashier more paperwork'],
    correctReply: 'Another staffed checkout. Thank you for answering the problem I described.',
    wrongReply: 'That does not add a cashier. The queue needs another staffed checkout.' },
  { text: 'Shoppers say the music is so loud they cannot hear the cashier. What should we adjust first?',
    choices: ['Turn the store music down', 'Move the aisle signs', 'Play the announcements even louder'],
    correctReply: 'Lower the music. See? We can have a productive conversation.',
    wrongReply: 'The problem is the music volume. Do not drown the cashier out even more.' },
  { text: 'A freezer door will not close properly, and cold air is escaping. What should we repair first?',
    choices: ['Repair the door seal so it closes', 'Put more products in front of the door', 'Change the freezer price labels'],
    correctReply: 'Fix the door seal. Cold air should stay inside the freezer. Good.',
    wrongReply: 'I said the door will not close. Stock and price labels will not fix that seal.' }
]);

export function rollManagerSurvey(random = Math.random) {
  if (random() >= MANAGER_SURVEY_CHANCE) return null;
  const count = Math.min(3, 1 + Math.floor(random() * 3));
  const pool = [...MANAGER_FEEDBACK_QUESTIONS];
  const questions = [];
  for (let i = 0; i < count; i++) {
    const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    const question = pool.splice(index, 1)[0];
    const choices = question.choices.map((text, choiceIndex) => ({ text, correct: choiceIndex === 0 }));
    // No fixed correct button: reading, not memorizing a screen position, matters.
    for (let j = choices.length - 1; j > 0; j--) {
      const k = Math.min(j, Math.floor(random() * (j + 1)));
      [choices[j], choices[k]] = [choices[k], choices[j]];
    }
    questions.push({ ...question, choices });
  }
  return { questions, index: 0, correctAnswers: 0, wrongAnswers: 0, awaitingContinue: false };
}

export function getManagerFeedbackPenalty(correctAnswers = 0, wrongAnswers = 0) {
  const correct = Math.max(0, Math.min(3, Number.isFinite(correctAnswers) ? correctAnswers : 0));
  const wrong = Math.max(0, Math.min(3, Number.isFinite(wrongAnswers) ? wrongAnswers : 0));
  const anger = wrong / Math.max(1, correct + wrong);
  return { anger, speedMultiplier: 0.5 - anger * 0.25, durationMs: Math.round(5000 + anger * 5000),
    mood: anger === 0 ? 'Displeased' : anger < 0.5 ? 'Irritated' : anger < 1 ? 'Angry' : 'Furious' };
}

export function answerManagerSurvey(survey, choiceIndex) {
  if (!survey || survey.awaitingContinue || !Number.isInteger(choiceIndex)) return null;
  const question = survey.questions[survey.index], choice = question?.choices[choiceIndex];
  if (!choice) return null;
  if (choice.correct) survey.correctAnswers += 1;
  else survey.wrongAnswers += 1;
  survey.awaitingContinue = true;
  return { correct: choice.correct, reply: choice.correct ? question.correctReply : question.wrongReply,
    ...getManagerFeedbackPenalty(survey.correctAnswers, survey.wrongAnswers) };
}

export function advanceManagerSurvey(survey) {
  if (!survey?.awaitingContinue) return false;
  survey.awaitingContinue = false;
  survey.index += 1;
  return survey.index < survey.questions.length;
}

import { coordinatorPrompt } from './coordinator.js';
import { characterPrompt, commandHelpPrompt, continuityPrompt, evolutionPrompt, proposalPrompts, readerPrompt, reviewFormatPrompt, stylistPrompt, themePrompt, writerPrompt, writerScopePrompts } from './specialists.js';
import { companionCommonPrompt, companionIntensityPrompts, companionModePrompts } from './companion.js';
import { digestPrompt, mergePrompt, rollupPrompts } from './story-memory.js';
import { learnPrompt } from './style-learning.js';
import { judgePrompt } from './eval.js';
import { promptVersion, type Prompt } from './prompt.js';

export { prompt, promptVersion, type Prompt } from './prompt.js';

/** Every model prompt the app sends, plus the benchmark judge, for the benchmark report and for comparing two builds. */
export const PROMPTS: readonly Prompt[] = [
  coordinatorPrompt,
  characterPrompt, readerPrompt, evolutionPrompt, themePrompt, stylistPrompt, continuityPrompt, reviewFormatPrompt, writerPrompt, ...Object.values(writerScopePrompts),
  ...Object.values(proposalPrompts), commandHelpPrompt,
  companionCommonPrompt, ...Object.values(companionModePrompts), ...Object.values(companionIntensityPrompts),
  digestPrompt, mergePrompt, ...Object.values(rollupPrompts),
  learnPrompt,
  judgePrompt,
];
/** One version for the whole prompt set. */
export const PROMPT_SET_VERSION = promptVersion(PROMPTS.map(item => `${item.id}@${item.version}`).join('\n'));

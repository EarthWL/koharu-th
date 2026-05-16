/**
 * Slash-command expansion for the AI Chat input. A slash command is
 * syntactic sugar — we expand the user's `/foo bar` into a longer
 * prompt that nudges the assistant toward using the right tools.
 *
 * Each command returns `{ display, prompt }`:
 *   - `display` is what the user sees pinned to their message
 *   - `prompt` is what the assistant actually receives
 */

export type SlashCommand = {
  /** Without the leading slash. */
  name: string
  /** Args spec shown in autocomplete (e.g. "<url>", "[chapter_id]"). */
  argsHint?: string
  /** One-line help text in the picker. */
  description: string
  /** Build the prompt from the typed arg string (may be empty). */
  build: (args: string) => { display: string; prompt: string }
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'draft-synopsis',
    description:
      'Ask the AI to draft a 2-3 sentence series synopsis from what it already knows + project data.',
    build: (extra) => ({
      display: '/draft-synopsis ' + extra,
      prompt: [
        'Draft a 2-3 sentence synopsis for this manga in Thai, suitable for the translate prompt context.',
        'First call series_meta_get and characters_list to see what we already have, then propose a synopsis.',
        'When the user approves, call series_meta_update with `synopsis` set.',
        extra ? `\nExtra notes from user: ${extra}` : '',
      ].join('\n'),
    }),
  },
  {
    name: 'draft-style-notes',
    description:
      'Brainstorm style notes (tone, register, formality, sound-effect handling) tailored to this series.',
    build: (extra) => ({
      display: '/draft-style-notes ' + extra,
      prompt: [
        'Help me write `styleNotes` for the translate prompt of this series.',
        'Call series_meta_get + characters_list first. Then propose a concrete styleNotes string covering:',
        '- Overall tone (serious / comedic / mixed)',
        '- Formality default and per-character exceptions',
        '- How to handle SFX and onomatopoeia in Thai',
        '- Honorific handling (keep / convert / drop)',
        'Once I approve, call series_meta_update to save.',
        extra ? `\nExtra hints: ${extra}` : '',
      ].join('\n'),
    }),
  },
  {
    name: 'suggest-character',
    argsHint: '<name>',
    description:
      'Help fill in a character profile (Thai name, speech style, role) given the source-language name.',
    build: (arg) => ({
      display: `/suggest-character ${arg}`,
      prompt: [
        `Help me set up the character "${arg || '(unspecified)'}".`,
        'Call characters_list to check if they already exist.',
        'If not, propose: translatedName (Thai), aliases, role, speechStyle. Confirm with me, then call character_add (isMain=true if they\'re a main cast member).',
      ].join('\n'),
    }),
  },
  {
    name: 'extract-glossary',
    argsHint: '<paste source text>',
    description:
      'Extract candidate glossary terms (names, places, skills, organisations) from a chunk of source text.',
    build: (text) => ({
      display: `/extract-glossary (${text.length} chars)`,
      prompt: [
        'Extract glossary candidates from the following source text.',
        'Call glossary_list first to avoid proposing duplicates.',
        'For each new term: assign category (character/place/term/skill/honorific/item/org/sfx), propose a Thai translation, and a short contextNote.',
        'List proposals as a markdown table first, get my approval, then call glossary_bulk_add.',
        '',
        '--- source text ---',
        text,
      ].join('\n'),
    }),
  },
  {
    name: 'summarize-chapter',
    argsHint: '[chapter_id]',
    description: 'Summarise a chapter and offer to write it into chapters.summary.',
    build: (arg) => ({
      display: `/summarize-chapter ${arg}`,
      prompt: [
        arg
          ? `Summarise chapter id ${arg}.`
          : 'Summarise the currently-active chapter.',
        'Call chapters_list to find it, then read any text blocks I\'ve translated.',
        'Produce a 2-4 sentence summary in Thai (this feeds the rolling-context for future translations).',
        'On my approval, call chapter_update with `summary` set.',
      ].join('\n'),
    }),
  },
  {
    name: 'preview-prompt',
    argsHint: '<source text>',
    description:
      'Render the actual translate prompt for a source string so you can see what context the LLM will see.',
    build: (text) => ({
      display: `/preview-prompt (${text.length} chars)`,
      prompt: [
        `Call prompt_render with useCase="translate" and sourceText=${JSON.stringify(text)}.`,
        'Then show me the rendered prompt verbatim in a code block, and highlight: what synopsis/character/glossary entries got injected, and whether rolling_summary was populated.',
      ].join('\n'),
    }),
  },
  {
    name: 'fetch-wiki',
    argsHint: '<url>',
    description:
      'Fetch a wiki/fandom page and summarise into project metadata + characters + glossary.',
    build: (url) => ({
      display: `/fetch-wiki ${url}`,
      prompt: [
        `Call web_fetch_url with url=${JSON.stringify(url)} to pull the page.`,
        'Then:',
        '1. Propose updates to series_meta (synopsis, genre, tone) — show as a diff first.',
        '2. List main characters found on the page with proposed Thai names + speech styles — show as a table.',
        '3. List glossary candidates (places, skills, organisations) — show as a table.',
        'Wait for my approval on each section before calling series_meta_update / character_add / glossary_bulk_add.',
      ].join('\n'),
    }),
  },
]

/** Parse `/cmd args` from the input. Returns `null` if input isn't a
 *  recognised slash command. */
export function expandSlash(input: string): {
  display: string
  prompt: string
} | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const space = trimmed.indexOf(' ')
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase()
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim()
  const cmd = SLASH_COMMANDS.find((c) => c.name === name)
  if (!cmd) return null
  return cmd.build(args)
}

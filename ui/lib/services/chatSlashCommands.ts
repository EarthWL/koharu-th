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
    name: 'tm-semantic',
    argsHint: '<source text>',
    description:
      'Semantic TM lookup — find paraphrases / similar sentences already translated (beyond exact / Jaccard match).',
    build: (text) => ({
      display: `/tm-semantic ${text}`,
      prompt: [
        text
          ? `Call tm_lookup_semantic with sourceText=${JSON.stringify(text)}, topK=8 to find semantically-similar TM entries.`
          : 'I forgot the source text — ask me what to look up.',
        'Present results as a markdown table: similarity · source · cached target · chapter (if known).',
        'If nothing crosses min_similarity, suggest I lower the threshold or run the embedding backfill first.',
      ].join('\n'),
    }),
  },
  {
    name: 'check-thai',
    description:
      'Review Thai translations on the open chapter for spelling, grammar, naturalness, and propose fixes.',
    build: (extra) => ({
      display: `/check-thai ${extra}`,
      prompt: [
        'Review the Thai translations in the currently-open chapter for:',
        '- Spelling errors (สะกดผิด)',
        '- Grammar / particle misuse (ผิดไวยากรณ์)',
        '- Naturalness (ฟังดูไม่เป็นธรรมชาติ)',
        '- Consistency in tone (โทนไม่สม่ำเสมอ)',
        '',
        'Steps:',
        '1. Call qc_chapter_consistency to also surface glossary mismatches.',
        '2. Walk through each translated block and flag the issues above.',
        '3. Present a markdown table: page · block · original Thai · proposed Thai · issue type.',
        '4. On my approval, call update_text_block one at a time to apply each fix.',
        extra ? `\nExtra context: ${extra}` : '',
      ].join('\n'),
    }),
  },
  {
    name: 'qc-consistency',
    description:
      'Scan the open chapter for glossary / character name mismatches and propose fixes.',
    build: (extra) => ({
      display: `/qc-consistency ${extra}`,
      prompt: [
        'Call qc_chapter_consistency on the currently-open chapter.',
        'Then:',
        '1. Summarise the report (how many blocks scanned, how many mismatches).',
        '2. Group mismatches by term and present as a markdown table (page · block · source term · expected target · what the translator wrote).',
        '3. For each group, suggest one of:',
        '   - rewrite the block to use the expected target (call update_text_block — wait for approval)',
        '   - update the glossary entry to a new canonical form (call glossary_update — wait for approval)',
        '   - leave as-is if the variation is intentional',
        extra ? `\nExtra hint from user: ${extra}` : '',
      ].join('\n'),
    }),
  },
  {
    name: 'translate-page',
    description:
      'Translate every detected text block on the current page and apply the result via update_text_block per block (no markdown table).',
    build: (extra) => ({
      display: `/translate-page ${extra}`.trim(),
      prompt: [
        'Translate every detected text_block on the currently-open page',
        'and APPLY each translation via the `update_text_block` tool — one',
        'call per block. Do NOT reply with a markdown table; the goal is',
        'to mutate the document so the canvas renders the translated text.',
        '',
        'Steps:',
        '1. Call `get_text_blocks` to read the open page and get the full',
        '   block list (index + bbox + sourceText + existing translation).',
        '2. Use the page image already attached to this message PLUS each',
        '   block\'s OCR `text` (if populated) to translate into the target',
        '   language. Respect project context: call `series_meta_get` once',
        '   for tone/style, `characters_list` for canonical Thai names,',
        '   `glossary_list` for term mappings. Read these before translating.',
        '3. For each text_block (by its 0-based array index), call',
        '   `update_text_block` with `textBlockIndex` set to that index and',
        '   `translation` set to the Thai text. Make the calls sequentially',
        '   so each lands in order; do not batch into one giant payload.',
        '4. After all blocks are updated, reply with a SHORT summary',
        '   (e.g. "Translated N blocks; applied 1-N via update_text_block").',
        '   Skip the markdown table — the user will see the translations on',
        '   the canvas after the next render.',
        '',
        'If a block already has a non-empty `translation`, treat it as the',
        'translator\'s prior choice and keep it unless the user explicitly',
        'asked to overwrite — surface those as "kept as-is (N blocks)" in',
        'the final summary.',
        extra ? `\nExtra context from user: ${extra}` : '',
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

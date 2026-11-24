import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEED_POSITION BACKFILL, READ AGAINST THE SEED FILES IT COPIES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 20260930153606_add_questions_seed_position carries the catalogue's written
 * order as two lists of about 2.5k rows, because the database cannot recover
 * it: the seeded ids are random v4 and a seed batch shares one created_at. Lists
 * that long cannot be reviewed by eye, so this re-derives them from the seed
 * migrations themselves and fails on any row that differs — a question dropped,
 * reordered, renumbered, or a seed migration missing from the list.
 */

const MIGRATIONS = path.resolve(__dirname, '../../../../db/postgres/migrations');
const BACKFILL = '20260930153606_add_questions_seed_position';

/**
 * Every migration before the backfill that seeds catalogue questions, in the
 * order they run. `id`: the seed pinned its ids, and the backfill matches by
 * id. `text`: the default minted them, and the backfill matches by text.
 */
const SEEDS = [
  { file: '20251214231106_seed_questions', matchedBy: 'id' },
  { file: '20260730054500_seed_interview_questions', matchedBy: 'id' },
  { file: '20260817220000_thicker_daily_metrics_and_home_question', matchedBy: 'id' },
  { file: '20260818235602_reflections_functional_catalog', matchedBy: 'text' },
  { file: '20260824083722_seed_life_details_questions', matchedBy: 'text' },
  { file: '20260824232133_seed_life_details_stable_ids', matchedBy: 'id' },
  { file: '20260824233929_expand_reflections_catalogue', matchedBy: 'text' },
] as const;

/**
 * Inserts into ci.questions, but lists no position of its own: it only inserts
 * a curated question whose key no shared row holds, and every text it can
 * insert is one a `text` seed lists — checked below.
 */
const LIFE_DETAILS_KEYS = '20260824234643_seed_life_details_question_keys';

function upSection(name: string): string {
  return readFileSync(path.join(MIGRATIONS, `${name}.sql`), 'utf8').split('-- migrate:down')[0];
}

function decode(expression: string): string {
  return /^'(?:[^']|'')*'$/.test(expression) ? expression.slice(1, -1).replaceAll("''", "'") : expression;
}

/**
 * The rows of the first `INSERT INTO <table> … VALUES` list in a migration's up
 * section, one entry per top-level expression, string literals decoded.
 * Quote-aware, so a comma or parenthesis inside a question cannot split a row.
 */
function valuesRows(name: string, table: string): string[][] {
  const up = upSection(name);
  const tablePattern = table.replace('.', String.raw`\.`);
  const insert = new RegExp(String.raw`INSERT\s+INTO\s+${tablePattern}\b`, 'i').exec(up);

  if (insert == null) {
    throw new Error(`${name}: no INSERT INTO ${table}`);
  }

  const values = /\bVALUES\b/gi;
  values.lastIndex = insert.index;

  if (values.exec(up) == null) {
    throw new Error(`${name}: no VALUES after INSERT INTO ${table}`);
  }

  const rows: string[][] = [];
  let i = values.lastIndex;

  const skipBlank = (): void => {
    while (i < up.length) {
      if (/\s/.test(up[i])) {
        i += 1;
      } else if (up.startsWith('--', i)) {
        i = up.indexOf('\n', i) + 1;
      } else {
        return;
      }
    }
  };

  for (;;) {
    skipBlank();

    if (up[i] !== '(') {
      return rows;
    }

    const row: string[] = [];
    let expression = '';
    let depth = 0;

    for (;;) {
      const c = up[i];

      if (c === "'") {
        let close = i + 1;

        while (!(up[close] === "'" && up[close + 1] !== "'")) {
          close += up[close] === "'" ? 2 : 1;
        }

        expression += up.slice(i, close + 1);
        i = close + 1;
        continue;
      }

      if (up.startsWith('--', i)) {
        i = up.indexOf('\n', i);
        continue;
      }

      i += 1;

      if (c === '(' && depth++ === 0) {
        continue;
      }

      if (c === ')' && --depth === 0) {
        break;
      }

      if (c === ',' && depth === 1) {
        row.push(decode(expression.trim()));
        expression = '';
        continue;
      }

      expression += c;
    }

    row.push(decode(expression.trim()));
    rows.push(row);
    skipBlank();

    if (up[i] !== ',') {
      return rows;
    }

    i += 1;
  }
}

/** [position, id or text] per seeded row, numbered across all the seeds. */
function seededRows(): Record<'id' | 'text', Array<[number, string]>> {
  const rows: Record<'id' | 'text', Array<[number, string]>> = { id: [], text: [] };
  let position = 0;

  for (const seed of SEEDS) {
    for (const [first] of valuesRows(seed.file, 'ci.questions')) {
      position += 1;
      rows[seed.matchedBy].push([position, first]);
    }
  }

  return rows;
}

function backfillRows(table: '_seeded_by_id' | '_seeded_by_text'): Array<[number, string]> {
  return valuesRows(BACKFILL, table).map(([position, value]) => [Number(position), value]);
}

function insertsQuestions(name: string): boolean {
  return /INSERT\s+INTO\s+(ci\.)?questions\b/i.test(upSection(name));
}

function migrationNames(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.replace(/\.sql$/, ''))
    .sort();
}

const normalised = (text: string): string => text.trim().toLowerCase();

describe(`${BACKFILL}`, () => {
  it('copies every seeded row in written order, numbered across all the seeds', () => {
    const seeded = seededRows();

    // Guard the parser before trusting a comparison built on it.
    expect(seeded.id.length + seeded.text.length).toBe(2542);
    expect(seeded.id[0]).toEqual([1, 'd53229b9-0fa0-487b-b494-d65c42a4e1ae']);
    expect(seeded.text[0]).toEqual([711, 'What is your blood type?']);

    expect(backfillRows('_seeded_by_id')).toEqual(seeded.id);
    expect(backfillRows('_seeded_by_text')).toEqual(seeded.text);
  });

  it('accounts for every earlier migration that inserts into ci.questions', () => {
    const earlier = migrationNames().filter((name) => name < BACKFILL && insertsQuestions(name));

    expect(earlier).toEqual([...SEEDS.map((seed) => seed.file), LIFE_DETAILS_KEYS].sort());
  });

  it('can place any question the Life details key seed inserts, by its text', () => {
    const listed = new Set(seededRows().text.map(([, text]) => normalised(text)));
    const curated = valuesRows(LIFE_DETAILS_KEYS, '_curated_life_details').map((row) => row[1]);

    expect(curated).toHaveLength(29);
    expect(curated.filter((text) => !listed.has(normalised(text)))).toEqual([]);
  });

  it('leaves a later seed to write seed_position itself', () => {
    // Nothing backfills a seed that runs after this migration. One that
    // inserts questions without a position still rotates the same way on
    // every appliance — by text within its batch — but not in written order.
    const unpositioned = migrationNames().filter(
      (name) => name > BACKFILL && insertsQuestions(name) && !/\bseed_position\b/.test(upSection(name)),
    );

    expect(unpositioned).toEqual([]);
  });
});

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Textarea } from '@ci/shadcn';
import { Loader2, Sparkles } from '@ci/shadcn/icons';

import {
  fetchAboutYou,
  submitAboutYouCorrection,
  usePersonaCompose,
  type AboutYouView,
} from '@/api/usePersonaCompose';
import { HowYoudDoItCard } from '@/components/HowYoudDoItCard';
import { Markdown } from '@/components/Markdown';
import { useAuth } from '@/hooks';
import { humanizeEnum } from '@/lib/utils';

import {
  SettingsCard,
  SettingsFooter,
  SettingsGroup,
  SettingsLoading,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../kit';

/** Keys onboarding's TimeAndPlaceStep writes onto `properties.schedule`. */
const SCHEDULE_FIELDS: Array<[string, string]> = [
  ['wake_time', 'Wakes at'],
  ['sleep_time', 'Sleeps at'],
  ['work_start', 'Work starts'],
  ['work_end', 'Work ends'],
];

const TRUST_MODE_LABELS: Record<string, string> = {
  cautious: 'Cautious — asks before acting',
  balanced: 'Balanced',
  hands_off: 'Hands-off — acts on its own',
};

/**
 * What a family member is to you, in a word: "sibling", "parent", "child".
 *
 * The graph type alone can't say: PARENT_OF names your parent when it points
 * at you and your child when it points away, so `direction` decides. A type
 * this does not know falls back to its readable form rather than the raw enum.
 */
export function familyRoleLabel(member: AboutYouView['family'][number]): string {
  switch (member.relationship) {
    case 'SPOUSE':
      return 'spouse';
    case 'SIBLING_OF':
      return 'sibling';
    case 'PARENT_OF':
      if (member.direction) {
        return member.direction === 'incoming' ? 'parent' : 'child';
      }

      break;
    case 'CHILD_OF':
      if (member.direction) {
        return member.direction === 'incoming' ? 'child' : 'parent';
      }

      break;
  }

  return humanizeEnum(member.relationship)?.toLowerCase() ?? member.relationship;
}

interface AboutYouSectionProps {
  /**
   * The page changes this when an answer listed below ("Recent answers") has
   * been written elsewhere on it — Life details saving or editing one. A new
   * value refetches the profile in place; without it the list kept showing the
   * old words until the page was reloaded.
   */
  refreshToken?: number;
}

export function AboutYouSection({ refreshToken = 0 }: AboutYouSectionProps) {
  const [{ authToken }] = useAuth();
  const [view, setView] = useState<AboutYouView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [correction, setCorrection] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [task, setTask] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  // The follow-up the correction box is currently answering, if any.
  const [answering, setAnswering] = useState<string | null>(null);
  const correctionRef = useRef<HTMLTextAreaElement>(null);
  const [{ loading: composing, error: composeError, result: composed }, { compose, apply, clear }] =
    usePersonaCompose();

  // The newest load: a slow refresh that started before a later one must not land on top of it.
  const latestLoad = useRef(0);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      const current = ++latestLoad.current;

      // `loading` swaps the whole section for "Loading…". That is right for the
      // first load and wrong for a refresh: it collapsed the section, and the
      // scroller with it (see LifeDetailsSection.loadAnswers). A background
      // refresh swaps the content in place and, if it fails, keeps what is shown.
      if (!background) {
        setLoading(true);
        setError(null);
      }

      try {
        const next = await fetchAboutYou(authToken);

        if (current === latestLoad.current) {
          setView(next);
        }
      } catch {
        if (!background && current === latestLoad.current) {
          setError('Could not load what Companion knows about you.');
        }
      } finally {
        if (!background && current === latestLoad.current) {
          setLoading(false);
        }
      }
    },
    [authToken],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch when the page says an answer changed. The first render's token is the
  // baseline, not a change, so nothing is fetched twice on mount.
  const seenToken = useRef(refreshToken);

  useEffect(() => {
    if (refreshToken === seenToken.current) {
      return;
    }

    seenToken.current = refreshToken;
    void load({ background: true });
  }, [refreshToken, load]);

  const handleCorrection = async () => {
    const trimmed = correction.trim();
    if (!trimmed || saving) {
      return;
    }

    setSaving(true);
    setSavedNote(null);
    try {
      await submitAboutYouCorrection(authToken, trimmed);
      setCorrection('');
      setAnswering(null);
      setSavedNote('Saved — the next “How you’d do it” will use this.');
      await load({ background: true });
    } catch {
      setSavedNote('Could not save that correction.');
    } finally {
      setSaving(false);
    }
  };

  const handleCompose = async () => {
    const trimmed = task.trim();
    if (!trimmed || composing) {
      return;
    }

    setApplyNote(null);
    try {
      await compose(trimmed);
    } catch {
      // surfaced via composeError
    }
  };

  const handleApply = async () => {
    if (!composed || applying) {
      return;
    }

    setApplying(true);
    setApplyNote(null);
    try {
      const { added } = await apply(composed);
      setApplyNote(
        added > 0 ? `Added ${added} ${added === 1 ? 'card' : 'cards'} to Possibilities.` : 'Nothing to add.',
      );
    } catch {
      setApplyNote('Could not add to Possibilities.');
    } finally {
      setApplying(false);
    }
  };

  // Follow-ups are the gaps that kept confidence low. Answering one is a
  // correction, so send it through the box already wired to that endpoint
  // rather than adding a second write path.
  const handleFollowUp = (question: string) => {
    setAnswering(question);
    setSavedNote(null);
    correctionRef.current?.focus();
  };

  const sectionProps = {
    title: 'About you',
    description: 'How Companion currently understands you.',
    help: 'Companion uses this to personalize “How you’d do it”, which you can try below. If something here is wrong, correct it below.',
  };

  if (loading) {
    return (
      <SettingsSection {...sectionProps}>
        <SettingsCard>
          <SettingsLoading />
        </SettingsCard>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection {...sectionProps}>
        <SettingsNotice
          tone="error"
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </SettingsNotice>
      </SettingsSection>
    );
  }

  const prefers = view?.preferences.filter((p) => p.relationship === 'PREFERS') ?? [];
  const dislikes = view?.preferences.filter((p) => p.relationship === 'DISLIKES') ?? [];
  const hasProfile =
    view != null &&
    (view.dossier != null ||
      prefers.length > 0 ||
      dislikes.length > 0 ||
      view.schedule != null ||
      view.trustMode != null ||
      view.family.length > 0 ||
      view.recentAnswers.length > 0);

  return (
    <SettingsSection {...sectionProps}>
      {!view?.hasSignal && (
        <SettingsNotice>
          Still thin. Answer questions on the Feed, or add a correction below so Companion has something to work
          with.
        </SettingsNotice>
      )}

      {hasProfile ? (
        <SettingsGroup title="What Companion knows">
          {view?.dossier && (
            <SettingsRow label="Dossier">
              {/* Model-written, and the model writes Markdown ("**Personality:** …"). */}
              <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90 prose-p:my-1 prose-p:text-sm prose-p:leading-relaxed prose-ul:my-1 prose-li:my-0 prose-li:text-sm">
                <Markdown>{view.dossier.summary}</Markdown>
              </div>
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                {view.dossier.tone && <p>Tone: {view.dossier.tone}</p>}
                {view.dossier.personalityTraits && view.dossier.personalityTraits.length > 0 && (
                  <p>Traits: {view.dossier.personalityTraits.join(', ')}</p>
                )}
                {view.dossier.challenges && view.dossier.challenges.length > 0 && (
                  <p>Challenges: {view.dossier.challenges.join(', ')}</p>
                )}
              </div>
            </SettingsRow>
          )}

          {(prefers.length > 0 || dislikes.length > 0) && (
            <SettingsRow>
              <div className="grid gap-4 sm:grid-cols-2">
                {prefers.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Preferences</h4>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {prefers.slice(0, 12).map((p) => (
                        <li key={p.entityId}>{p.name}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {dislikes.length > 0 && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Dislikes</h4>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {dislikes.slice(0, 12).map((p) => (
                        <li key={p.entityId}>{p.name}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </SettingsRow>
          )}

          {(view?.schedule || view?.trustMode) && (
            <SettingsRow>
              <div className="grid gap-4 sm:grid-cols-2">
                {view.schedule && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Schedule</h4>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {SCHEDULE_FIELDS.filter(([key]) => typeof view.schedule?.[key] === 'string').map(
                        ([key, label]) => (
                          <li key={key}>
                            {label}: {view.schedule?.[key] as string}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}
                {view.trustMode && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Autonomy</h4>
                    <p className="text-sm text-muted-foreground">
                      {TRUST_MODE_LABELS[view.trustMode] ?? view.trustMode}
                    </p>
                  </div>
                )}
              </div>
            </SettingsRow>
          )}

          {view && view.family.length > 0 && (
            <SettingsRow label="Family">
              <ul className="space-y-1 text-sm text-muted-foreground">
                {view.family.map((member) => (
                  // One person can sit on two edges (a SIBLING_OF stored both ways, an old
                  // CHILD_OF beside its PARENT_OF), so the id alone is not unique here.
                  <li key={`${member.entityId}:${member.relationship}:${member.direction ?? ''}`}>
                    {member.name} ({familyRoleLabel(member)}
                    {member.age != null ? `, ${member.age}` : ''})
                  </li>
                ))}
              </ul>
            </SettingsRow>
          )}

          {view && view.recentAnswers.length > 0 && (
            <SettingsRow label="Recent answers">
              <ul className="space-y-3">
                {view.recentAnswers.slice(0, 5).map((answer) => (
                  <li key={answer.id} className="rounded-lg border border-border p-3">
                    {answer.question && <p className="mb-1 text-xs text-muted-foreground">{answer.question}</p>}
                    <p className="text-sm text-foreground/90">{answer.answer}</p>
                  </li>
                ))}
              </ul>
            </SettingsRow>
          )}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="How you’d do it"
        description="Paste a task and Companion suggests your approach from the profile above. Nothing is scheduled."
      >
        <SettingsRow>
          <Textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={2}
            disabled={composing}
            aria-label="Task to personalize"
            placeholder="e.g. Plan a calm dinner for friends this week…"
          />

          {composed && (
            <HowYoudDoItCard
              className="mt-4 max-w-none"
              result={composed}
              applying={applying}
              applyNote={applyNote}
              onApply={() => void handleApply()}
              onFollowUp={handleFollowUp}
            />
          )}
        </SettingsRow>

        <SettingsFooter status={composeError ? <SettingsStatus tone="error">{composeError}</SettingsStatus> : null}>
          {composed && (
            <Button variant="ghost" onClick={clear}>
              Clear
            </Button>
          )}
          <Button disabled={composing || task.trim().length === 0} onClick={() => void handleCompose()}>
            {composing ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
            {composing ? 'Personalizing…' : 'How I’d do this'}
          </Button>
        </SettingsFooter>
      </SettingsGroup>

      <SettingsGroup
        title="Something wrong?"
        description="Tell Companion what to correct. This becomes a first-person answer used in the next personalization."
      >
        <SettingsRow>
          {answering && (
            <p className="mb-2 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground">
              Answering: {answering}
            </p>
          )}
          <Textarea
            ref={correctionRef}
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            rows={3}
            aria-label="Correction"
            placeholder="e.g. I prefer short meetings in the morning, not evening calls…"
          />
        </SettingsRow>

        <SettingsFooter status={savedNote ? <SettingsStatus>{savedNote}</SettingsStatus> : null}>
          <Button disabled={saving || correction.trim().length === 0} onClick={() => void handleCorrection()}>
            {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Save correction
          </Button>
        </SettingsFooter>
      </SettingsGroup>
    </SettingsSection>
  );
}

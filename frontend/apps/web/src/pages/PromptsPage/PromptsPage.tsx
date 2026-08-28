import { useState, useEffect } from 'react';

import { apiKeyHeaders, buildApiUrl, usePageTitle } from '@ci/common';
import { Button, IconButton, Table, Card, Tabs, ToggleGroup, Tooltip } from '@ci/shadcn';
import {
  AlertCircle,
  RefreshCw,
  Grid3X3,
  List,
  Edit,
  ChevronDown,
  ChevronUp,
} from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import type { AnswerEvidenceWire } from '@/components/AnswerDetails';
import { AnswerProvenance, isInferred } from '@/components/AnswerProvenance';
import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

import { AnswerQuestionPrompt } from './AnswerQuestionPrompt';
import { EditAnswerDialog } from './EditAnswerDialog';
import { ReflectionCatalogue } from './ReflectionCatalogue';

interface Answer {
  id: string;
  ragAnswer: string;
  answer: string;
  /** 'user_input' | 'inferred' | 'observed' | 'imported' — see ci.answers.answer_source. */
  answerSource?: string | null;
  /** [0,1] when the appliance inferred this answer; null when a person wrote it. */
  answerConfidence?: number | null;
  /** The model's one line on what evidence produced an inferred answer. */
  answerRationale?: string | null;
  /**
   * The rows behind that sentence, as `AnswerEntity.toEgressType` sends them —
   * note the entity's own column name here, where the catalogue payload calls
   * the same wrapper `evidence`. Null for anything a person typed and for
   * inferred rows written before the column existed. Declared so this object
   * stays safe to hand to the provenance drawer whole.
   */
  answerEvidence?: AnswerEvidenceWire | null;
  user?: { id: string };
  question?: {
    id: string;
    text: string;
  };
}

export function PromptsPage() {
  usePageTitle('Reflections - Companion Intelligence');

  const { t } = useTranslation();
  const [{ authToken }] = useAuth();

  // Defaults to the full browsable catalogue (~1.3k questions) rather than
  // "Your answers" — the answers tab is naturally near-empty for anyone who
  // hasn't gone through it yet, which reads as "there's nothing here" even
  // though the catalogue tab (added alongside this page) has plenty to answer.
  const [tab, setTab] = useState('catalogue');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'card' | 'table'>('card');
  const [expandedTexts, setExpandedTexts] = useState<Set<string>>(new Set());
  const [editingAnswer, setEditingAnswer] = useState<Answer | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const fetchAnswers = async () => {
    try {
      console.log('AnswersPage: Starting to fetch answers');
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('AnswersPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

      const response = await fetch(buildApiUrl('/api/answers'), {
        headers: {
          ...apiKeyHeaders(),
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Handle different HTTP error codes
        console.error(
          `AnswersPage: API request failed with status ${response.status}: ${response.statusText}`,
        );
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Memory Server error: Please try again later');
        } else {
          throw new Error(`Error fetching answers: ${response.statusText}`);
        }
      }

      console.log('AnswersPage: API request successful, parsing response');
      const data = await response.json();

      // Handle both array response and paginated response
      let answersData: Answer[] = [];
      if (Array.isArray(data)) {
        answersData = data;
      } else if (data.data && Array.isArray(data.data)) {
        answersData = data.data;
      } else {
        console.error('AnswersPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of answers');
      }

      console.log(`AnswersPage: Successfully fetched ${answersData.length} answers`, answersData);
      setAnswers(answersData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('AnswersPage: Error in fetchAnswers():', errorMessage, err);
      setError(errorMessage);
    } finally {
      console.log('AnswersPage: Fetch operation completed');
      setLoading(false);
    }
  };

  useEffect(() => {
    console.log('AnswersPage: Component mounted, fetching answers');
    fetchAnswers();

    return () => {
      console.log('AnswersPage: Component unmounting');
    };
  }, []);

  const toggleTextExpansion = (textId: string) => {
    setExpandedTexts((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(textId)) {
        newSet.delete(textId);
      } else {
        newSet.add(textId);
      }

      return newSet;
    });
  };

  const isTextExpanded = (textId: string) => expandedTexts.has(textId);

  const formatTextWithLineBreaks = (text: string | undefined) => {
    if (!text) {
      return 'N/A';
    }

    return text.split('\n').map((line, index) => (
      <span key={index}>
        {line}
        {index < text.split('\n').length - 1 && <br />}
      </span>
    ));
  };

  // Provenance comes from `answerSource`, which is what the writer actually
  // stamps. It used to be read off `answer.user?.id`, which is populated on
  // EVERY row — answers are user-scoped, so an answer the appliance inferred on
  // the user's behalf still belongs to that user. The effect was that all 20
  // rows on this page, inferred ones included, rendered the same "Manual" badge
  // and the LLM branch below was dead code.
  const isManuallyAnswered = (answer: Answer) => !isInferred(answer.answerSource);

  const isLLMAnswered = (answer: Answer) => isInferred(answer.answerSource) && Boolean(answer.answer);

  const handleEditClick = (answer: Answer) => {
    setEditingAnswer(answer);
    setIsEditDialogOpen(true);
  };

  const handleSaveAnswer = async (answerId: string, answerText: string) => {
    if (!authToken) {
      throw new Error('Authentication token not found');
    }

    const response = await fetch(buildApiUrl(`/api/answers/${answerId}`), {
      method: 'PATCH',
      headers: {
        ...apiKeyHeaders(),
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: answerText,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to update answer: ${response.statusText}`);
    }

    const updatedAnswer = await response.json();

    // Update the answer in the local state
    setAnswers((prevAnswers) => prevAnswers.map((ans) => (ans.id === answerId ? updatedAnswer : ans)));
  };

  const handleCloseEditDialog = () => {
    setIsEditDialogOpen(false);
    setEditingAnswer(null);
  };

  const ExpandableText = ({
    text,
    textId,
    maxLength = 150,
  }: {
    text: string | undefined;
    textId: string;
    maxLength?: number;
  }) => {
    if (!text) {
      return <span className="text-muted-foreground">N/A</span>;
    }

    const isExpanded = isTextExpanded(textId);
    const shouldTruncate = text.length > maxLength;
    const displayText = shouldTruncate && !isExpanded ? text.substring(0, maxLength) + '...' : text;

    return (
      <div className="space-y-2">
        <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {formatTextWithLineBreaks(displayText)}
        </div>
        {shouldTruncate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleTextExpansion(textId)}
            className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? (
              <>
                <ChevronUp className="h-3 w-3 mr-1" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3 mr-1" />
                Show more
              </>
            )}
          </Button>
        )}
      </div>
    );
  };

  return (
    <>
      {/* `p-0` here used to cancel PageContent's own responsive padding and
          hand it back as a flat `px-4 pb-4` — no top padding at all, so on the
          phone the first card sat flush against the top bar, and on desktop
          the safe-area top inset PageContent applies was dropped too. Let
          PageContent own its spacing, same as every other page. */}
      <PageContent className="gap-4">
        <div className="flex flex-col gap-4">
          <AnswerQuestionPrompt onAnswerSubmitted={fetchAnswers} />

          <h1 className="text-2xl font-bold">Reflections</h1>

          {/* Two surfaces, because they answer different questions: "what have
                I told it?" (the answers) and "what can it ask me?" (the
                catalogue). The page used to be only the first, which made 98% of
                the ~1.3k-reflection catalogue unreachable. */}
          <Tabs value={tab} onValueChange={setTab}>
            <Tabs.List>
              <Tabs.Trigger value="answers">Your answers</Tabs.Trigger>
              <Tabs.Trigger value="catalogue">Catalogue</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="answers" className="flex flex-col gap-4">
              {/* `device:` (896px), not `lg:` — this chrome has to switch on the same
                  width useDeviceLayout calls the phone/desktop line. On `lg:` the
                  896–1024 band showed the mobile refresh button AND hid the view
                  toggle while the rest of the app had already gone desktop. */}
              <div className="flex flex-col device:flex-row device:items-center device:justify-between gap-4">
                {/* Mobile: refresh button */}
                <div className="flex items-center justify-between device:justify-start">
                  <IconButton
                    variant="outline"
                    onClick={fetchAnswers}
                    disabled={loading}
                    label={t('PROMPTS_REFRESH_ANSWERS')}
                    className="device:hidden"
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </IconButton>
                </div>

                {/* Desktop: Toggle and refresh button */}
                <div className="hidden device:flex items-center gap-2">
                  <ToggleGroup
                    type="single"
                    value={viewMode}
                    onValueChange={(value) => value && setViewMode(value as 'card' | 'table')}
                  >
                    {/* `data-state` is restated here because Tooltip.Trigger's own
                      open/closed state would otherwise overwrite the item's on/off
                      state and kill the selected-item styling. A wrapper span would
                      fix that too, but it would make every item both :first-child
                      and :last-child, rounding all four corners of each segment. */}
                    <Tooltip delayDuration={600}>
                      <Tooltip.Content>{t('PROMPTS_VIEW_CARD')}</Tooltip.Content>
                      <Tooltip.Trigger asChild>
                        <ToggleGroup.Item
                          value="card"
                          aria-label={t('PROMPTS_VIEW_CARD')}
                          data-state={viewMode === 'card' ? 'on' : 'off'}
                        >
                          <Grid3X3 className="h-4 w-4" />
                        </ToggleGroup.Item>
                      </Tooltip.Trigger>
                    </Tooltip>
                    <Tooltip delayDuration={600}>
                      <Tooltip.Content>{t('PROMPTS_VIEW_TABLE')}</Tooltip.Content>
                      <Tooltip.Trigger asChild>
                        <ToggleGroup.Item
                          value="table"
                          aria-label={t('PROMPTS_VIEW_TABLE')}
                          data-state={viewMode === 'table' ? 'on' : 'off'}
                        >
                          <List className="h-4 w-4" />
                        </ToggleGroup.Item>
                      </Tooltip.Trigger>
                    </Tooltip>
                  </ToggleGroup>
                  <IconButton
                    variant="outline"
                    onClick={fetchAnswers}
                    disabled={loading}
                    label={t('PROMPTS_REFRESH_ANSWERS')}
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </IconButton>
                </div>
              </div>

              {loading ? (
                <div className="text-center py-8">
                  <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
                  <p>Loading reflections...</p>
                </div>
              ) : error ? (
                <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
                  <div>
                    <h3 className="font-medium">Error loading reflections</h3>
                    <p className="text-sm">{error}</p>
                    <Button variant="outline" size="sm" className="mt-2" onClick={fetchAnswers}>
                      Try Again
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {answers.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">No reflections yet</div>
                  ) : (
                    <>
                      {/* Card View - Always shown on mobile, toggleable on desktop.
                          `device:hidden` gates it (the toggle only exists on desktop
                          chrome); `lg:grid-cols-3` stays a plain reflow decision. */}
                      <div
                        className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${viewMode === 'table' ? 'device:hidden' : ''}`}
                      >
                        {/* `px-0` on the three slots: they each default to
                            `px-6`, which stacks on top of the card's own `p-4`
                            for 40px of padding a side. On a 390px phone that
                            is a fifth of the screen spent on nothing, and the
                            question text wrapped every three or four words. */}
                        {answers.map((answer) => (
                          <Card key={answer.id} className="p-4">
                            <Card.Header className="px-0 pb-3">
                              <div className="flex items-start justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-2">
                                    <AnswerProvenance
                                      source={answer.answerSource}
                                      confidence={answer.answerConfidence}
                                      rationale={answer.answerRationale}
                                      details={{
                                        question: answer.question?.text ?? '',
                                        answerText: answer.answer,
                                        record: answer,
                                        onEdit: () => handleEditClick(answer),
                                      }}
                                    />
                                  </div>
                                  <h3 className="font-semibold text-sm leading-tight">
                                    <ExpandableText
                                      text={answer.question?.text}
                                      textId={`question-${answer.id}`}
                                      maxLength={100}
                                    />
                                  </h3>
                                </div>
                              </div>
                            </Card.Header>
                            <Card.Content className="space-y-3 px-0">
                              <div>
                                <h4 className="text-xs font-medium text-muted-foreground mb-1">Answer</h4>
                                <ExpandableText
                                  text={answer.answer}
                                  textId={`answer-${answer.id}`}
                                  maxLength={120}
                                />
                                {/* The evidence, in the model's own words. Shown inline
                                  rather than only in the badge tooltip: a reader
                                  deciding whether to correct an inferred answer needs
                                  to know what it was built from without hovering. */}
                                {isLLMAnswered(answer) && answer.answerRationale ? (
                                  <p className="mt-1 text-xs text-muted-foreground italic">
                                    Based on: {answer.answerRationale}
                                  </p>
                                ) : null}
                              </div>
                              {answer.ragAnswer && (
                                <div>
                                  <h4 className="text-xs font-medium text-muted-foreground mb-1">
                                    RAG Answer
                                  </h4>
                                  <ExpandableText
                                    text={answer.ragAnswer}
                                    textId={`rag-${answer.id}`}
                                    maxLength={120}
                                  />
                                </div>
                              )}
                            </Card.Content>
                            <Card.Footer className="px-0 pt-3">
                              <div className="flex items-center justify-between w-full">
                                <div className="flex items-center gap-1">
                                  {isManuallyAnswered(answer) ? (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 px-2"
                                        onClick={() => handleEditClick(answer)}
                                      >
                                        <Edit className="h-3 w-3 mr-1" />
                                        Edit
                                      </Button>
                                    </>
                                  ) : isLLMAnswered(answer) ? (
                                    // Thumbs up/down used to render here with no
                                    // onClick and no backend confirm/reject
                                    // endpoint on ci.answers — pressing either did
                                    // nothing, on exactly the gesture that reads as
                                    // "this is wrong about me". Edit is the one
                                    // correction path that actually works.
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-2"
                                      onClick={() => handleEditClick(answer)}
                                    >
                                      <Edit className="h-3 w-3 mr-1" />
                                      Edit
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </Card.Footer>
                          </Card>
                        ))}
                      </div>

                      {/* Table View - Only shown on desktop when table mode is selected */}
                      {viewMode === 'table' && (
                        <div className="hidden device:block relative overflow-auto">
                          {/* Fixed Header */}
                          <div className="sticky top-0 z-50 bg-background border-b shadow-sm">
                            <div className="overflow-x-auto">
                              <Table className="min-w-full table-fixed">
                                <Table.Header>
                                  <Table.Row>
                                    <Table.Head className="w-1/4 min-w-[200px] bg-background">
                                      Reflection
                                    </Table.Head>
                                    <Table.Head className="w-1/4 min-w-[200px] bg-background">
                                      Answer
                                    </Table.Head>
                                    <Table.Head className="w-1/4 min-w-[200px] bg-background">
                                      RAG Answer
                                    </Table.Head>
                                    <Table.Head className="w-1/4 min-w-[150px] bg-background">
                                      Actions
                                    </Table.Head>
                                  </Table.Row>
                                </Table.Header>
                              </Table>
                            </div>
                          </div>

                          {/* Scrollable Body */}
                          <Table className="min-w-full table-fixed">
                            <Table.Body>
                              {answers.map((answer) => (
                                <Table.Row key={answer.id}>
                                  <Table.Cell className="break-words align-top">
                                    <div className="space-y-1">
                                      <div className="flex items-center gap-2">
                                        <AnswerProvenance
                                          source={answer.answerSource}
                                          confidence={answer.answerConfidence}
                                          rationale={answer.answerRationale}
                                          details={{
                                            question: answer.question?.text ?? '',
                                            answerText: answer.answer,
                                            record: answer,
                                            onEdit: () => handleEditClick(answer),
                                          }}
                                        />
                                      </div>
                                      <ExpandableText
                                        text={answer.question?.text}
                                        textId={`table-question-${answer.id}`}
                                        maxLength={80}
                                      />
                                    </div>
                                  </Table.Cell>
                                  <Table.Cell className="break-words align-top">
                                    <ExpandableText
                                      text={answer.answer}
                                      textId={`table-answer-${answer.id}`}
                                      maxLength={100}
                                    />
                                  </Table.Cell>
                                  <Table.Cell className="break-words align-top">
                                    <ExpandableText
                                      text={answer.ragAnswer}
                                      textId={`table-rag-${answer.id}`}
                                      maxLength={100}
                                    />
                                  </Table.Cell>
                                  <Table.Cell className="break-words align-top">
                                    <div className="flex items-center gap-1 flex-wrap">
                                      {isManuallyAnswered(answer) ? (
                                        <>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 px-2"
                                            onClick={() => handleEditClick(answer)}
                                          >
                                            <Edit className="h-3 w-3 mr-1" />
                                            Edit
                                          </Button>
                                        </>
                                      ) : isLLMAnswered(answer) ? (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="h-8 px-2"
                                          onClick={() => handleEditClick(answer)}
                                        >
                                          <Edit className="h-3 w-3 mr-1" />
                                          Edit
                                        </Button>
                                      ) : null}
                                    </div>
                                  </Table.Cell>
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table>
                        </div>
                      )}
                    </>
                  )}
                  <div className="text-xs text-muted-foreground text-right mt-4">
                    Total answered reflections: {answers.length}
                  </div>
                </>
              )}
            </Tabs.Content>

            <Tabs.Content value="catalogue">
              <ReflectionCatalogue />
            </Tabs.Content>
          </Tabs>
        </div>
      </PageContent>

      <EditAnswerDialog
        open={isEditDialogOpen}
        answer={editingAnswer}
        onClose={handleCloseEditDialog}
        onSave={handleSaveAnswer}
      />
    </>
  );
}

import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Table, Card, ToggleGroup, Badge } from '@ci/shadcn';
import {
  AlertCircle,
  RefreshCw,
  Grid3X3,
  List,
  Edit,
  ThumbsUp,
  ThumbsDown,
  ChevronDown,
  ChevronUp,
} from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

import { AnswerQuestionPrompt } from './AnswerQuestionPrompt';
import { EditAnswerDialog } from './EditAnswerDialog';

interface Answer {
  id: string;
  ragAnswer: string;
  answer: string;
  user?: { id: string };
  question?: {
    id: string;
    text: string;
  };
}

export function PromptsPage() {
  const { isFeatureEnabled } = useFeatures();

  usePageTitle(`${isFeatureEnabled('new.insights.page') ? 'Insights' : 'Prompts'} - Companion Intelligence`);

  const [{ authToken }] = useAuth();

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

      const response = await fetch('/api/answers', {
        headers: {
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
          throw new Error('Server error: Please try again later');
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

  const isManuallyAnswered = (answer: Answer) => {
    // If there's a user ID, it was manually answered
    return answer.user?.id !== undefined;
  };

  const isLLMAnswered = (answer: Answer) => {
    // If there's no user ID but there's an answer, it was LLM answered
    return !answer.user?.id && answer.answer;
  };

  const handleEditClick = (answer: Answer) => {
    setEditingAnswer(answer);
    setIsEditDialogOpen(true);
  };

  const handleSaveAnswer = async (answerId: string, answerText: string) => {
    if (!authToken) {
      throw new Error('Authentication token not found');
    }

    const response = await fetch(`/api/answers/${answerId}`, {
      method: 'PATCH',
      headers: {
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
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>
                {isFeatureEnabled('new.insights.page') ? 'Prompts' : 'Insights'}
              </Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <AnswerQuestionPrompt onAnswerSubmitted={fetchAnswers} />

        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          {/* Mobile: Title and refresh button in same row */}
          <div className="flex items-center justify-between lg:justify-start">
            {!isFeatureEnabled('new.insights.page') && <h1 className="text-2xl font-bold">Insights</h1>}
            <Button
              variant="outline"
              size="icon"
              onClick={fetchAnswers}
              disabled={loading}
              title="Refresh answers"
              className="lg:hidden"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {/* Desktop: Toggle and refresh button */}
          <div className="hidden lg:flex items-center gap-2">
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => value && setViewMode(value as 'card' | 'table')}
            >
              <ToggleGroup.Item value="card" aria-label="Card view">
                <Grid3X3 className="h-4 w-4" />
              </ToggleGroup.Item>
              <ToggleGroup.Item value="table" aria-label="Table view">
                <List className="h-4 w-4" />
              </ToggleGroup.Item>
            </ToggleGroup>
            <Button
              variant="outline"
              size="icon"
              onClick={fetchAnswers}
              disabled={loading}
              title="Refresh answers"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p>Loading answers...</p>
          </div>
        ) : error ? (
          <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium">Error loading answers</h3>
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={fetchAnswers}>
                Try Again
              </Button>
            </div>
          </div>
        ) : (
          <>
            {answers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No answers found in the system</div>
            ) : (
              <>
                {/* Card View - Always shown on mobile, toggleable on desktop */}
                <div
                  className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${viewMode === 'table' ? 'lg:hidden' : ''}`}
                >
                  {answers.map((answer) => (
                    <Card key={answer.id} className="p-4">
                      <Card.Header className="pb-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              {isManuallyAnswered(answer) ? (
                                <Badge variant="secondary" className="text-xs">
                                  Manual
                                </Badge>
                              ) : isLLMAnswered(answer) ? (
                                <Badge variant="outline" className="text-xs">
                                  AI Generated
                                </Badge>
                              ) : null}
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
                      <Card.Content className="space-y-3">
                        <div>
                          <h4 className="text-xs font-medium text-muted-foreground mb-1">Answer</h4>
                          <ExpandableText
                            text={answer.answer}
                            textId={`answer-${answer.id}`}
                            maxLength={120}
                          />
                        </div>
                        {answer.ragAnswer && (
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground mb-1">RAG Answer</h4>
                            <ExpandableText
                              text={answer.ragAnswer}
                              textId={`rag-${answer.id}`}
                              maxLength={120}
                            />
                          </div>
                        )}
                      </Card.Content>
                      <Card.Footer className="pt-3">
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
                              <>
                                <Button variant="ghost" size="sm" className="h-8 px-2">
                                  <ThumbsUp className="h-3 w-3 mr-1" />
                                </Button>
                                <Button variant="ghost" size="sm" className="h-8 px-2">
                                  <ThumbsDown className="h-3 w-3 mr-1" />
                                </Button>
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
                            ) : null}
                          </div>
                        </div>
                      </Card.Footer>
                    </Card>
                  ))}
                </div>

                {/* Table View - Only shown on desktop when table mode is selected */}
                {viewMode === 'table' && (
                  <div className="hidden lg:block relative overflow-auto">
                    {/* Fixed Header */}
                    <div className="sticky top-0 z-50 bg-background border-b shadow-sm">
                      <div className="overflow-x-auto">
                        <Table className="min-w-full table-fixed">
                          <Table.Header>
                            <Table.Row>
                              <Table.Head className="w-1/4 min-w-[200px] bg-background">Question</Table.Head>
                              <Table.Head className="w-1/4 min-w-[200px] bg-background">Answer</Table.Head>
                              <Table.Head className="w-1/4 min-w-[200px] bg-background">
                                RAG Answer
                              </Table.Head>
                              <Table.Head className="w-1/4 min-w-[150px] bg-background">Actions</Table.Head>
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
                                  {isManuallyAnswered(answer) ? (
                                    <Badge variant="secondary" className="text-xs">
                                      Manual
                                    </Badge>
                                  ) : isLLMAnswered(answer) ? (
                                    <Badge variant="outline" className="text-xs">
                                      AI Generated
                                    </Badge>
                                  ) : null}
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
                                  <>
                                    <Button variant="ghost" size="sm" className="h-8 px-2">
                                      <ThumbsUp className="h-3 w-3 mr-1" />
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-8 px-2">
                                      <ThumbsDown className="h-3 w-3 mr-1" />
                                    </Button>
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
              Total answers: {answers.length}
            </div>
          </>
        )}
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

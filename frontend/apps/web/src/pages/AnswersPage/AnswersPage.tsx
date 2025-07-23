import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Table } from '@ci/shadcn';
import { AlertCircle, RefreshCw } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

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

export function AnswersPage() {
  usePageTitle('Answers - Companion Intelligence');

  const [{ authToken }] = useAuth();

  const [answers, setAnswers] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnswers = async () => {
    try {
      console.log('AnswersPage: Starting to fetch answers');
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('AnswersPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

      console.log('AnswersPage: Making API request to http://dev.companionintelligence.com/api/answers');
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

  const truncateText = (text: string | undefined, maxLength: number = 50) => {
    if (!text) {
      return 'N/A';
    }

    if (text.length <= maxLength) {
      return text;
    }

    return text.substring(0, maxLength) + '...';
  };

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Answers</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Card className="w-full">
        <Card.Header className="flex flex-row items-center justify-between">
          <Card.Title className="text-2xl">Answers</Card.Title>
          <Button
            variant="outline"
            size="icon"
            onClick={fetchAnswers}
            disabled={loading}
            title="Refresh answers"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </Card.Header>
        <Card.Content>
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
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>ID</Table.Head>
                      <Table.Head>Question</Table.Head>
                      <Table.Head>Answer</Table.Head>
                      <Table.Head>RAG Answer</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {answers.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No answers found in the system
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      answers.map((answer) => (
                        <Table.Row key={answer.id}>
                          <Table.Cell className="font-mono text-xs">{answer.id}</Table.Cell>
                          <Table.Cell className="text-sm">{answer.question?.text}</Table.Cell>
                          <Table.Cell className="text-sm">{truncateText(answer.answer)}</Table.Cell>
                          <Table.Cell className="text-sm">{truncateText(answer.ragAnswer)}</Table.Cell>
                        </Table.Row>
                      ))
                    )}
                  </Table.Body>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-4">Total answers: {answers.length}</div>
            </>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Table } from '@ci/shadcn';
import { AlertCircle, RefreshCw } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface Question {
  id: string;
  category: string;
  text: string;
  answer: string;
}

export function QuestionsPage() {
  usePageTitle('Questions - Companion Intelligence');

  const [{ authToken }] = useAuth();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQuestions = async () => {
    try {
      console.log('QuestionsPage: Starting to fetch questions');
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('QuestionsPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

      console.log('QuestionsPage: Making API request to http://dev.companionintelligence.com/api/questions');
      const response = await fetch('/api/questions', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Handle different HTTP error codes
        console.error(
          `QuestionsPage: API request failed with status ${response.status}: ${response.statusText}`,
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
          throw new Error(`Error fetching questions: ${response.statusText}`);
        }
      }

      console.log('QuestionsPage: API request successful, parsing response');
      const data = await response.json();

      // Handle both array response and paginated response
      let questionsData: Question[] = [];
      if (Array.isArray(data)) {
        questionsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        questionsData = data.data;
      } else {
        console.error('QuestionsPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of questions');
      }

      console.log(`QuestionsPage: Successfully fetched ${questionsData.length} questions`, questionsData);
      setQuestions(questionsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('QuestionsPage: Error in fetchQuestions():', errorMessage, err);
      setError(errorMessage);
    } finally {
      console.log('QuestionsPage: Fetch operation completed');
      setLoading(false);
    }
  };

  useEffect(() => {
    console.log('QuestionsPage: Component mounted, fetching questions');
    fetchQuestions();

    return () => {
      console.log('QuestionsPage: Component unmounting');
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
              <Breadcrumb.Page>Questions</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Card className="w-full">
        <Card.Header className="flex flex-row items-center justify-end">
          <Button
            variant="outline"
            size="icon"
            onClick={fetchQuestions}
            disabled={loading}
            title="Refresh questions"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </Card.Header>
        <Card.Content>
          {loading ? (
            <div className="text-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
              <p>Loading questions...</p>
            </div>
          ) : error ? (
            <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium">Error loading questions</h3>
                <p className="text-sm">{error}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={fetchQuestions}>
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
                      <Table.Head>Category</Table.Head>
                      <Table.Head>Question</Table.Head>
                      <Table.Head>Answer</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {questions.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No questions found in the system
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      questions.map((question) => (
                        <Table.Row key={question.id}>
                          <Table.Cell className="font-mono text-xs">{question.id}</Table.Cell>
                          <Table.Cell className="text-sm">{question.category || 'N/A'}</Table.Cell>
                          <Table.Cell className="text-sm">{truncateText(question.text)}</Table.Cell>
                          <Table.Cell className="text-sm">{truncateText(question.answer)}</Table.Cell>
                        </Table.Row>
                      ))
                    )}
                  </Table.Body>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-4">Total questions: {questions.length}</div>
            </>
          )}
        </Card.Content>
      </Card>
    </>
  );
}

import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Textarea, cn, Sidebar } from '@ci/shadcn';
import {
  Square,
  Plus,
  RefreshCw,
  Trash2,
  MessageSquare,
  Bot,
  Sparkles,
  Send,
  X,
  ChevronLeft,
} from '@ci/shadcn/icons';
import { useLocation, useNavigate } from 'react-router-dom';

import { ModelSelector } from '@/components/ModelSelector';
import { useAuth, useModel } from '@/hooks';
import { VoiceInput, TTSButton } from '@ci/capture';
import { getVoiceServiceUrl } from '../../config/voice';

import { ChatMessage } from './ChatMessage';

// Custom scrollbar styles
const scrollbarStyles = `
  .chat-scrollbar::-webkit-scrollbar {
    width: 6px;
  }

  .chat-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }

  .chat-scrollbar::-webkit-scrollbar-thumb {
    background: hsl(var(--muted-foreground) / 0.2);
    border-radius: 3px;
  }

  .chat-scrollbar::-webkit-scrollbar-thumb:hover {
    background: hsl(var(--muted-foreground) / 0.3);
  }
`;

interface Thread {
  id: string;
  name: string | null;
  model: string;
  description: string | null;
}

interface ChatSidebarProps {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onDeleteThread: (id: string) => void;
  loading: boolean;
  onRefresh: () => void;
}

const ChatSidebar = memo(function ChatSidebar({
  threads,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  loading,
  onRefresh,
}: ChatSidebarProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  // Auto-collapse on mobile screens
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        // md breakpoint
        setIsExpanded(false);
      } else {
        setIsExpanded(true);
      }
    };

    // Set initial state
    handleResize();

    window.addEventListener('resize', handleResize);

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div
      className={cn(
        'border-r bg-gradient-to-b from-background/50 to-muted/20 backdrop-blur-sm flex-shrink-0 transition-all duration-300 ease-in-out h-full',
        isExpanded ? 'w-72 lg:w-80' : 'w-16 lg:w-20',
      )}
    >
      <Sidebar.Header
        className={cn(
          'flex flex-row items-center border-b border-border/50 bg-background/80 backdrop-blur-sm',
          isExpanded ? 'gap-3 p-4' : 'justify-center p-2',
        )}
      >
        <button
          onClick={() => !isExpanded && setIsExpanded(true)}
          className={cn(
            'w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 transition-all duration-200',
            !isExpanded && 'hover:bg-primary/20 cursor-pointer hover:scale-105',
          )}
          title={!isExpanded ? 'Click to expand sidebar' : undefined}
        >
          <MessageSquare className="h-5 w-5 text-primary" />
        </button>
        {isExpanded && (
          <>
            <h2 className="text-lg font-semibold flex-shrink-0">Chat Threads</h2>
            <button
              onClick={onRefresh}
              className="p-2 rounded-lg hover:bg-muted/80 transition-all duration-200 hover:scale-105 flex-shrink-0"
              title="Refresh threads"
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </>
        )}
        {isExpanded && (
          <button
            onClick={() => setIsExpanded(false)}
            className="p-2 rounded-lg hover:bg-muted/80 transition-all duration-200 hover:scale-105 flex-shrink-0 ml-auto"
            title="Collapse sidebar"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
      </Sidebar.Header>
      <Sidebar.Content className={cn('transition-all duration-300 ease-in-out', isExpanded ? 'p-3' : 'p-2')}>
        {isExpanded ? (
          <>
            {threads.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                {loading ? (
                  <>
                    <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                      <RefreshCw className="h-8 w-8 animate-spin text-primary/50" />
                    </div>
                    <p className="font-medium">Loading threads...</p>
                  </>
                ) : (
                  <>
                    <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
                      <MessageSquare className="h-8 w-8 opacity-30" />
                    </div>
                    <p className="font-medium mb-2">No threads found</p>
                    <p className="text-sm">Create a new thread to get started</p>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {/* New Thread Option */}
                <div className="p-2">
                  <button
                    onClick={onNewThread}
                    className={cn(
                      'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed border-muted-foreground/30 hover:border-primary/50 hover:bg-primary/5 transition-all duration-200 group hover:scale-[1.02]',
                      !selectedThreadId && 'border-primary/50 bg-primary/5 shadow-sm',
                    )}
                  >
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                      <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    <span className="font-medium text-muted-foreground group-hover:text-foreground transition-colors">
                      New Thread
                    </span>
                  </button>
                </div>

                {/* Separator */}
                {threads.length > 0 && (
                  <div className="relative py-3">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border/50" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase tracking-wider">
                      <span className="bg-gradient-to-r from-background/50 to-muted/20 px-3 text-muted-foreground font-medium">
                        Recent Threads
                      </span>
                    </div>
                  </div>
                )}

                {/* Existing Threads */}
                <div className="space-y-2">
                  {threads.map((thread) => (
                    <div key={thread.id} className="group">
                      <button
                        onClick={() => onSelectThread(thread.id)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-muted/60 transition-all duration-200 relative hover:scale-[1.01]',
                          selectedThreadId === thread.id &&
                            'bg-primary/10 border border-primary/20 shadow-md ring-2 ring-primary/10',
                        )}
                      >
                        <div
                          className={cn(
                            'w-2 h-2 rounded-full transition-all duration-200',
                            selectedThreadId === thread.id
                              ? 'bg-primary scale-125'
                              : 'bg-muted-foreground/30',
                          )}
                        />
                        <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                          <MessageSquare className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0 text-left">
                          <div className="truncate font-medium text-sm">
                            {thread.name || `Thread ${thread.id.slice(0, 8)}`}
                          </div>
                          {thread.description && (
                            <div className="text-xs text-muted-foreground truncate mt-0.5">
                              {thread.description}
                            </div>
                          )}
                        </div>
                        <div
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteThread(thread.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-destructive/10 hover:text-destructive transition-all duration-200 hover:scale-110 cursor-pointer"
                          title="Delete thread"
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              onDeleteThread(thread.id);
                            }
                          }}
                        >
                          <Trash2 size={14} />
                        </div>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          // Collapsed state - show only icons
          <div className="space-y-2">
            {/* New Thread Option */}
            <div className="flex justify-center">
              <button
                onClick={onNewThread}
                className={cn(
                  'w-10 h-10 rounded-lg bg-primary/10 hover:bg-primary/20 transition-all duration-200 flex items-center justify-center',
                  !selectedThreadId && 'bg-primary/20 ring-2 ring-primary/30',
                )}
                title="New Thread"
              >
                <Plus className="h-5 w-5 text-primary" />
              </button>
            </div>

            {/* Existing Threads */}
            {threads.map((thread) => (
              <div key={thread.id} className="flex justify-center">
                <button
                  onClick={() => onSelectThread(thread.id)}
                  className={cn(
                    'w-10 h-10 rounded-lg hover:bg-muted/60 transition-all duration-200 relative flex items-center justify-center',
                    selectedThreadId === thread.id && 'bg-primary/10 ring-2 ring-primary/20',
                  )}
                  title={thread.name || `Thread ${thread.id.slice(0, 8)}`}
                >
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full transition-all duration-200 absolute -top-1 -right-1',
                      selectedThreadId === thread.id ? 'bg-primary scale-125' : 'bg-muted-foreground/30',
                    )}
                  />
                  <MessageSquare className="h-5 w-5 text-muted-foreground" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Sidebar.Content>
    </div>
  );
});

export default function ChatPage() {
  usePageTitle('Chat - Companion Intelligence');

  const [{ authToken }] = useAuth();
  const [{ selectedModel }] = useModel();
  const location = useLocation();
  const navigate = useNavigate();

  // Extract route information from pathname instead of useParams
  const pathSegments = location.pathname.split('/').filter(Boolean);
  // const isNew = pathSegments.includes('new'); // we're on /chat/new
  const threadId = pathSegments.length > 1 && pathSegments[1] !== 'new' ? pathSegments[1] : null;

  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(threadId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat input state
  const [input, setInput] = useState('');

  // Input handlers
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  };

  const clearInput = () => {
    setInput('');
  };

  // Handle voice transcription
  const handleVoiceTranscription = useCallback((transcribedText: string) => {
    setInput(prev => prev + (prev ? ' ' : '') + transcribedText);
  }, []);

  const inputHasValue = input.trim() !== '';

  const [output, setOutput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [chatHistory, setChatHistory] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Add custom scrollbar styles
  useEffect(() => {
    const styleElement = document.createElement('style');
    styleElement.textContent = scrollbarStyles;
    document.head.appendChild(styleElement);

    return () => {
      document.head.removeChild(styleElement);
    };
  }, []);

  // Fetch threads
  const fetchThreads = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      const response = await fetch('/api/threads', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Server error: Please try again later');
        } else {
          throw new Error(`Error fetching threads: ${response.statusText}`);
        }
      }

      const data = await response.json();

      let threadsData: Thread[] = [];

      if (Array.isArray(data)) {
        threadsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        threadsData = data.data;
      } else {
        throw new Error('Invalid response format: Expected an array of threads');
      }

      setThreads(threadsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  // Load threads on mount
  useEffect(() => {
    fetchThreads();
  }, [authToken]);

  // Handle URL changes and update state accordingly
  useEffect(() => {
    const pathSegments = location.pathname.split('/').filter(Boolean);
    const isNewRoute = pathSegments.includes('new');
    const routeThreadId = pathSegments.length > 1 && pathSegments[1] !== 'new' ? pathSegments[1] : null;

    if (isNewRoute) {
      setSelectedThreadId(null);
      setChatHistory([]);
      clearInput();
      setOutput('');
      setIsLoading(false);
    } else if (routeThreadId && routeThreadId !== selectedThreadId) {
      setSelectedThreadId(routeThreadId);
    }
  }, [location.pathname, selectedThreadId, clearInput]);

  // Load thread data when selectedThreadId changes
  const loadThreadData = useCallback(async () => {
    if (!selectedThreadId || !authToken) {
      return;
    }

    setLoadingThread(true);
    try {
      // Use the correct endpoint based on the backend API
      const response = await fetch(`/api/threads/${selectedThreadId}?includeMessages=true`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to load thread: ${response.statusText}`);
      }

      const data = await response.json();
      const messages = data.messages || data.data || [];

      const formattedMessages = messages.map((msg: { prompt: boolean; text: string }) => ({
        role: msg.prompt ? 'user' : 'assistant',
        content: msg.text || '',
      }));

      setChatHistory(formattedMessages);
    } catch (err) {
      console.error('Failed to load thread data:', err);
      setError('Failed to load thread data');
    } finally {
      setLoadingThread(false);
    }
  }, [selectedThreadId, authToken]);

  useEffect(() => {
    loadThreadData();
  }, [loadThreadData]);

  // Handle thread selection
  const handleSelectThread = useCallback(
    (threadId: string) => {
      setSelectedThreadId(threadId);
      // Update URL using React Router navigation
      navigate(`/chat/${threadId}`, { replace: true });
    },
    [navigate],
  );

  // Handle new thread creation
  const handleNewThread = useCallback(() => {
    setSelectedThreadId(null);
    setChatHistory([]);
    clearInput();
    setOutput('');
    setIsLoading(false);
    // Update URL using React Router navigation
    navigate('/chat');
    // Note: Thread will be created automatically when the first message is sent
  }, [clearInput, navigate]);

  // Handle thread deletion
  const handleDeleteThread = useCallback(
    async (threadId: string) => {
      const confirmed = window.confirm('Are you sure you want to delete this thread?');
      if (!confirmed) {
        return;
      }

      try {
        const res = await fetch(`/api/threads/${threadId}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        });

        if (!res.ok) {
          throw new Error(`Failed to delete thread ${threadId}`);
        }

        setThreads((prev) => prev.filter((t) => t.id !== threadId));

        if (selectedThreadId === threadId) {
          const nextThread = threads.find((t) => t.id !== threadId);
          if (nextThread) {
            setSelectedThreadId(nextThread.id);
            // Update URL using React Router navigation
            navigate(`/chat/${nextThread.id}`, { replace: true });
          } else {
            setSelectedThreadId(null);
            // Update URL using React Router navigation
            navigate('/chat/new', { replace: true });
          }
        }
      } catch (err) {
        console.error(err);
        alert('Failed to delete thread.');
      }
    },
    [authToken, selectedThreadId, threads],
  );

  // Handle form submission
  const handleSubmit = useCallback(async () => {
    if (!input.trim()) {
      return;
    }

    // Add user message to chat history immediately
    const userMessage = { role: 'user' as const, content: input.trim() };
    setChatHistory((prev) => [...prev, userMessage]);

    setOutput('');
    setIsLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          prompt: input,
          model: selectedModel,
          threadId: selectedThreadId,
          enableTools: true,
        }),
        signal: controller.signal,
      });

      const newThreadId = res.headers.get('X-Thread-Id') as string;
      if (newThreadId && !selectedThreadId) {
        setSelectedThreadId(newThreadId);
        // Update URL using React Router navigation
        navigate(`/chat/${newThreadId}`, { replace: true });

        // Add the new thread to the threads list
        const newThread: Thread = {
          id: newThreadId,
          name: input.trim().slice(0, 50) + (input.trim().length > 50 ? '...' : ''),
          model: selectedModel || 'default',
          description: input.trim().slice(0, 100) + (input.trim().length > 100 ? '...' : ''),
        };
        setThreads((prev) => [newThread, ...prev]);
      }

      if (!res.body) {
        throw new Error('No response body');
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();

      let assistantResponse = '';
      while (true) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        if (value) {
          assistantResponse += value;
          setOutput(assistantResponse);
        }
      }

      // Add the assistant's response to chat history
      if (assistantResponse.trim()) {
        setChatHistory((prev) => [...prev, { role: 'assistant', content: assistantResponse }]);
      }

      // Clear the input field for the next message
      clearInput();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Stream error:', err);
      }
    } finally {
      setIsLoading(false);
    }
  }, [input, authToken, selectedModel, selectedThreadId]);

  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
  }, []);

  // Memoized computed values to prevent unnecessary re-renders
  const isSubmitDisabled = useMemo(() => {
    return isLoading || selectedModel == null || !inputHasValue;
  }, [isLoading, selectedModel, inputHasValue]);

  const inputPlaceholder = useMemo(() => {
    return !selectedThreadId ? 'Start a new conversation...' : 'Continue the conversation...';
  }, [selectedThreadId]);

  const submitButtonText = useMemo(() => {
    return !selectedThreadId ? (
      <>
        <Sparkles className="h-4 w-4" />
        Start Chat
      </>
    ) : (
      <>
        <Send className="h-4 w-4" />
        Send
      </>
    );
  }, [selectedThreadId]);

  // Memoize threads data to prevent unnecessary re-renders
  const memoizedThreads = useMemo(() => threads, [threads]);
  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId),
    [threads, selectedThreadId],
  );

  useEffect(() => {
    containerRef.current?.scrollTo({
      top: containerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [output]);

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
              <Breadcrumb.Page>Chat</Breadcrumb.Page>
            </Breadcrumb.Item>
            {selectedThreadId && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{selectedThread?.name || selectedThreadId.slice(0, 8)}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Portal.Slot id="actions">
        <ModelSelector />
      </Portal.Slot>

      <Portal.Slot id="tertiary-navigation">
        <ChatSidebar
          threads={memoizedThreads}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onDeleteThread={handleDeleteThread}
          loading={loading}
          onRefresh={fetchThreads}
        />
      </Portal.Slot>

      <div className="flex flex-1 flex-col gap-4 lg:gap-6 pl-0 pr-2 lg:p-6 pt-0">
        {error ? (
          <Card className="border-destructive/20 bg-destructive/5">
            <Card.Content className="p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0">
                  <X className="h-5 w-5 text-destructive" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-destructive mb-2">Error loading threads</h3>
                  <p className="text-sm text-destructive/80 mb-4">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={fetchThreads}
                    className="border-destructive/20 text-destructive hover:bg-destructive/10"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Try Again
                  </Button>
                </div>
              </div>
            </Card.Content>
          </Card>
        ) : (
          <div className="w-full space-y-4 lg:space-y-6">
            {/* Single Conversation Pane */}
            <Card className="border-0 shadow-none bg-transparent">
              <Card.Content className="p-0">
                {/* Welcome Message Section - shown when no thread is selected */}
                {!selectedThreadId && (
                  <div className="text-center max-w-md mx-auto mb-6 lg:mb-8">
                    <div className="w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-gradient-to-br from-primary/10 to-primary/20 flex items-center justify-center mx-auto mb-4 lg:mb-6 shadow-lg border border-primary/20">
                      <MessageSquare className="h-8 w-8 lg:h-10 lg:w-10 text-primary" />
                    </div>
                    <h2 className="text-xl lg:text-2xl font-semibold mb-3 bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent">
                      Welcome to Chat
                    </h2>
                    <p className="text-muted-foreground mb-4 lg:mb-6 leading-relaxed text-sm lg:text-base">
                      Choose a thread from the sidebar or create a new one to start chatting with AI
                    </p>
                    <Button
                      onClick={handleNewThread}
                      size="lg"
                      className="gap-2 shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 text-sm lg:text-base px-4 lg:px-6 py-2 lg:py-3"
                    >
                      <Plus className="h-4 w-4 lg:h-5 lg:w-5" />
                      Create New Thread
                    </Button>
                  </div>
                )}

                {/* Chat History Section */}
                <div
                  ref={containerRef}
                  className="space-y-4 lg:space-y-6 max-h-[500px] overflow-y-auto chat-scrollbar mb-4 lg:mb-6"
                  style={{
                    scrollbarWidth: 'thin',
                    scrollbarColor: 'hsl(var(--muted-foreground) / 0.2) transparent',
                  }}
                >
                  {loadingThread ? (
                    <div className="text-center py-12">
                      <RefreshCw className="h-12 w-12 animate-spin mx-auto mb-4 text-primary/50" />
                      <p className="text-muted-foreground font-medium">Loading conversation...</p>
                    </div>
                  ) : chatHistory.length === 0 && !isLoading && selectedThreadId ? (
                    <div className="text-center py-12">
                      <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <p className="text-muted-foreground">Start a conversation by typing a message.</p>
                    </div>
                  ) : null}

                  {chatHistory.map((message, index) => (
                    <ChatMessage
                      key={`${message.role}-${index}-${message.content.slice(0, 20)}`}
                      message={message}
                      index={index}
                    />
                  ))}

                  {isLoading && (
                    <div className="flex justify-start animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shadow-sm">
                          <Bot className="h-4 w-4 text-primary" />
                        </div>
                        <div className="bg-muted text-foreground rounded-2xl px-4 py-3 text-sm border border-border/50 shadow-sm">
                          {output || (
                            <div className="flex items-center gap-2">
                              <div className="flex space-x-1">
                                <div
                                  className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
                                  style={{ animationDelay: '0ms' }}
                                />
                                <div
                                  className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
                                  style={{ animationDelay: '150ms' }}
                                />
                                <div
                                  className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce"
                                  style={{ animationDelay: '300ms' }}
                                />
                              </div>
                              <span className="text-muted-foreground">Generating...</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* TTS Button */}
                {chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant' && (
                  <div className="flex justify-end pt-4 border-t border-border/50 mb-6">
                    <TTSButton
                      text={chatHistory[chatHistory.length - 1].content}
                      disabled={isLoading}
                      voiceServiceUrl={getVoiceServiceUrl('tts')}
                    />
                  </div>
                )}

                {/* Chat Input Section - always at the bottom */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSubmit();
                  }}
                  className="space-y-4"
                >
                  <div className="relative">
                    <Textarea
                      name="message"
                      placeholder={inputPlaceholder}
                      value={input}
                      onChange={handleInputChange}
                      className="resize-none min-h-[120px] text-base leading-relaxed pr-12 bg-background/80 backdrop-blur-sm border-border/50 focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all duration-200 placeholder:text-muted-foreground/60"
                    />
                    <Button
                      type="submit"
                      disabled={isSubmitDisabled}
                      size="sm"
                      className="absolute bottom-3 right-3 h-8 w-8 p-0 shadow-sm hover:shadow-md transition-all duration-200 hover:scale-105"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="flex items-center gap-3">
                    <Button type="submit" disabled={isSubmitDisabled} className="gap-2 shadow-sm">
                      {submitButtonText}
                    </Button>

                    {isLoading && (
                      <Button variant="destructive" onClick={handleStop} size="sm" className="shadow-sm">
                        <Square className="h-4 w-4 mr-2" />
                        Stop
                      </Button>
                    )}

                    <VoiceInput
                      onTranscription={handleVoiceTranscription}
                      disabled={isLoading}
                      className="ml-auto"
                      voiceServiceUrl={getVoiceServiceUrl('transcribe')}
                    />
                  </div>
                </form>
              </Card.Content>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
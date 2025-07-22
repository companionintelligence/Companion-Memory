import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Sidebar } from '@ci/shadcn';
import { MessageSquare, Plus, Trash2 } from '@ci/shadcn/icons';

// Types for our chat data
interface Message {
  id: string;
  content: string;
  sender: 'user' | 'assistant';
  timestamp: string;
}

interface Conversation {
  id: string;
  title: string;
  topic: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
}

// Mock API for chat functionality
class ChatAPI {
  private conversations: Conversation[];

  private static instance: ChatAPI;

  private constructor() {
    // Initialize with sample data
    this.conversations = [
      {
        id: 'conv-1',
        title: 'What should I have for dinner?',
        topic: 'Food & Cooking',
        createdAt: '2025-05-20T18:30:00Z',
        updatedAt: '2025-05-20T18:45:00Z',
        messages: [
          {
            id: 'msg-1-1',
            content: 'What should I have for dinner tonight?',
            sender: 'user',
            timestamp: '2025-05-20T18:30:00Z',
          },
          {
            id: 'msg-1-2',
            content:
              "Based on seasonal ingredients available now, I'd recommend a spring vegetable pasta with asparagus, peas, and lemon. It's quick to make and nutritious!",
            sender: 'assistant',
            timestamp: '2025-05-20T18:31:00Z',
          },
          {
            id: 'msg-1-3',
            content: "That sounds good but I don't have asparagus. Any alternatives?",
            sender: 'user',
            timestamp: '2025-05-20T18:33:00Z',
          },
          {
            id: 'msg-1-4',
            content:
              'No problem! You can substitute with broccoli, green beans, or even zucchini. Any green vegetable will work well in this dish.',
            sender: 'assistant',
            timestamp: '2025-05-20T18:34:00Z',
          },
        ],
      },
      {
        id: 'conv-2',
        title: 'What is the best toaster?',
        topic: 'Shopping & Products',
        createdAt: '2025-05-19T14:20:00Z',
        updatedAt: '2025-05-19T14:35:00Z',
        messages: [
          {
            id: 'msg-2-1',
            content: "I need to buy a new toaster. What's the best one on the market?",
            sender: 'user',
            timestamp: '2025-05-19T14:20:00Z',
          },
          {
            id: 'msg-2-2',
            content:
              "The best toaster depends on your needs and budget. For overall value, the Breville Die-Cast 2-Slice Smart Toaster offers consistent results and durability. If you're on a budget, the Cuisinart CPT-122 2-Slice Compact Toaster is well-reviewed.",
            sender: 'assistant',
            timestamp: '2025-05-19T14:21:00Z',
          },
        ],
      },
      {
        id: 'conv-3',
        title: 'What is fun today?',
        topic: 'Entertainment',
        createdAt: '2025-05-18T10:15:00Z',
        updatedAt: '2025-05-18T10:30:00Z',
        messages: [
          {
            id: 'msg-3-1',
            content: "I'm bored. What's something fun I could do today?",
            sender: 'user',
            timestamp: '2025-05-18T10:15:00Z',
          },
          {
            id: 'msg-3-2',
            content:
              "Since it's a nice day out, you could try visiting a local park, having a picnic, or renting a bike to explore your city. If you prefer indoor activities, you could try a new recipe, start a DIY project, or have a movie marathon with friends.",
            sender: 'assistant',
            timestamp: '2025-05-18T10:16:00Z',
          },
        ],
      },
      {
        id: 'conv-4',
        title: 'How long do batteries last?',
        topic: 'Technology',
        createdAt: '2025-05-17T09:45:00Z',
        updatedAt: '2025-05-17T10:00:00Z',
        messages: [
          {
            id: 'msg-4-1',
            content: 'How long do lithium-ion batteries typically last in laptops?',
            sender: 'user',
            timestamp: '2025-05-17T09:45:00Z',
          },
          {
            id: 'msg-4-2',
            content:
              'Lithium-ion batteries in laptops typically last between 2-4 years or about 300-500 complete charge cycles. However, this varies based on usage patterns, charging habits, and the specific laptop model.',
            sender: 'assistant',
            timestamp: '2025-05-17T09:46:00Z',
          },
          {
            id: 'msg-4-3',
            content: 'Is there anything I can do to make my laptop battery last longer?',
            sender: 'user',
            timestamp: '2025-05-17T09:48:00Z',
          },
          {
            id: 'msg-4-4',
            content:
              'Yes, several practices can extend battery life: avoid complete discharges, keep your laptop cool, update your software regularly, reduce screen brightness, and if possible, use battery-saving modes. Also, consider removing the battery when using AC power for extended periods if your laptop allows it.',
            sender: 'assistant',
            timestamp: '2025-05-17T09:49:00Z',
          },
        ],
      },
    ];
  }

  public static getInstance(): ChatAPI {
    if (!ChatAPI.instance) {
      ChatAPI.instance = new ChatAPI();
    }

    return ChatAPI.instance;
  }

  // Get all conversations
  public async getConversations(): Promise<Conversation[]> {
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 300));

    return [...this.conversations];
  }

  // Get a specific conversation by ID
  public async getConversation(id: string): Promise<Conversation | undefined> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    return this.conversations.find((conv) => conv.id === id);
  }

  // Create a new conversation
  public async createConversation(title: string, topic: string = 'General'): Promise<Conversation> {
    await new Promise((resolve) => setTimeout(resolve, 300));

    const newConversation: Conversation = {
      id: `conv-${Date.now()}`,
      title,
      topic,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.conversations.unshift(newConversation);

    return newConversation;
  }

  // Delete a conversation
  public async deleteConversation(id: string): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const initialLength = this.conversations.length;
    this.conversations = this.conversations.filter((conv) => conv.id !== id);

    return initialLength > this.conversations.length;
  }

  // Add a message to a conversation
  public async addMessage(
    conversationId: string,
    content: string,
    sender: 'user' | 'assistant',
  ): Promise<Message | null> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const conversation = this.conversations.find((conv) => conv.id === conversationId);
    if (!conversation) {
      return null;
    }

    const newMessage: Message = {
      id: `msg-${conversationId}-${Date.now()}`,
      content,
      sender,
      timestamp: new Date().toISOString(),
    };

    conversation.messages.push(newMessage);
    conversation.updatedAt = new Date().toISOString();

    return newMessage;
  }

  // Get all messages for a conversation
  public async getMessages(conversationId: string): Promise<Message[]> {
    await new Promise((resolve) => setTimeout(resolve, 200));

    const conversation = this.conversations.find((conv) => conv.id === conversationId);

    return conversation ? [...conversation.messages] : [];
  }
}

// Hook to use the chat API
function useChatAPI() {
  const api = ChatAPI.getInstance();

  return {
    getConversations: api.getConversations.bind(api),
    getConversation: api.getConversation.bind(api),
    createConversation: api.createConversation.bind(api),
    deleteConversation: api.deleteConversation.bind(api),
    addMessage: api.addMessage.bind(api),
    getMessages: api.getMessages.bind(api),
  };
}

function ChatSidebar({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
}: {
  conversations: Conversation[];
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
}) {
  // Group conversations by topic
  const conversationsByTopic = conversations.reduce(
    (acc, conversation) => {
      if (!acc[conversation.topic]) {
        acc[conversation.topic] = [];
      }

      acc[conversation.topic].push(conversation);

      return acc;
    },
    {} as Record<string, Conversation[]>,
  );

  return (
    <>
      <div className="border-l grow">
        <Sidebar.Header className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Conversations</h2>
          <button
            onClick={onNewConversation}
            className="p-1 rounded-full hover:bg-muted"
            title="New conversation"
          >
            <Plus size={20} />
          </button>
        </Sidebar.Header>
        <Sidebar.Content>
          {Object.entries(conversationsByTopic).map(([topic, topicConversations]) => (
            <Sidebar.Group key={topic}>
              <Sidebar.GroupLabel>{topic}</Sidebar.GroupLabel>
              <Sidebar.GroupContent>
                <Sidebar.Menu>
                  {topicConversations.map((conversation) => (
                    <Sidebar.MenuItem key={conversation.id}>
                      <Sidebar.MenuButton
                        onClick={() => onSelectConversation(conversation.id)}
                        className={selectedConversationId === conversation.id ? 'bg-muted' : ''}
                      >
                        <MessageSquare className="mr-2 h-4 w-4" />
                        <span className="flex-1 truncate">{conversation.title}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteConversation(conversation.id);
                          }}
                          className="group-hover:opacity-100 p-1 rounded-full hover:bg-muted"
                          title="Delete conversation"
                        >
                          <Trash2 size={14} />
                        </button>
                      </Sidebar.MenuButton>
                    </Sidebar.MenuItem>
                  ))}
                </Sidebar.Menu>
              </Sidebar.GroupContent>
            </Sidebar.Group>
          ))}
        </Sidebar.Content>
      </div>
    </>
  );
}

export function ChatPage() {
  usePageTitle('Chat - Companion Intelligence');

  const chatApi = useChatAPI();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [loading, setLoading] = useState(true);
  const [newMessage, setNewMessage] = useState('');

  // Load conversations on mount
  useEffect(() => {
    const loadConversations = async () => {
      try {
        const data = await chatApi.getConversations();
        setConversations(data);
        setLoading(false);

        // Select the first conversation by default if available
        if (data.length > 0 && !selectedConversationId) {
          setSelectedConversationId(data[0].id);
        }
      } catch (error) {
        console.error('Failed to load conversations:', error);
        setLoading(false);
      }
    };

    loadConversations();
  }, []);

  // Load selected conversation details
  useEffect(() => {
    const loadConversation = async () => {
      if (!selectedConversationId) {
        setCurrentConversation(null);

        return;
      }

      try {
        const conversation = await chatApi.getConversation(selectedConversationId);
        setCurrentConversation(conversation || null);
      } catch (error) {
        console.error('Failed to load conversation:', error);
      }
    };

    loadConversation();
  }, [selectedConversationId]);

  // Handle creating a new conversation
  const handleNewConversation = async () => {
    try {
      const title = prompt('Enter a title for the new conversation:') || 'New Conversation';
      const topic = prompt('Enter a topic for the conversation:') || 'General';

      const newConversation = await chatApi.createConversation(title, topic);
      setConversations((prev) => [newConversation, ...prev]);
      setSelectedConversationId(newConversation.id);
    } catch (error) {
      console.error('Failed to create conversation:', error);
    }
  };

  // Handle deleting a conversation
  const handleDeleteConversation = async (id: string) => {
    if (!confirm('Are you sure you want to delete this conversation?')) {
      return;
    }

    try {
      await chatApi.deleteConversation(id);
      setConversations((prev) => prev.filter((conv) => conv.id !== id));

      if (selectedConversationId === id) {
        const nextConversation = conversations.find((conv) => conv.id !== id);
        setSelectedConversationId(nextConversation?.id || null);
      }
    } catch (error) {
      console.error('Failed to delete conversation:', error);
    }
  };

  // Handle sending a new message
  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedConversationId) {
      return;
    }

    try {
      // Add user message
      const userMessage = await chatApi.addMessage(selectedConversationId, newMessage, 'user');

      if (userMessage && currentConversation) {
        // Update the current conversation with the new message
        setCurrentConversation({
          ...currentConversation,
          messages: [...currentConversation.messages, userMessage],
        });
      }

      setNewMessage('');

      // Simulate assistant response after a short delay
      setTimeout(async () => {
        const assistantMessage = await chatApi.addMessage(
          selectedConversationId!,
          'This is a simulated response from the assistant. In a real application, this would come from an AI service.',
          'assistant',
        );

        if (assistantMessage && currentConversation) {
          // Update the current conversation with the assistant's response
          setCurrentConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: [...prev.messages, assistantMessage],
                }
              : null,
          );
        }
      }, 1000);
    } catch (error) {
      console.error('Failed to send message:', error);
    }
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
              <Breadcrumb.Page>Chat</Breadcrumb.Page>
            </Breadcrumb.Item>
            {currentConversation?.title && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{currentConversation.title}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Portal.Slot id="tertiary-navigation">
        <ChatSidebar
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          onSelectConversation={setSelectedConversationId}
          onNewConversation={handleNewConversation}
          onDeleteConversation={handleDeleteConversation}
        />
      </Portal.Slot>

      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <span>Loading conversations...</span>
          </div>
        ) : currentConversation ? (
          <>
            <div className="flex-1 overflow-y-auto py-4">
              {currentConversation.messages.map((message) => (
                <div
                  key={message.id}
                  className={`mb-4 p-3 rounded-lg max-w-[80%] ${
                    message.sender === 'user'
                      ? 'ml-auto bg-primary text-primary-foreground'
                      : 'mr-auto bg-muted'
                  }`}
                >
                  <p>{message.content}</p>
                  <div className="text-xs opacity-70 mt-1 text-right">
                    {new Date(message.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t pt-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  placeholder="Type your message..."
                  className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background"
                />
                <button
                  onClick={handleSendMessage}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2"
                >
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="min-h-[50vh] flex-1 rounded-xl bg-muted/50 flex items-center justify-center md:min-h-min">
            <span className="text-xl font-medium">Select a conversation or create a new one</span>
          </div>
        )}
      </div>
    </>
  );
}

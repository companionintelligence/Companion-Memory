import type { Thread } from '@ci/domains/conversations';
import type { User } from '@ci/domains/user';

export interface Action {
  id: string;

  title: string | null;
  text: string | null;
  imageUrl: string | null;

  threadId: string | null;

  thread?: Thread;
  user?: User;
  tags?: string[];
}

export interface Answer {
  id: string;

  ragAnswer: string;
  answer: string;

  user?: User;
  question?: Question;
}

export interface Question {
  id: string;

  category: string;
  text: string;
  answer: string;

  user?: User;
}

export interface UpdateAnswerDto {
  rag_answer_1?: string;
}

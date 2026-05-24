import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { ConnectionService } from '@ci/domains/connections';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import {
  ConceptService,
  ContentService,
  EventService,
  ItemService,
  PersonService,
  PlaceService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { TagService } from '@ci/domains/search-next';
import { UserService } from '@ci/domains/user';

import { ActionType } from '../types/ActionType';
import { AnswerType } from '../types/AnswerType';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { ConceptType } from '../types/ConceptType';
import { ConnectionType } from '../types/ConnectionType';
import { ContentType } from '../types/ContentType';
import { EventType } from '../types/EventType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemType } from '../types/ItemType';
import { MessageType } from '../types/MessageType';
import { Node } from '../types/Node';
import { NoteType } from '../types/NoteType';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { QuestionType } from '../types/QuestionType';
import { TagType } from '../types/TagType';
import { ThreadType } from '../types/ThreadType';
import { UserType } from '../types/UserType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => Node)
export class NodeResolver {
  constructor(
    private readonly actionService: ActionService,
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly conceptService: ConceptService,
    private readonly connectionService: ConnectionService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    private readonly messageService: MessageService,
    private readonly noteService: NoteService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly questionService: QuestionService,
    private readonly tagService: TagService,
    private readonly threadService: ThreadService,
    private readonly userService: UserService,
  ) {}

  @Query(() => Node, { nullable: true })
  async node(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<Node | null> {
    const serviceContext = toServiceContext(context);
    const { type, id } = GlobalUID.decode(gid);

    switch (type) {
      case 'action': {
        const action = await this.actionService.findById(serviceContext, id);

        return action ? ActionType.toType(action) : null;
      }

      case 'answer': {
        const answer = await this.answerService.findById(serviceContext, id);

        return answer ? AnswerType.toType(answer) : null;
      }

      case 'browser-activity': {
        const activity = await this.browserActivityService.findById(serviceContext, id);

        return activity ? BrowserActivityType.toType(activity) : null;
      }

      case 'concept': {
        const concept = await this.conceptService.findById(serviceContext, id);

        return concept ? ConceptType.toType(concept) : null;
      }

      case 'connection': {
        const connection = await this.connectionService.findById(serviceContext, id);

        return connection ? ConnectionType.toType(connection) : null;
      }

      case 'content': {
        const content = await this.contentService.findById(serviceContext, id);

        return content ? ContentType.toType(content) : null;
      }

      case 'event': {
        const event = await this.eventService.findById(serviceContext, id);

        return event ? EventType.toType(event) : null;
      }

      case 'file': {
        const file = await this.fileService.findById(serviceContext, id);

        return file ? FileType.toType(file) : null;
      }

      case 'item': {
        const item = await this.itemService.findById(serviceContext, id);

        return item ? ItemType.toType(item) : null;
      }

      case 'message': {
        const message = await this.messageService.findById(serviceContext, id);

        return message ? MessageType.toType(message) : null;
      }

      case 'note': {
        const note = await this.noteService.findById(serviceContext, id);

        return note ? NoteType.toType(note) : null;
      }

      case 'person': {
        const person = await this.personService.findById(serviceContext, id);

        return person ? PersonType.toType(person) : null;
      }

      case 'place': {
        const place = await this.placeService.findById(serviceContext, id);

        return place ? PlaceType.toType(place) : null;
      }

      case 'question': {
        const question = await this.questionService.findById(serviceContext, id);

        return question ? QuestionType.toType(question) : null;
      }

      case 'tag': {
        const tag = await this.tagService.findById(serviceContext, id);

        return tag ? TagType.toType(tag) : null;
      }

      case 'thread': {
        const thread = await this.threadService.findById(serviceContext, id);

        return thread ? ThreadType.toType(thread) : null;
      }

      case 'user': {
        const user = await this.userService.findById(serviceContext, id);

        return user ? UserType.toType(user) : null;
      }

      default:
        return null;
    }
  }
}

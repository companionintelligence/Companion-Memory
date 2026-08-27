import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { BrowserActivityService } from '@ci/domains/browser-activity';
import { ConnectionService } from '@ci/domains/connections';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { ActionService, AnswerService, QuestionService } from '@ci/domains/intelligence';
import {
  CommunicationService,
  ConceptService,
  ContentService,
  EventService,
  GraphUtilityService,
  ItemService,
  ObjectObservationService,
  PersonService,
  PlaceService,
  ProductModelService,
  ReceiptService,
} from '@ci/domains/memory';
import { NoteService } from '@ci/domains/notes';
import { FileChunkService } from '@ci/domains/parsing';
import { TaskService } from '@ci/domains/planning';
import { TagService } from '@ci/domains/search-next';
import { UserService } from '@ci/domains/user';

import { ActionType } from '../types/ActionType';
import { AnswerType } from '../types/AnswerType';
import { BrowserActivityType } from '../types/BrowserActivityType';
import { CommunicationType } from '../types/CommunicationType';
import { ConceptType } from '../types/ConceptType';
import { ConnectionType } from '../types/ConnectionType';
import { ContentType } from '../types/ContentType';
import { EventType } from '../types/EventType';
import { FileChunkType } from '../types/FileChunkType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemType } from '../types/ItemType';
import { MessageType } from '../types/MessageType';
import { Node } from '../types/Node';
import { NoteType } from '../types/NoteType';
import { ObjectObservationType } from '../types/ObjectObservationType';
import { PersonType } from '../types/PersonType';
import { PlaceType } from '../types/PlaceType';
import { ProductModelType } from '../types/ProductModelType';
import { QuestionType } from '../types/QuestionType';
import { ReceiptType } from '../types/ReceiptType';
import { TagType } from '../types/TagType';
import { TaskType } from '../types/TaskType';
import { ThreadType } from '../types/ThreadType';
import { UserType } from '../types/UserType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => Node)
export class NodeResolver {
  constructor(
    private readonly actionService: ActionService,
    private readonly answerService: AnswerService,
    private readonly browserActivityService: BrowserActivityService,
    private readonly communicationService: CommunicationService,
    private readonly conceptService: ConceptService,
    private readonly connectionService: ConnectionService,
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly fileChunkService: FileChunkService,
    private readonly fileService: FileService,
    private readonly graphUtilityService: GraphUtilityService,
    private readonly itemService: ItemService,
    private readonly messageService: MessageService,
    private readonly noteService: NoteService,
    private readonly objectObservationService: ObjectObservationService,
    private readonly personService: PersonService,
    private readonly placeService: PlaceService,
    private readonly productModelService: ProductModelService,
    private readonly questionService: QuestionService,
    private readonly receiptService: ReceiptService,
    private readonly tagService: TagService,
    private readonly taskService: TaskService,
    private readonly threadService: ThreadService,
    private readonly userService: UserService,
    private readonly featureService: FeatureService,
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

      case 'communication': {
        const communication = await this.communicationService.findById(serviceContext, id);

        return communication ? CommunicationType.toType(communication) : null;
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

      case 'file-chunk': {
        const chunk = await this.fileChunkService.findByIds([id]).then((results) => results[0] ?? null);

        if (chunk == null) {
          return null;
        }

        const file = await this.fileService.findById(serviceContext, chunk.fileId);

        return FileChunkType.toType(chunk, file);
      }

      case 'file': {
        // Two ids name a file. `ci.files.id` is what the file surfaces use;
        // the GRAPH knows the file by its `ci.entities.entity_id`, which for
        // files — alone among the memory types — is a different value, joined
        // through `linked_table = 'files' / linked_id`. A relationship card
        // (an ATTACHED_TO edge from a post to its video, say) carries the graph
        // id, so a drawer opened from it asked `node(file:<entity_id>)`, found
        // nothing, and showed the bare stub. Try the file id first, then the
        // graph id.
        const file =
          (await this.fileService.findById(serviceContext, id)) ??
          (await this.findFileByGraphEntityId(serviceContext, id));

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

      case 'task': {
        if (!(await this.featureService.isFeatureEnabled('planning.enabled'))) {
          return null;
        }

        const task = await this.taskService.findById(serviceContext, id);

        return task ? TaskType.toType(task) : null;
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

      case 'product': {
        const product = await this.productModelService.findById(serviceContext, id);

        return product ? ProductModelType.toType(product) : null;
      }

      case 'receipt': {
        const receipt = await this.receiptService.findById(serviceContext, id);

        return receipt ? ReceiptType.toType(receipt) : null;
      }

      case 'observation': {
        const observation = await this.objectObservationService.findById(serviceContext, id);

        return observation ? ObjectObservationType.toType(observation) : null;
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

  /**
   * The `ci.files` row behind a File GRAPH node, or null.
   *
   * Only files carry two ids (see the `file` case above). The graph row is
   * scoped to its owner, so a user-scoped context is required; the system
   * context has no owner to look under and gets null, the same answer an
   * unknown id gets.
   */
  private async findFileByGraphEntityId(
    serviceContext: ReturnType<typeof toServiceContext>,
    entityId: string,
  ) {
    if (typeof serviceContext.userId !== 'string') {
      return null;
    }

    const [node] = await this.graphUtilityService.getNodesByIds([entityId], serviceContext.userId);

    if (node?.linked_table !== 'files' || node.linked_id == null) {
      return null;
    }

    return this.fileService.findById(serviceContext, node.linked_id);
  }
}

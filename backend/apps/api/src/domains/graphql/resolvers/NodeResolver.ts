import { UseGuards } from '@nestjs/common';
import { Query, Resolver, Args, ID } from '@nestjs/graphql';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { RequestContext } from '@ci/common/types';
import { toServiceContext } from '@ci/common/utils';
import { MessageService, ThreadService } from '@ci/domains/conversations';
import { FileService } from '@ci/domains/files';
import { ItemService, PersonService } from '@ci/domains/memory';
import { TagService } from '@ci/domains/search-next';
import { UserService } from '@ci/domains/user';

import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemType } from '../types/ItemType';
import { MessageType } from '../types/MessageType';
import { Node } from '../types/Node';
import { PersonType } from '../types/PersonType';
import { TagType } from '../types/TagType';
import { ThreadType } from '../types/ThreadType';
import { UserType } from '../types/UserType';

@UseGuards(JwtAuthGuard)
@Resolver(() => Node)
export class NodeResolver {
  constructor(
    private readonly fileService: FileService,
    private readonly itemService: ItemService,
    private readonly messageService: MessageService,
    private readonly personService: PersonService,
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

      case 'person': {
        const person = await this.personService.findById(serviceContext, id);

        return person ? PersonType.toType(person) : null;
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

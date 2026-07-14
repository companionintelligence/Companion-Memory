import { UseGuards } from '@nestjs/common';
import { ID, Args, Mutation, Parent, Query, Resolver, ResolveField } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import { NoteService } from '@ci/domains/notes';

import { TagLoader } from '../loaders/TagLoader';
import { CreateNoteInput } from '../types/CreateNoteInput';
import { CreateNotePayload } from '../types/CreateNotePayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { NoteConnection } from '../types/NoteConnection';
import { NoteEdge } from '../types/NoteEdge';
import { NoteType } from '../types/NoteType';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateNoteInput } from '../types/UpdateNoteInput';
import { UpdateNotePayload } from '../types/UpdateNotePayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => NoteType)
export class NoteResolver {
  constructor(
    private readonly noteService: NoteService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Mutation(() => CreateNotePayload)
  async createNote(
    @Context() context: RequestContext,
    @Args('input') input: CreateNoteInput,
  ): Promise<CreateNotePayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.noteService.create(serviceContext, {
      title: input.title,
      content: input.content,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      note: entity ? NoteType.toType(entity) : undefined,
    };
  }

  @Mutation(() => [NoteType])
  async createNotes(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateNoteInput] }, new MaxArraySizePipe())
    input: CreateNoteInput[],
  ): Promise<NoteType[]> {
    const serviceContext = toServiceContext(context);

    const notes = await this.noteService.createMany(
      serviceContext,
      input.map((item) => ({
        title: item.title,
        content: item.content,
      })),
    );

    return notes.map((note) => NoteType.toType(note));
  }

  @Mutation(() => UpdateNotePayload)
  async updateNote(
    @Context() context: RequestContext,
    @Args('input') input: UpdateNoteInput,
  ): Promise<UpdateNotePayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('note', input.id);

    const entity = await this.noteService.update(serviceContext, id, {
      title: input.title,
      content: input.content,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      note: entity ? NoteType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteNote(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('note', input.id);

    const success = await this.noteService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  @Query(() => NoteConnection)
  async notes(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<NoteConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.noteService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('note', entity.id),
    });

    const edges: NoteEdge[] = slice.map((entity) => {
      const node = NoteType.toType(entity);

      return {
        node,
        cursor: node.id,
      };
    });

    return {
      edges,
      pageInfo,
      totalCount,
    };
  }

  @Query(() => NoteType, { nullable: true })
  async note(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<NoteType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('note', gid);

    const entity = await this.noteService.findById(serviceContext, id);

    return entity ? NoteType.toType(entity) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: NoteType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'note',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

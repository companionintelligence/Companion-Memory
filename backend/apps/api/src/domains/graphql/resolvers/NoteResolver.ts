import { UseGuards } from '@nestjs/common';
import { ID, Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { NoteService } from '@ci/domains/notes';

import { CreateNoteInput } from '../types/CreateNoteInput';
import { CreateNotePayload } from '../types/CreateNotePayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { GlobalUID } from '../types/GlobalUID';
import { NoteConnection } from '../types/NoteConnection';
import { NoteEdge } from '../types/NoteEdge';
import { NoteType } from '../types/NoteType';
import { PaginationArgs } from '../types/PaginationArgs';
import { UpdateNoteInput } from '../types/UpdateNoteInput';
import { UpdateNotePayload } from '../types/UpdateNotePayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtAuthGuard)
@Resolver(() => NoteType)
export class NoteResolver {
  constructor(private readonly noteService: NoteService) {}

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
}

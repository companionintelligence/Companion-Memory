import { UseGuards } from '@nestjs/common';
import { Mutation, Parent, Query, ResolveField, Resolver, Args, ID } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { CreatePersonPayload } from '@ci/domains/graphql/types/CreatePersonPayload';
import { DeleteByIdInput } from '@ci/domains/graphql/types/DeleteByIdInput';
import { DeleteByIdPayload } from '@ci/domains/graphql/types/DeleteByIdPayload';
import { PersonService } from '@ci/domains/memory';

import { TagLoader } from '../loaders/TagLoader';
import { CreatePersonInput } from '../types/CreatePersonInput';
import { EntityTagType } from '../types/EntityTagType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { PersonConnection } from '../types/PersonConnection';
import { PersonEdge } from '../types/PersonEdge';
import { PersonType } from '../types/PersonType';
import { UpdatePersonInput } from '../types/UpdatePersonInput';
import { UpdatePersonPayload } from '../types/UpdatePersonPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => PersonType)
export class PersonResolver {
  constructor(
    private readonly personService: PersonService,
    private readonly tagLoader: TagLoader,
  ) {}

  @Mutation(() => CreatePersonPayload)
  async createPerson(
    @Context() context: RequestContext,
    @Args('input') input: CreatePersonInput,
  ): Promise<CreatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.personService.create(serviceContext, {
      name: input.name,
      description: input.description,
      linkedTable: input.linkedTable,
      linkedId: input.linkedId,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      person: entity ? PersonType.toType(entity) : undefined,
    };
  }

  /**
   * Batch create people in one round-trip. Each input resolves-or-creates on the
   * (linkedTable, linkedId) provenance key, so a re-sync returns the existing
   * person instead of duplicating it. Returns the created-or-existing people in
   * input order — the clean batch equivalent of N createPerson mutations.
   */
  @Mutation(() => [PersonType])
  async createPeople(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreatePersonInput] }) input: CreatePersonInput[],
  ): Promise<PersonType[]> {
    const serviceContext = toServiceContext(context);

    const people = await this.personService.createMany(
      serviceContext,
      input.map((item) => ({
        name: item.name,
        description: item.description,
        linkedTable: item.linkedTable,
        linkedId: item.linkedId,
      })),
    );

    return people.map((person) => PersonType.toType(person));
  }

  @Mutation(() => UpdatePersonPayload)
  async updatePerson(
    @Context() context: RequestContext,
    @Args('input') input: UpdatePersonInput,
  ): Promise<UpdatePersonPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', input.id);

    const entity = await this.personService.update(serviceContext, id, {
      name: input.name,
      description: input.description,
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      person: entity ? PersonType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deletePerson(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('note', input.id);

    const success = await this.personService.remove(serviceContext, id);

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

  @Query(() => PersonConnection)
  async people(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
  ): Promise<PersonConnection> {
    const serviceContext = toServiceContext(context);

    const entities = await this.personService.findAll(serviceContext);

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('person', entity.id),
    });

    const edges: PersonEdge[] = slice.map((entity) => {
      const node = PersonType.toType(entity);

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

  @Query(() => PersonType, { nullable: true })
  async person(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<PersonType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('person', gid);

    const entity = await this.personService.findById(serviceContext, id);

    return entity ? PersonType.toType(entity) : null;
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: PersonType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'person',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

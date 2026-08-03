import { ObjectType } from '@nestjs/graphql';

import { MutationPayload } from './MutationPayload';

@ObjectType()
export class RejectPersonDuplicateSuggestionPayload extends MutationPayload {}

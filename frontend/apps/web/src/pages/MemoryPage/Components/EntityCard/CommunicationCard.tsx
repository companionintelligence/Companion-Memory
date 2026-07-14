import { useMemo } from 'react';

import { Card, Tooltip, cn } from '@ci/shadcn';
import { Clock, User, Mail, Send, Inbox } from '@ci/shadcn/icons';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';

import { gql, useFragment, type FragmentType } from '@/graphql';

import { useEntityService } from '../../useEntityService';

const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

interface Props {
  entity: FragmentType<typeof COMMUNICATION_FRAGMENT>;
}

export const COMMUNICATION_FRAGMENT = gql(`
  fragment TimelineCommunicationCardData on CommunicationType {
    id
    subject
    preview
    communicationContent: content
    time
    type
    direction
    from {
      id
      name
    }
    to {
      edges {
        node {
          id
          name
        }
      }
    }
    tags {
      label
    }
  }
`);

export function CommunicationCard({ entity }: Props) {
  const [, { setActiveEntity }] = useEntityService();
  const data = useFragment(COMMUNICATION_FRAGMENT, entity);
  const communicationType = data.type as string | undefined;
  const direction = data.direction as string | undefined;

  const participantInfo = useMemo(() => {
    if (!data.to && !data.from) {
      return null;
    }

    if (direction === 'received' || direction === 'inbound') {
      const fromPerson = data.from;
      const name = fromPerson?.name;
      if (name) {
        return { label: 'From', value: name };
      }
    }

    if (direction === 'sent' || direction === 'outbound') {
      const toParticipants = data.to.edges;
      if (Array.isArray(toParticipants) && toParticipants.length > 0) {
        const names = toParticipants.map((p) => p.node.name).filter(Boolean);
        if (names.length > 0) {
          const displayValue =
            names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', ');

          return { label: 'To', value: displayValue };
        }
      }
    }

    return null;
  }, [data, direction]);

  const getDirectionIcon = () => {
    if (direction === 'sent' || direction === 'outbound') {
      return <Send className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />;
    } else if (direction === 'received' || direction === 'inbound') {
      return <Inbox className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--accent)]" />;
    }

    return <Mail className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--accent-foreground)]" />;
  };

  return (
    <Card
      className="!gap-2 !px-6 !py-4 cursor-pointer transition-shadow duration-200 hover:shadow-lg"
      onClick={() => setActiveEntity({ ...data, __typename: 'CommunicationType', bucketTime: data.time })}
    >
      <div className="flex items-start gap-3">
        {getDirectionIcon()}
        <div className="flex-1 min-w-0">
          {/* Chat-style sources have no subject — render no subject line at all
              (the message body below is the card's text) instead of a
              "<Type> Communication" placeholder. */}
          {data.subject && (
            <Tooltip>
              <Tooltip.Trigger asChild>
                <h3 className="truncate text-lg font-semibold leading-4 text-card-foreground cursor-default">
                  {data.subject}
                </h3>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>{data.subject}</p>
              </Tooltip.Content>
            </Tooltip>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {communicationType && (
              <>
                <span className="text-sm text-muted-foreground capitalize">{communicationType}</span>
              </>
            )}
            {direction && (
              <>
                <span className="text-muted-foreground">•</span>
                <span
                  className={cn(
                    'text-sm font-medium',
                    direction === 'sent' || direction === 'outbound'
                      ? 'text-[var(--primary)]'
                      : 'text-[var(--accent)]',
                  )}
                >
                  {direction === 'sent' || direction === 'outbound' ? 'Sent' : 'Received'}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {participantInfo && (
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">{participantInfo.label}:</span>
            <span className="ml-2 text-sm text-card-foreground">{participantInfo.value}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm text-card-foreground">
          {new Date(data.time).toLocaleString('en-US', DATE_FORMAT_OPTIONS)}
        </span>
      </div>

      {data.communicationContent &&
        parse(
          DOMPurify.sanitize(
            data.communicationContent.length > 1000
              ? `${data.communicationContent.substring(0, 1000)}...`
              : data.communicationContent,
            { USE_PROFILES: { html: true } },
          ),
        )}

      {/*{data.tags.length > 0 && (*/}
      {/*  <div className="flex flex-wrap gap-2 pt-2">*/}
      {/*    {data.tags.map((tag, index) => (*/}
      {/*      <Tag key={index} text={tag} />*/}
      {/*    ))}*/}
      {/*  </div>*/}
      {/*)}*/}
    </Card>
  );
}

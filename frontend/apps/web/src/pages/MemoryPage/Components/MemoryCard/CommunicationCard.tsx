import { Card, Tooltip, cn } from '@ci/shadcn';
import { Clock, User, Mail, Send, Inbox } from '@ci/shadcn/icons';

import type { MemoryItem, ParticipantData } from '../../types';
import { useMemoryService } from '../../useMemoryService';

const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

interface Props {
  memory: MemoryItem;
}

export function CommunicationCard({ memory }: Props) {
  const { setActiveMemory } = useMemoryService();
  const communicationType = memory.metadata?.communicationType as string | undefined;
  const direction = memory.metadata?.direction as string | undefined;
  const participantsMetadata = memory.metadata?.participantsMetadata as
    | Record<string, ParticipantData[]>
    | undefined;

  const getParticipantInfo = () => {
    if (!participantsMetadata) {
      return null;
    }

    if (direction === 'received' || direction === 'inbound') {
      const fromParticipants = participantsMetadata.from || participantsMetadata.sender;
      if (Array.isArray(fromParticipants) && fromParticipants.length > 0) {
        const fromPerson = fromParticipants[0];
        const name = fromPerson.name || fromPerson.email;
        if (name) {
          return { label: 'From', value: name };
        }
      }
    }

    if (direction === 'sent' || direction === 'outbound') {
      const toParticipants = participantsMetadata.to || participantsMetadata.recipients;
      if (Array.isArray(toParticipants) && toParticipants.length > 0) {
        const names = toParticipants.map((p: ParticipantData) => p.name || p.email).filter(Boolean);
        if (names.length > 0) {
          const displayValue =
            names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2} more` : names.join(', ');

          return { label: 'To', value: displayValue };
        }
      }
    }

    return null;
  };

  const participantInfo = getParticipantInfo();

  const getDirectionIcon = () => {
    if (direction === 'sent' || direction === 'outbound') {
      return <Send className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--primary)]" />;
    } else if (direction === 'received' || direction === 'inbound') {
      return <Inbox className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--accent)]" />;
    }

    return <Mail className="h-6 w-6 flex-shrink-0 mt-1 text-[var(--accent-foreground)]" />;
  };

  const handleClick = () => {
    setActiveMemory(memory);
  };

  return (
    <Card
      className="!gap-2 !py-4 px-6 cursor-pointer hover:shadow-lg transition-shadow duration-200"
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        {getDirectionIcon()}
        <div className="flex-1 min-w-0">
          <Tooltip>
            <Tooltip.Trigger asChild>
              <h3 className="text-lg font-semibold text-card-foreground truncate cursor-default">
                {memory.title}
              </h3>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>{memory.title}</p>
            </Tooltip.Content>
          </Tooltip>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm text-muted-foreground">{memory.category}</p>
            {communicationType && (
              <>
                <span className="text-muted-foreground">•</span>
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
        <div className="flex items-center gap-5">
          <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-muted-foreground">{participantInfo.label}:</span>
            <span className="ml-2 text-sm text-card-foreground">{participantInfo.value}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-5">
        <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm text-card-foreground">
          {new Date(memory.timestamp).toLocaleString('en-US', DATE_FORMAT_OPTIONS)}
        </span>
      </div>

      {memory.description && (
        <div className="pt-3 pb-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {memory.description.length > 1000
              ? `${memory.description.substring(0, 1000)}...`
              : memory.description}
          </p>
        </div>
      )}

      {memory.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {memory.tags.map((tag, index) => (
            <span key={index} className="px-2 py-1 bg-muted text-muted-foreground text-xs rounded-full">
              {tag}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

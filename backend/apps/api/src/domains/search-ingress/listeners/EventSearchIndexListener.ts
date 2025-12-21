import { Injectable } from '@nestjs/common';

@Injectable()
export class EventSearchIndexListener {
  constructor() {}

  private getSearchContent(): string[] {
    return [];
  }

  private getSearchDocument(): string | null {
    // const parts = new Set<string>();
    // const push = (value: unknown) => {
    //   if (typeof value !== 'string') {
    //     return;
    //   }

    //   const normalized = value.trim();
    //   if (normalized.length === 0) {
    //     return;
    //   }

    //   parts.add(normalized);
    // };

    // push(newEvent.title);
    // push(fileDetails.content?.name);
    // push(fileDetails.content?.file?.mimeType);

    // for (const participant of fileDetails.participants) {
    //   push(participant.name);
    //   push(participant.email);
    // }

    // if (parts.size === 0) {
    //   return null;
    // }

    // return Array.from(parts).join(' ');

    // const parts = new Set<string>();
    // const push = (value: unknown) => {
    //   if (typeof value !== 'string') {
    //     return;
    //   }

    //   const normalized = value.trim();
    //   if (normalized.length === 0) {
    //     return;
    //   }

    //   parts.add(normalized);
    // };

    // push(eventDetails.subject);
    // push(eventDetails.bodyPreview);
    // push(eventDetails.body);
    // push(eventDetails.location?.displayName);

    // push(newEvent.category);
    // push(newEvent.event_type);

    // for (const participant of eventDetails.participants) {
    //   push(participant.name);
    //   push(participant.email);
    // }

    // push(eventDetails.organizer.name);
    // push(eventDetails.organizer.email);

    // if (parts.size === 0) {
    //   return null;
    // }

    // return Array.from(parts).join(' ');

    return null;
  }
}

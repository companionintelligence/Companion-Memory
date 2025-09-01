import { Injectable } from '@nestjs/common';
import dlv from 'dlv';

import { LoggerService } from '@ci/common/services';

import type { EtlTransformMap, EtlTransformation } from '../types';

@Injectable()
export class EtlTransformService {
  private logger = new LoggerService(EtlTransformService.name);
  private transformMaps = new Map<string, EtlTransformMap>();

  constructor() {
    // Load default transform maps for Google and Microsoft
    this.loadDefaultTransformMaps();
  }

  private loadDefaultTransformMaps(): void {
    // Google Calendar Events Transform Map
    const googleCalendarMap: EtlTransformMap = {
      id: 'google.calendar.events.standard',
      name: 'Google Calendar Events to Standard Format',
      sourceEndpoint: 'google.calendar.events.list',
      targetSchema: 'calendar_event',
      transformations: [
        { type: 'map', sourcePath: 'items.id', targetPath: 'id' },
        { type: 'map', sourcePath: 'items.summary', targetPath: 'title' },
        { type: 'map', sourcePath: 'items.description', targetPath: 'description' },
        { type: 'map', sourcePath: 'items.start.dateTime', targetPath: 'startTime' },
        { type: 'map', sourcePath: 'items.end.dateTime', targetPath: 'endTime' },
        { type: 'map', sourcePath: 'items.location', targetPath: 'location' },
        { type: 'transform', sourcePath: 'items.attendees', targetPath: 'participants', operation: 'extractEmails' },
      ],
    };

    // Gmail Messages Transform Map
    const gmailMessagesMap: EtlTransformMap = {
      id: 'google.gmail.messages.standard',
      name: 'Gmail Messages to Standard Format',
      sourceEndpoint: 'google.gmail.messages.list',
      targetSchema: 'email_message',
      transformations: [
        { type: 'map', sourcePath: 'messages.id', targetPath: 'id' },
        { type: 'map', sourcePath: 'messages.threadId', targetPath: 'threadId' },
        { type: 'map', sourcePath: 'messages.payload.headers', targetPath: 'headers', operation: 'headerToObject' },
        { type: 'transform', sourcePath: 'messages.payload.headers', targetPath: 'subject', operation: 'extractHeader', params: { headerName: 'Subject' } },
        { type: 'transform', sourcePath: 'messages.payload.headers', targetPath: 'from', operation: 'extractHeader', params: { headerName: 'From' } },
        { type: 'transform', sourcePath: 'messages.payload.headers', targetPath: 'to', operation: 'extractHeader', params: { headerName: 'To' } },
        { type: 'map', sourcePath: 'messages.payload.body.data', targetPath: 'body', operation: 'base64Decode' },
      ],
    };

    // Microsoft Calendar Events Transform Map
    const microsoftCalendarMap: EtlTransformMap = {
      id: 'microsoft.calendar.events.standard',
      name: 'Microsoft Calendar Events to Standard Format',
      sourceEndpoint: 'microsoft.calendar.events.list',
      targetSchema: 'calendar_event',
      transformations: [
        { type: 'map', sourcePath: 'value.id', targetPath: 'id' },
        { type: 'map', sourcePath: 'value.subject', targetPath: 'title' },
        { type: 'map', sourcePath: 'value.body.content', targetPath: 'description' },
        { type: 'map', sourcePath: 'value.start.dateTime', targetPath: 'startTime' },
        { type: 'map', sourcePath: 'value.end.dateTime', targetPath: 'endTime' },
        { type: 'map', sourcePath: 'value.location.displayName', targetPath: 'location' },
        { type: 'transform', sourcePath: 'value.attendees', targetPath: 'participants', operation: 'extractEmails' },
      ],
    };

    this.transformMaps.set(googleCalendarMap.id, googleCalendarMap);
    this.transformMaps.set(gmailMessagesMap.id, gmailMessagesMap);
    this.transformMaps.set(microsoftCalendarMap.id, microsoftCalendarMap);
  }

  getTransformMap(id: string): EtlTransformMap | undefined {
    return this.transformMaps.get(id);
  }

  addTransformMap(map: EtlTransformMap): void {
    this.transformMaps.set(map.id, map);
  }

  async transform(sourceData: unknown, transformMapId: string): Promise<unknown> {
    const transformMap = this.transformMaps.get(transformMapId);
    if (!transformMap) {
      throw new Error(`Transform map not found: ${transformMapId}`);
    }

    this.logger.log(`Transforming data using map: ${transformMap.name}`);

    try {
      const result = await this.applyTransformations(sourceData, transformMap.transformations);
      this.logger.log(`Successfully transformed data using map: ${transformMapId}`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to transform data using map: ${transformMapId}`, error as Error);
      throw error;
    }
  }

  private async applyTransformations(data: unknown, transformations: EtlTransformation[]): Promise<unknown> {
    let result = data;

    for (const transformation of transformations) {
      result = await this.applyTransformation(result, transformation);
    }

    return result;
  }

  private async applyTransformation(data: unknown, transformation: EtlTransformation): Promise<unknown> {
    const { type, sourcePath, targetPath, operation, params } = transformation;

    switch (type) {
      case 'map':
        return this.mapValue(data, sourcePath, targetPath, operation);
      
      case 'transform':
        return this.transformValue(data, sourcePath, targetPath, operation, params);
      
      case 'filter':
        return this.filterValue(data, sourcePath, operation, params);
      
      case 'aggregate':
        return this.aggregateValue(data, sourcePath, targetPath, operation, params);
      
      default:
        this.logger.warn(`Unknown transformation type: ${type}`);
        return data;
    }
  }

  private mapValue(data: unknown, sourcePath: string, targetPath: string, operation?: string): unknown {
    const sourceValue = dlv(data as Record<string, unknown>, sourcePath);
    
    if (sourceValue === undefined) {
      return data;
    }

    let transformedValue = sourceValue;
    
    if (operation === 'base64Decode' && typeof sourceValue === 'string') {
      transformedValue = Buffer.from(sourceValue, 'base64').toString('utf-8');
    }

    return this.setNestedValue(data, targetPath, transformedValue);
  }

  private transformValue(
    data: unknown, 
    sourcePath: string, 
    targetPath: string, 
    operation?: string, 
    params?: Record<string, unknown>
  ): unknown {
    const sourceValue = dlv(data as Record<string, unknown>, sourcePath);
    let transformedValue = sourceValue;

    switch (operation) {
      case 'extractEmails':
        if (Array.isArray(sourceValue)) {
          transformedValue = sourceValue.map((item: any) => item?.email).filter(Boolean);
        }
        break;
      
      case 'extractHeader':
        if (Array.isArray(sourceValue) && params?.headerName) {
          const header = sourceValue.find((h: any) => h.name === params.headerName);
          transformedValue = header?.value;
        }
        break;
      
      case 'headerToObject':
        if (Array.isArray(sourceValue)) {
          transformedValue = sourceValue.reduce((acc: Record<string, string>, header: any) => {
            if (header.name && header.value) {
              acc[header.name] = header.value;
            }
            return acc;
          }, {});
        }
        break;
    }

    return this.setNestedValue(data, targetPath, transformedValue);
  }

  private filterValue(data: unknown, sourcePath: string, operation?: string, params?: Record<string, unknown>): unknown {
    const sourceValue = dlv(data as Record<string, unknown>, sourcePath);
    
    if (!Array.isArray(sourceValue)) {
      return data;
    }

    let filteredValue = sourceValue;

    if (operation === 'notEmpty') {
      filteredValue = sourceValue.filter(item => item != null && item !== '');
    } else if (operation === 'dateRange' && params?.startDate && params?.endDate) {
      const start = new Date(params.startDate as string);
      const end = new Date(params.endDate as string);
      filteredValue = sourceValue.filter((item: any) => {
        const itemDate = new Date(item.date || item.createdTime || item.start?.dateTime);
        return itemDate >= start && itemDate <= end;
      });
    }

    return this.setNestedValue(data, sourcePath, filteredValue);
  }

  private aggregateValue(
    data: unknown, 
    sourcePath: string, 
    targetPath: string, 
    operation?: string, 
    params?: Record<string, unknown>
  ): unknown {
    const sourceValue = dlv(data as Record<string, unknown>, sourcePath);
    
    if (!Array.isArray(sourceValue)) {
      return data;
    }

    let aggregatedValue: unknown;

    switch (operation) {
      case 'count':
        aggregatedValue = sourceValue.length;
        break;
      
      case 'sum':
        if (params?.field) {
          aggregatedValue = sourceValue.reduce((sum, item) => sum + (dlv(item, params.field as string) || 0), 0);
        }
        break;
      
      case 'group':
        if (params?.field) {
          aggregatedValue = sourceValue.reduce((groups, item) => {
            const key = dlv(item, params.field as string);
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
            return groups;
          }, {} as Record<string, unknown[]>);
        }
        break;
    }

    return this.setNestedValue(data, targetPath, aggregatedValue);
  }

  private setNestedValue(obj: unknown, path: string, value: unknown): unknown {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    const pathParts = path.split('.');
    const result = Array.isArray(obj) ? [...obj] : { ...obj as Record<string, unknown> };
    let current: Record<string, unknown> = result as Record<string, unknown>;

    for (let i = 0; i < pathParts.length - 1; i++) {
      const key = pathParts[i];
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[pathParts[pathParts.length - 1]] = value;
    return result;
  }
}
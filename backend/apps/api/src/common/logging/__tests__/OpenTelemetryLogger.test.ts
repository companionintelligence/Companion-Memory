import { createOpenTelemetryLogRecord, normalizeOpenTelemetryLogsEndpoint } from '../OpenTelemetryLogger';

describe('OpenTelemetryLogger', () => {
  describe('normalizeOpenTelemetryLogsEndpoint', () => {
    it('prefers the per-signal logs endpoint when provided', () => {
      expect(
        normalizeOpenTelemetryLogsEndpoint({
          endpoint: 'https://logs.ci.computer',
          logsEndpoint: 'https://logs.ci.computer/custom/logs',
        }),
      ).toBe('https://logs.ci.computer/custom/logs');
    });

    it('appends the OTLP logs path to a generic OTLP endpoint', () => {
      expect(
        normalizeOpenTelemetryLogsEndpoint({
          endpoint: 'https://logs.ci.computer/',
        }),
      ).toBe('https://logs.ci.computer/v1/logs');
    });
  });

  describe('createOpenTelemetryLogRecord', () => {
    it('maps structured log data into OpenTelemetry-friendly attributes', () => {
      expect(
        createOpenTelemetryLogRecord('info', {
          msg: 'Request processed',
          obj: {
            context: 'request',
            traceId: 'trace-123',
            data: {
              duration: 12.5,
              success: true,
              nested: { foo: 'bar' },
            },
          },
        }),
      ).toEqual({
        severityNumber: 9,
        severityText: 'INFO',
        body: 'Request processed',
        attributes: {
          context: 'request',
          traceId: 'trace-123',
          'data.duration': 12.5,
          'data.success': true,
          'data.nested': '{"foo":"bar"}',
        },
      });
    });

    it('maps errors into exception attributes', () => {
      const error = new Error('boom');
      error.name = 'ExplodedError';
      error.stack = 'ExplodedError: boom';

      expect(
        createOpenTelemetryLogRecord('error', {
          msg: 'boom',
          obj: {
            err: error,
          },
        }),
      ).toEqual({
        severityNumber: 17,
        severityText: 'ERROR',
        body: 'boom',
        attributes: {
          'exception.type': 'ExplodedError',
          'exception.message': 'boom',
          'exception.stacktrace': 'ExplodedError: boom',
        },
      });
    });
  });
});

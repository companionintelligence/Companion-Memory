/**
 * The metadata key `@nestjs/schedule` writes a cron's options under. The package's
 * `schedule.constants` module is not reachable through its public entry in v12, so the key
 * is declared here with the value the library uses.
 */
export const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';
